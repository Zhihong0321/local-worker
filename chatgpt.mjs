// A signed-in ChatGPT session on the mini, driven over raw CDP.
//
// WHY A SECOND ONE. The container already has this (agy-lab/src/sessions.ts) and
// it works. What it does not have is a second account or a second browser: one
// Chrome, MAX_OPEN_BROWSERS=1, so every ChatGPT call in the system queues behind
// every other one. This machine has a residential IP, a real GUI session and a
// different account, so it is a second lane rather than a copy.
//
// NO PLAYWRIGHT, same rule as gmap.mjs: this drives the Chrome already installed
// here over CDP with Node's global WebSocket. The worker has zero dependencies
// and that is the point for a process meant to run unattended for months.
//
// HEADED, NOT HEADLESS. gmap.mjs runs --headless=new because Maps does not care.
// ChatGPT does: headless is a different user-agent, no window chrome and a
// documented set of behavioural tells, and it sits behind a bot check that reads
// exactly those. The container pays for a whole Xvfb to avoid it. Here the
// machine already has a login window, so headed costs nothing.
//
// ATTACH FIRST, LAUNCH SECOND. Chrome allows one process per user-data-dir and
// enforces it with a lock; a second launch does not queue, it fails or corrupts
// the profile. So a call looks for a debuggable Chrome already on this profile's
// port and uses it, and only launches when nothing answers. That is also what
// makes the hand-login work: the window you sign in to IS the browser this then
// drives, with no handover.
//
// The DOM knowledge below MUST track agy-lab/src/sessions.ts. Copied rather than
// shared because this process and that one have nothing else in common — but
// when ChatGPT changes its markup, both change together.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE_ROOT = process.env.CGPT_PROFILE_ROOT ?? path.join(os.homedir(), '.gmap-worker/profiles');
const DEFAULT_SESSION = process.env.CGPT_SESSION ?? 'mini-main';
const BASE_PORT = Number(process.env.CGPT_CDP_PORT ?? 9430);
const ASK_TIMEOUT_MS = Number(process.env.CGPT_ASK_TIMEOUT_MS ?? 180_000);

const TEMP_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';
/** Bot-check interstitials. Emphatically not a logout. */
const CHALLENGE = /just a moment|checking your browser|verify you are human|cf-chl|challenge-platform|attention required/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ids reach here from a job payload, so anything that could climb out of
 * PROFILE_ROOT is a path traversal into the home directory.
 */
function profileDir(id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) throw new Error(`bad session id: ${id}`);
  return path.join(PROFILE_ROOT, id);
}

/**
 * One port per session, derived from the id so it is the same on every run.
 * A port picked at random would be a port the next process cannot find, which
 * defeats attaching to a browser a human left open.
 */
function portFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 50;
  return BASE_PORT + h;
}

// --------------------------------------------------------------------- chrome

function launch(id) {
  const dir = profileDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    '--remote-debugging-port=' + portFor(id),
    '--user-data-dir=' + dir,
    '--no-first-run',
    '--no-default-browser-check',
    // The one automation signal that is free to remove and is checked by
    // everything. Not a stealth suite and does not pretend to be — what actually
    // carries this session is a real Chrome on a residential line.
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
    TEMP_CHAT_URL,
  ];
  // Detached: the browser must outlive the worker process. A restart of the
  // worker that killed the signed-in window would mean a human logging in again
  // for no reason, and attach-first exists precisely so it does not have to.
  const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/** Is a debuggable Chrome already on this profile's port? */
async function alive(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function targets(port) {
  const r = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(5000) });
  return r.json();
}

/**
 * Attach to this session's Chrome, launching it if nothing is there.
 *
 * `launchIfMissing: false` is what probe() uses to tell "signed out" apart from
 * "nobody has ever opened this profile" without starting a browser to find out.
 */
