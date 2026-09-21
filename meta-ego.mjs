/**
 * Meta AI engine on the Mac mini's residential connection, via ego lite.
 *
 * Railway is currently served Meta's country-unavailable page even for an
 * imported, signed-in profile. The account is fine; the container address is
 * not. Running the same UI driver on the mini keeps the request on the home IP
 * where Meta AI is available.
 *
 *   node worker/meta-ego.mjs probe [id]
 *   node worker/meta-ego.mjs ask   [id] "prompt"
 *   node worker/meta-ego.mjs login [id]
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_SESSION = 'meta-main';
const META_URL = 'https://www.meta.ai/';
const ASK_TIMEOUT_MS = Number(process.env.META_ASK_TIMEOUT_MS ?? 180_000);
const EGO_BIN = process.env.EGO_BROWSER_BIN ?? 'ego-browser';
const PATH_WITH_LOCAL = `${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}`;
const MARK = '@@EGO_RESULT@@';
const REGISTRY = `${process.env.HOME}/.gmap-worker/spaces.json`;

const COMPOSER = 'div[contenteditable="true"][role="textbox"]';
const ANSWER = '[data-testid="assistant-message"]';
const SEND = '[data-testid="composer-send-button"]';

function spaceFor(id, override) {
  if (override) return typeof override === 'object' ? override : { space: override, profile: null };
  if (process.env.META_SPACE) return { space: Number(process.env.META_SPACE), profile: process.env.META_PROFILE ?? null };
  try {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const entry = reg[id];
    if (entry !== undefined) return typeof entry === 'object' ? entry : { space: entry, profile: null };
  } catch { /* no registry yet */ }
  throw Object.assign(
    new Error(`no task space for Meta session "${id}" — add it to ${REGISTRY}, or pass META_SPACE`),
    { code: 'no_space' },
  );
}

function egoRun(script, { timeoutMs = ASK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(EGO_BIN, ['nodejs'], {
      env: { ...process.env, PATH: PATH_WITH_LOCAL },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('ego-browser did not finish in time'), { code: 'timeout' }));
    }, timeoutMs + 15_000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(killer);
      if (e.code === 'ENOENT') {
        return reject(Object.assign(new Error('ego-browser is not on PATH — install ego lite, finish onboarding, then retry'), { code: 'not_installed' }));
      }
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      const line = `${out}\n${err}`.split(/\r?\n/).find((l) => l.includes(MARK));
      if (line) {
        try { return resolve(JSON.parse(line.slice(line.indexOf(MARK) + MARK.length))); }
        catch { return reject(new Error('unparseable result line: ' + line.slice(0, 200))); }
      }
      const detail = (err.trim() || out.trim() || `exited ${code}`).slice(0, 400);
      if (/user is controlling/i.test(detail)) {
        return reject(Object.assign(new Error('the user has taken control of this task space'), { code: 'user_controlling' }));
      }
      reject(Object.assign(new Error(detail), { code: 'engine_error' }));
    });
    child.stdin.end(script);
  });
}

const READ_SRC = `
const readMetaAnswer = (baseline) => "(() => {" +
  " const nodes = document.querySelectorAll('[data-testid=\\"assistant-message\\"]');" +
  " const el = nodes.length > baseline ? nodes[nodes.length - 1] : null;" +
  " if (!el) return { present: false, text: '' };" +
  " const copy = el.cloneNode(true);" +
  " copy.querySelectorAll('button, [role=button], svg').forEach((n) => n.remove());" +
  " copy.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + (el.clientWidth || 800) + 'px';" +
  " document.body.appendChild(copy);" +
  " const text = (copy.innerText || el.innerText || '').trim();" +
  " copy.remove();" +
  " return { present: true, text };" +
  "})()";
`;

const GATE_EXPR = `(() => {
  const body = document.body ? document.body.innerText : '';
  const clickables = [...document.querySelectorAll('button, a')];
  const text = (n) => (n.innerText || n.textContent || '').trim();
  return {
    region: /is(?:n't| not) available(?: yet)? in your (?:country|region)/i.test(body),
    login: !!document.querySelector('[data-testid="login-button"]') || clickables.some((n) => /^log in$/i.test(text(n))),
    account: !!document.querySelector('[data-testid="user-menu-button"], button[aria-label*="account" i], button[aria-label*="profile" i]') || clickables.some((n) => /log out of meta ai/i.test(text(n))),
    composer: !!document.querySelector(${JSON.stringify(COMPOSER)}),
    body: body.slice(0, 240),
  };
})()`;

function profileGuard(profile) {
  if (!profile) return '';
  return `{
    const all = await listTaskSpaces();
    const found = all.find((x) => x.id === task.id);
    if (!found || found.profileName !== ${JSON.stringify(profile)}) {
      emit({ ok: false, code: 'wrong_profile', space: task.id,
             expected: ${JSON.stringify(profile)}, actual: found ? found.profileName : null });
      throw new Error('wrong profile');
    }
  }`;
}

