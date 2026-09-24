// gsearch bridge — service worker.
//
// Dials OUT to the local-worker (ws://127.0.0.1:18787/ext), receives
// {type:'search', id, query, opts}, runs the search in one reused background
// tab of this real Chrome, scrapes the result page, and answers
// {type:'result', id, ok, data | error, code}.
//
// Keep-alive: Chrome 116+ keeps an MV3 service worker alive while its WebSocket
// is active, so we ping every 20s. If Chrome still kills the worker, a 30s alarm
// wakes it and reconnects.

const DEFAULT_PORT = 18787;
const PING_MS = 20_000;
const CAPTCHA_WAIT_MS = 180_000;
const TAB_IDLE_CLOSE_MS = 120_000;

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let state = { connected: false, lastQuery: null, lastError: null, count: 0 };
let searchTabId = null;
let idleCloseTimer = null;

// ------------------------------------------------------------ connection

async function port() {
  const { port } = await chrome.storage.local.get('port');
  return Number(port) || DEFAULT_PORT;
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  const url = 'ws://127.0.0.1:' + (await port()) + '/ext';
  try {
    ws = new WebSocket(url);
  } catch (err) {
    return scheduleReconnect();
  }
  ws.onopen = () => {
    setState({ connected: true, lastError: null });
    send({ type: 'hello', version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'search') handleSearch(msg);
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    setState({ connected: false });
    scheduleReconnect();
  };
  ws.onerror = () => {}; // onclose follows and handles it
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setState(patch) {
  state = { ...state, ...patch };
  chrome.action.setBadgeText({ text: state.connected ? '' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
}

// ---------------------------------------------------------------- search

// The server already sends one query at a time; this chain is a guard in case
// two ever arrive together, since they share one tab.
let chain = Promise.resolve();
function handleSearch(msg) {
  chain = chain.then(() => runSearch(msg)).catch(() => {});
}

async function runSearch({ id, query, opts = {} }) {
  setState({ lastQuery: query });
  try {
    const pages = Math.min(5, Math.max(1, opts.pages || 1));
    let merged = null;
    for (let page = 0; page < pages; page++) {
      if (page > 0) await sleep(1500 + Math.random() * 2000);
      const data = await searchPage(query, opts, page * 10);
      if (!merged) merged = data;
      else {
        const offset = merged.results.length;
        merged.results.push(...data.results.map((r, i) => ({ ...r, position: offset + i + 1 })));
      }
      if (data.results.length < 5) break; // no further pages worth loading
    }
    const seen = new Set();
    merged.results = merged.results.filter((r) => !seen.has(r.url) && seen.add(r.url));
    send({ type: 'result', id, ok: true, data: merged });
    setState({ count: state.count + 1, lastError: null });
  } catch (err) {
    send({ type: 'result', id, ok: false, error: err.message, code: err.code || 'extension_error' });
    setState({ lastError: err.message });
  } finally {
    armIdleClose();
  }
}

function buildUrl(query, opts, start) {
  const u = new URL('https://www.google.com/search');
  u.searchParams.set('q', query);
  if (opts.hl) u.searchParams.set('hl', opts.hl);
  if (opts.gl) u.searchParams.set('gl', opts.gl);
  if (opts.tbs) u.searchParams.set('tbs', opts.tbs);
  if (start) u.searchParams.set('start', String(start));
  return u.toString();
}

async function searchPage(query, opts, start) {
  const tabId = await getSearchTab();
  await navigate(tabId, buildUrl(query, opts, start));

  let tab = await chrome.tabs.get(tabId);
  let result = isBlocked(tab.url) ? { blocked: true } : await extract(tabId);

  if (result.blocked) {
    // Google shows the CAPTCHA either on /sorry/ or inline on /search itself.
    // Either way the human solves it: bring the tab forward and wait until the
    // results page is back.
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
    const deadline = Date.now() + (opts.captchaWaitMs || CAPTCHA_WAIT_MS);
    while (result.blocked && Date.now() < deadline) {
      await sleep(2000);
      tab = await chrome.tabs.get(tabId);
      if (tab.status !== 'complete' || isBlocked(tab.url)) continue;
      result = await extract(tabId).catch(() => ({ blocked: true }));
    }
    if (result.blocked) {
      throw Object.assign(new Error('Google CAPTCHA / consent page was not cleared in time'), { code: 'captcha' });
    }
  }
  return result;
}

async function extract(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: extractSerp });
  if (!result) throw Object.assign(new Error('extraction returned nothing'), { code: 'extract_failed' });
  return result;
}

const isBlocked = (url = '') => url.includes('/sorry/') || url.includes('consent.google.');

async function getSearchTab() {
  clearTimeout(idleCloseTimer);
  if (searchTabId !== null) {
    try { await chrome.tabs.get(searchTabId); return searchTabId; } catch { searchTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  searchTabId = tab.id;
  return searchTabId;
}

function armIdleClose() {
  clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(async () => {
    if (searchTabId !== null) {
      try { await chrome.tabs.remove(searchTabId); } catch {}
      searchTabId = null;
    }
  }, TAB_IDLE_CLOSE_MS);
}

// Resolve as soon as the result list is in the DOM, not on the tab's
// 'complete': that waits for every image and deferred script on the page and
// was most of a search's wall time (5-8s against ~1-2s for the results).
async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(250);
    const tab = await chrome.tabs.get(tabId);
    if (isBlocked(tab.url)) return;
    // Until the tab reports the new URL, the DOM we would probe is the old page's.
    if (!tab.url?.startsWith('https://www.google.com/search')) continue;
    if (tab.status === 'complete') return;
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.readyState !== 'loading' &&
          !!document.querySelector('#botstuff, #rso .MjjYud:last-child, #captcha-form'),
      });
      if (result) return;
    } catch {} // mid-navigation: the frame is being swapped, try again
  }
  throw Object.assign(new Error('page load timed out'), { code: 'timeout' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------- runs inside the page
// Self-contained: executeScript serialises this function, so it may not use
// anything from the scope above.
async function extractSerp() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 10_000;
  const blocked = () => location.pathname.startsWith('/sorry') ||
    !!document.querySelector('#captcha-form, form[action*="sorry"], iframe[src*="recaptcha"]');
  while (!document.querySelector('#rso, #search, #botstuff') && Date.now() < deadline) {
    if (blocked()) return { blocked: true };
    await wait(200);
  }
  if (blocked()) return { blocked: true };

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const googleHost = /^(www\.)?google\.[a-z.]+$/;

  const unwrap = (href) => {
    try {
      const u = new URL(href, location.href);
      if (googleHost.test(u.hostname) && u.pathname === '/url') return u.searchParams.get('q') || u.searchParams.get('url') || null;
      return u.href;
    } catch { return null; }
  };

  // Organic results: every link that wraps an <h3>, inside the results column.
  const root = document.querySelector('#rso') || document.querySelector('#search') || document.body;
  const results = [];
  const seen = new Set();
  for (const h3 of root.querySelectorAll('a h3')) {
    const a = h3.closest('a');
    const url = unwrap(a?.getAttribute('href'));
    if (!url || !/^https?:/.test(url)) continue;
    let host;
    try { host = new URL(url).hostname; } catch { continue; }
    if (googleHost.test(host)) continue; // Google's own nav links, not results
    if (seen.has(url)) continue;
    seen.add(url);

    const box = a.closest('.MjjYud, .g, [data-hveid]') || a.parentElement;
    const snipEl = box?.querySelector('[data-sncf="1"], .VwiC3b, [style*="-webkit-line-clamp"]');
    let snippet = clean(snipEl?.innerText);
    if (!snippet && box) {
      // Layout changed: fall back to the block's text minus the title.
      snippet = clean(box.innerText.replace(h3.innerText, '')).slice(0, 400);
    }
    results.push({ position: results.length + 1, title: clean(h3.innerText), url, snippet });
  }

  const text = (sel) => clean(document.querySelector(sel)?.innerText) || null;

  const featured = text('.xpdopen .hgKElc, [data-attrid="wa:/description"], .IZ6rdc');
  const knowledgeTitle = text('[data-attrid="title"]');
  const knowledgeDesc = text('.kno-rdesc span, [data-attrid="description"] span');
  const peopleAlsoAsk = [...document.querySelectorAll('[data-q]')]
    .map((el) => clean(el.getAttribute('data-q'))).filter(Boolean).slice(0, 8);
  const related = [...new Set(
    [...document.querySelectorAll('#botstuff a[href^="/search"], #bres a[href^="/search"]')]
      .map((a) => clean(a.innerText)).filter((t) => t && t.length < 120 && !/^\d+$/.test(t)), // drop pager links
  )].slice(0, 10);

  return {
    url: location.href,
    stats: text('#result-stats'),
    results,
    featured,
    knowledge: knowledgeTitle || knowledgeDesc ? { title: knowledgeTitle, description: knowledgeDesc } : null,
    peopleAlsoAsk,
    related,
  };
}

// ------------------------------------------------------------ lifecycle

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'keepalive') connect(); });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.port) { try { ws?.close(); } catch {} connect(); }
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === 'status') reply(state);
  if (msg === 'reconnect') { try { ws?.close(); } catch {} connect(); reply(true); }
});

connect();