async function connect(id, { launchIfMissing = true, timeoutMs = 60_000 } = {}) {
  const port = portFor(id);
  let running = await alive(port);
  if (!running) {
    if (!launchIfMissing) throw Object.assign(new Error('no Chrome on this profile'), { code: 'not_open' });
    launch(id);
    // Poll rather than sleep a guessed amount: a cold profile on a busy machine
    // can take several seconds, and a warm one is ready almost at once.
    for (let i = 0; i < 60 && !running; i++) {
      await sleep(500);
      running = await alive(port);
    }
    if (!running) throw new Error('Chrome never opened a debugging port on ' + port);
  }

  let list = [];
  for (let i = 0; i < 40; i++) {
    list = await targets(port).catch(() => []);
    if (list.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
    await sleep(500);
  }
  // Prefer a tab already on chatgpt.com — the one a human signed in on — over
  // whatever else the window happens to have open.
  const page =
    list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /chatgpt\.com/.test(t.url)) ??
    list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('Chrome is running on port ' + port + ' but has no debuggable page');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('could not attach to Chrome over CDP on port ' + port));
    setTimeout(() => rej(new Error('CDP attach timed out')), timeoutMs);
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++seq;
      pending.set(i, res);
      setTimeout(() => {
        if (pending.delete(i)) rej(new Error(method + ' got no reply from Chrome'));
      }, 30_000);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('page script failed: ' + r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { ws, cdp, evaluate, port, url: page.url };
}

/** Navigate and wait for the composer, or for a sign-in control, to exist. */
async function goto(conn, url, timeoutMs) {
  await conn.cdp('Page.enable');
  await conn.cdp('Page.navigate', { url });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const state = await conn.evaluate(READY).catch(() => null);
    if (state?.settled) return state;
  }
  return conn.evaluate(READY).catch(() => null);
}

// ------------------------------------------------------------------ page code

/**
 * Has the page committed to an answer yet?
 *
 * The obvious design — wait for the composer — is WRONG against the current
 * site: the logged-OUT page ships a fully working composer, so "the composer is
 * live" does not mean "signed in". Both signals are read, and the sign-in
 * control outranks the composer everywhere below.
 */
const READY = `(() => {
  const text = (n) => (n.textContent || '').trim().toLowerCase();
  const clickable = Array.from(document.querySelectorAll('button, a'));
  const login = clickable.some((n) => ['log in','login','sign up','sign up for free'].includes(text(n)));
  const composer = !!document.querySelector('#prompt-textarea');
  return {
    login,
    composer,
    account: !!document.querySelector('[data-testid="profile-button"], [data-testid="accounts-profile-button"]'),
    settled: login || composer,
    url: location.href,
    title: document.title,
    body: (document.body ? document.body.innerText : '').slice(0, 400),
  };
})()`;

/**
 * Read the last assistant message, minus the controls ChatGPT renders inside it.
 *
 * The assistant subtree contains a <button> whose label ("Edit") is the FIRST
 * text node in it, so a plain innerText prefixes every answer with a word the
 * model never said. The button shares a container with the prose, so no selector
 * takes one and not the other; the text is read from a copy with the controls
 * stripped. The copy must be IN the document to be read — innerText is
 * layout-dependent and degrades to textContent when detached, which is exactly
 * where the line breaks are lost, and line breaks are the reason this reads
 * innerText at all.
 */
const READ_ANSWER = `(() => {
  const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
  const el = nodes[nodes.length - 1];
  if (!el) return { text: '', streaming: false, present: false };
  // The page's OWN completion signal, measured on this build 2026-08-20: while a
  // reply is rendering the node carries aria-busy="true" and .result-streaming,
  // and both go when it is done. Waiting for the text to stop changing instead
  // would add seconds of silence to every call to learn what the DOM already says.
  // What "still generating" actually is on this build, measured 2026-08-20: the
  // composer swaps its send button for a stop button, and swaps back when the
  // reply is done. aria-busy is NOT it — that attribute was still set 41 seconds
  // after a one-character answer had finished rendering, and stays set forever on
  // a stream that died.
  const streaming = !!document.querySelector('[data-testid="stop-button"]');
  try {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('button, [role="button"], svg').forEach((n) => n.remove());
    copy.style.position = 'fixed';
    copy.style.left = '-99999px';
    copy.style.top = '0';
    copy.style.width = (el.clientWidth || 800) + 'px';
    document.body.appendChild(copy);
    const text = copy.innerText;
    copy.remove();
    return { text: (text.trim() || el.innerText.trim()), streaming, present: true };
  } catch (e) {
    return { text: el.innerText.trim(), streaming, present: true };
  }
})()`;