export function buildAskScript({ id, prompt, space: override, timeoutMs = ASK_TIMEOUT_MS }) {
  const { space, profile } = spaceFor(id, override);
  return `
${READ_SRC}
const t0 = Date.now();
const phases = {};
let mark = t0;
const phase = (name) => { phases[name] = Date.now() - mark; mark = Date.now(); };
const emit = (o) => cliLog(${JSON.stringify(MARK)} + JSON.stringify(o));
try {
  const task = await useOrCreateTaskSpace(${typeof space === 'number' ? space : JSON.stringify(space)});
  ${profileGuard(profile)}
  phase('space');
  await openOrReuseTab(${JSON.stringify(META_URL)}, { wait: true, timeout: 30 });
  await gotoAndWait(${JSON.stringify(META_URL)}, { timeout: 30, settle: 2 });
  phase('load');

  const gate = await js(${JSON.stringify(GATE_EXPR)});
  if (gate.region) {
    emit({ ok: false, code: 'region_blocked', error: gate.body, space: task.id, phases });
  } else if (gate.login || (!gate.account && !gate.composer)) {
    emit({ ok: false, code: 'signed_out', error: gate.body, space: task.id, phases });
  } else {
    await waitForElement(${JSON.stringify(COMPOSER)}, { timeout: 20 });
    const baseline = await js(${JSON.stringify(`document.querySelectorAll('${ANSWER}').length`)});
    await click(${JSON.stringify(COMPOSER)}, { label: 'focus the Meta AI composer' });
    await cdp('Input.insertText', { text: ${JSON.stringify(prompt)} });
    const typed = await js(${JSON.stringify(`(document.querySelector('${COMPOSER}') || {}).innerText || ''`)});
    phase('type');
    if (!typed.trim()) {
      emit({ ok: false, code: 'compose_failed', space: task.id, phases });
    } else {
      await waitForElement(${JSON.stringify(SEND)}, { timeout: 20 });
      await click(${JSON.stringify(SEND)}, { label: 'send the Meta AI prompt' });
      phase('submit');

      const deadline = Date.now() + ${timeoutMs};
      let quiet = 0, previous = '', answer = '', done = false;
      while (Date.now() < deadline) {
        await wait(0.5);
        const current = await js(readMetaAnswer(baseline));
        if (!current.present || !current.text) continue;
        if (current.text === previous) quiet++; else quiet = 0;
        previous = current.text;
        if (quiet >= 8) { answer = current.text; done = true; break; }
      }
      phase('answer');
      emit(done
        ? { ok: true, engine: 'meta', id: ${JSON.stringify(id)}, answer, space: task.id, ms: Date.now() - t0, phases }
        : { ok: false, code: 'answer_timeout', space: task.id, ms: Date.now() - t0, phases });
    }
  }
} catch (e) {
  emit({ ok: false, code: 'engine_error', error: String((e && e.message) || e) });
}
`;
}

export function buildProbeScript({ id, space: override }) {
  const { space, profile } = spaceFor(id, override);
  return `
const t0 = Date.now();
const emit = (o) => cliLog(${JSON.stringify(MARK)} + JSON.stringify(o));
try {
  const task = await useOrCreateTaskSpace(${typeof space === 'number' ? space : JSON.stringify(space)});
  ${profileGuard(profile)}
  await openOrReuseTab(${JSON.stringify(META_URL)}, { wait: true, timeout: 30 });
  await gotoAndWait(${JSON.stringify(META_URL)}, { timeout: 30, settle: 2 });
  const info = await pageInfo();
  const gate = await js(${JSON.stringify(GATE_EXPR)});
  const status = gate.region ? 'region_blocked' : gate.login ? 'signed_out' : (gate.account || gate.composer) ? 'ready' : 'unknown';
  emit({ ok: true, id: ${JSON.stringify(id)}, space: task.id, status,
         url: info.url, title: info.title, signals: gate, ms: Date.now() - t0 });
} catch (e) {
  emit({ ok: false, code: 'engine_error', error: String((e && e.message) || e) });
}
`;
}

function loginScript({ id }) {
  const { space } = spaceFor(id);
  return `
const emit = (o) => cliLog(${JSON.stringify(MARK)} + JSON.stringify(o));
const task = await useOrCreateTaskSpace(${typeof space === 'number' ? space : JSON.stringify(space)});
await openOrReuseTab(${JSON.stringify(META_URL)}, { wait: true, timeout: 30 });
const result = await handOffTaskSpace(task.id);
emit({ ok: true, handedOff: result.done, space: task.id,
       next: 'sign in to Meta AI in that space, then run: probe' });
`;
}

export async function ask({ id = DEFAULT_SESSION, prompt, space, timeoutMs = ASK_TIMEOUT_MS }) {
  if (!prompt?.trim()) throw Object.assign(new Error('no prompt'), { code: 'bad_request' });
  return egoRun(buildAskScript({ id, prompt, space, timeoutMs }), { timeoutMs });
}

export async function probe({ id = DEFAULT_SESSION, space }) {
  return egoRun(buildProbeScript({ id, space }), { timeoutMs: 90_000 });
}

export async function login({ id = DEFAULT_SESSION }) {
  return egoRun(loginScript({ id }), { timeoutMs: 90_000 });
}

if (import.meta.filename === process.argv[1]) {
  const [command, ...rest] = process.argv.slice(2);
  const id = rest[0] && !rest[0].includes(' ') && rest.length > 1 ? rest.shift() : DEFAULT_SESSION;
  try {
    const out = command === 'ask'
      ? await ask({ id, prompt: rest.join(' ') })
      : command === 'login'
        ? await login({ id: rest[0] ?? id })
        : await probe({ id: rest[0] ?? id });
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok === false ? 1 : 0);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code ?? 'engine_error', error: error.message }, null, 2));
    process.exit(1);
  }
}