const COMPOSER_TEXT = `(() => { const el = document.querySelector('#prompt-textarea'); return el ? el.innerText : ''; })()`;

/**
 * The three facts that say whether a prompt has actually been sent.
 *
 * `users` is the one that matters. The composer emptying is not proof — it also
 * empties on a failed submit that clears the field — but a new
 * [data-message-author-role="user"] node is the app's own record that it
 * accepted the message. Measured on this build, 2026-08-20.
 */
const COMPOSER_STATE = `(() => {
  const c = document.querySelector('#prompt-textarea');
  return {
    composer: c ? c.innerText.trim() : null,
    sendButton: !!document.querySelector('[data-testid="send-button"]'),
    users: document.querySelectorAll('[data-message-author-role="user"]').length,
  };
})()`;

// ------------------------------------------------------------------- the calls

/**
 * Is this profile signed in?
 *
 * Six states, the same vocabulary agy-lab uses. `ok | broken` would collapse
 * "could not tell" into "logged out", and with a browser there are far more ways
 * to not be able to tell — a bot check, a browser nobody has opened yet and a
 * genuinely signed-out account are three problems with three different fixes.
 */
export async function probe(payload = {}) {
  const id = payload.id ?? DEFAULT_SESSION;
  const startedAt = Date.now();
  const done = (status, detail, extra = {}) => ({
    id, status, detail, ms: Date.now() - startedAt, at: new Date().toISOString(), ...extra,
  });

  if (!fs.existsSync(profileDir(id))) return done('never_used', `no profile at ${profileDir(id)} — run: node worker/chatgpt.mjs open ${id}`);

  let conn = null;
  try {
    conn = await connect(id, { launchIfMissing: payload.launch !== false });
    const s = await goto(conn, TEMP_CHAT_URL, Number(payload.timeoutMs) || 60_000);
    if (!s) return done('unknown', 'the page never answered');
    const extra = { url: s.url, title: s.title, signals: { login: s.login, composer: s.composer, account: s.account } };
    // A visible sign-in control outranks everything: the signed-out page has a
    // composer too, but a signed-in one never offers you a login button.
    if (s.login) return done('logged_out', `sign-in wall at ${hostOf(s.url)} — "Log in" is on the page`, extra);
    if (s.account || s.composer) return done('ready', `signed in — composer live and no login control on ${hostOf(s.url)}`, extra);
    if (CHALLENGE.test(s.title) || CHALLENGE.test(s.url) || CHALLENGE.test(s.body)) {
      return done('challenged', `bot check in the way ("${s.title}") — the session may be fine`, extra);
    }
    return done('unknown', `no login control and no composer at ${hostOf(s.url)} ("${s.title}")`, extra);
  } catch (err) {
    if (err.code === 'not_open') return done('never_used', 'no Chrome running on this profile and launch was disabled');
    return done('unknown', firstLine(err.message));
  } finally {
    try { conn?.ws.close(); } catch { /* already gone */ }
  }
}

/**
 * Send one prompt through the signed-in UI and read the answer back.
 *
 * Fresh by default: each ask opens a new temporary chat, because reusing
 * whatever page was on screen makes call N+1 depend on call N's conversation,
 * which is invisible from the API and impossible to reason about from a tool.
 *
 * Refuses a signed-out session rather than answering from one. A logged-out
 * chatgpt.com still ships a working composer, so typing into it succeeds and
 * returns an anonymous answer that is indistinguishable downstream from a real
 * one. Failing the call beats feeding a pipeline garbage.
 */
export async function ask(payload = {}) {
  const id = payload.id ?? DEFAULT_SESSION;
  const prompt = String(payload.prompt ?? '').trim();
  if (!prompt) throw new Error('chatgpt.ask needs a prompt');
  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : ASK_TIMEOUT_MS;
  const startedAt = Date.now();

  // Phase timings, returned with every answer. A wrapper whose calls are slow is
  // the normal state of this thing — it is a browser doing what a person does —
  // so "which part was slow" has to be in the result, not in a debugging session
  // somebody runs later against a page that has moved on.
  const phases = {};
  let mark = startedAt;
  const phase = (name) => { phases[name] = Date.now() - mark; mark = Date.now(); };

  let conn = null;
  try {
    conn = await connect(id);
    phase('connect');
    const state = payload.fresh === false && /chatgpt\.com/.test(conn.url)
      ? await conn.evaluate(READY)
      : await goto(conn, TEMP_CHAT_URL, 60_000);
    phase('load');

    if (!state?.composer) {
      throw Object.assign(new Error(`no composer on ${hostOf(state?.url ?? '')} ("${state?.title ?? ''}")`), { code: 'engine_error' });
    }
    if (state.login) {
      throw Object.assign(
        new Error(`session "${id}" is signed out — chatgpt.com is showing a sign-in wall`),
        { code: 'logged_out' },
      );
    }

    // Interactive, not merely present. THIS is what the first failed run on this
    // machine was: the composer exists and accepts text well before ProseMirror's
    // keydown handler is wired, so the prompt went in, Enter did nothing, and the
    // question sat in the box until the timeout. Waiting for the send button to
    // render is the cheapest signal that the composer is live rather than drawn.
    await waitInteractive(conn);
    phase('interactive');
    const entry = await enterPrompt(conn, prompt);
    phase('type');
    const submitted = await submit(conn);
    phase('submit');

    // Done = there is text, the stop button is gone, and the text did not change
    // since the last look. Two hundred milliseconds apart, so a one-word answer
    // costs about a second to confirm instead of the four and a half a
    // three-quiet-ticks-of-1.5s rule spends learning what the page already knows.
    const deadline = Date.now() + timeoutMs;
    let last = '';
    const trace = [];
    const tAns = Date.now();
    while (Date.now() < deadline) {
      await sleep(200);
      const r = await conn.evaluate(READ_ANSWER).catch(() => null);
      if (process.env.CGPT_TRACE) trace.push([Date.now() - tAns, r ? (r.present?1:0) : -1, r?.streaming?1:0, r?.text?.length ?? 0]);
      if (!r?.present) continue;
      if (r.text && !r.streaming && r.text === last) break;
      last = r.text;
    }
    if (process.env.CGPT_TRACE) phases.trace = trace;

    phase('answer');
    if (!last) {
      throw Object.assign(new Error('the session produced no text'), { code: 'engine_error' });
    }
    return {
      id, engine: 'chatgpt', answer: last, ms: Date.now() - startedAt,
      settled: Date.now() < startedAt + timeoutMs, entry, submitted, phases, at: new Date().toISOString(),
    };
  } finally {
    try { conn?.ws.close(); } catch { /* already gone */ }
  }
}

/**
 * Put the prompt in the composer.
 *
 * Not keystrokes: Enter submits, so the first newline in a multi-line prompt
 * would send half a question, and at a realistic per-character delay a prompt
 * with a document in it spends a minute being typed. Input.insertText hands the
 * whole string to the focused node and fires beforeinput/input, which is what
 * ProseMirror listens to, in one call.
 *
 * Verified rather than trusted, because "the field looks right" and "the app
 * accepted it" are different claims — that distinction is what made the
 * container's MFA login take a day.
 */
async function enterPrompt(conn, prompt) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const head = norm(prompt).slice(0, 40);
  const landed = async () => !head || norm(await conn.evaluate(COMPOSER_TEXT).catch(() => '')).includes(head);

  await conn.evaluate(`(() => { const el = document.querySelector('#prompt-textarea'); if (el) el.focus(); return !!el; })()`);
  await conn.cdp('Input.insertText', { text: prompt });
  await sleep(150);
  if (await landed()) return 'insert';

  // Fallback: execCommand goes through the same beforeinput/input path from
  // inside the page, which some builds of the composer accept when the CDP call
  // lands in the wrong node.
  await conn.evaluate(`(() => {
    const el = document.querySelector('#prompt-textarea');
    if (!el) return false;
    el.focus();
    document.execCommand('selectAll', false, null);
    return document.execCommand('insertText', false, ${JSON.stringify(prompt)});
  })()`);
  await sleep(150);
  if (await landed()) return 'execCommand';

  throw Object.assign(new Error('the composer did not accept the prompt'), { code: 'engine_error' });
}

/** Wait for the composer to be live rather than merely rendered. */
async function waitInteractive(conn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await conn.evaluate(COMPOSER_STATE).catch(() => null);
    if (s?.sendButton) return true;
    await sleep(400);
  }
  // Not fatal on its own: the testid could be renamed tomorrow, and submit()
  // below proves the send either way rather than assuming this did.
  return false;
}

/**
 * Send the prompt: click the send button.
 *
 * Not Enter. Enter is a keystroke the page may or may not have a handler for
 * yet, it means "newline" in some composer states, and there is no way to tell
 * which happened without inspecting the page afterwards — so it needs a proof
 * step, and a proof step that fires a fallback is how you end up submitting
 * twice. Two submits is what leaves an assistant node stuck on aria-busy with
 * an empty body forever, which is a far worse failure than a click that misses.
 *
 * The button carries data-testid="send-button" and is the same element
 * waitInteractive() already waits for. One action, one outcome.
 */
async function submit(conn) {
  const before = (await conn.evaluate(COMPOSER_STATE).catch(() => null))?.users ?? 0;
  const clicked = await conn
    .evaluate(`(() => { const b = document.querySelector('[data-testid="send-button"]'); if (!b) return false; b.click(); return true; })()`)
    .catch(() => false);
  if (!clicked) throw Object.assign(new Error('no send button on the page'), { code: 'engine_error' });

  // A new [data-message-author-role="user"] node is the app's own record that it
  // took the message — the composer emptying is not, it empties on a failed
  // submit too.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(250);
    const s = await conn.evaluate(COMPOSER_STATE).catch(() => null);
    if (s && s.users > before) return 'send-button';
  }
  throw Object.assign(
    new Error('clicked send and no message appeared — the prompt is still in the composer'),
    { code: 'engine_error' },
  );
}

/**
 * Open the profile and leave it open, for a human to sign in to by hand.
 *
 * This is the whole login story on this machine. The container needs a scripted
 * flow with a stored TOTP secret because nobody can reach it; here there is a
 * screen and a keyboard, the IP is residential, and Cloudflare has no argument
 * with a person typing a password into their own browser.
 */
export async function open(payload = {}) {
  const id = payload.id ?? DEFAULT_SESSION;
  const conn = await connect(id);
  const state = await goto(conn, payload.url ?? TEMP_CHAT_URL, 60_000).catch(() => null);
  try { conn.ws.close(); } catch { /* already gone */ }
  return { id, dir: profileDir(id), port: portFor(id), url: state?.url ?? null, title: state?.title ?? null,
    signedIn: Boolean(state && !state.login && (state.account || state.composer)) };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || '(no url)'; }
}

function firstLine(text, limit = 300) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim()) ?? String(text);
  return line.length > limit ? `${line.slice(0, limit)}...` : line.trim();
}

// Standalone, so this can be proven on the mini before anything routes to it:
//   node worker/chatgpt.mjs open  [id]        launch the profile and sign in by hand
//   node worker/chatgpt.mjs probe [id]        is it signed in
//   node worker/chatgpt.mjs ask   [id] "..."  send a prompt
if (import.meta.filename === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const id = rest[0] && !rest[0].includes(' ') && rest.length > 1 ? rest.shift() : DEFAULT_SESSION;
  const out =
    cmd === 'ask' ? await ask({ id, prompt: rest.join(' ') })
    : cmd === 'open' ? await open({ id: rest[0] ?? id })
    : await probe({ id: rest[0] ?? id });
  console.log(JSON.stringify(out, null, 2));
}
