import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createCloudStatus, createDashboardServer, startDashboard } from './worker-dashboard.mjs';
import { renderDashboardHtml } from './worker-dashboard-html.mjs';

const cloudPayload = {
  counts: { pending: 3, running: 1 },
  waiting: 2,
  workers: [
    { name: 'other-box', lastSeenAt: new Date(Date.now() - 10_000).toISOString(), ip: '1.2.3.4', types: ['ping'] },
    { name: 'box-ask', lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(), ip: '5.6.7.8', types: ['chatgpt.ask'] },
  ],
};

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function listen(options) {
  return startDashboard({ host: '127.0.0.1', port: 0, log: () => {}, ...options });
}

test('cloud status normalizes workers, marks the local lane, and caches', async () => {
  let calls = 0;
  const cloud = createCloudStatus({
    lab: 'https://lab.example',
    token: 'test-token-value',
    workerName: 'box',
    fetchImpl: async () => {
      calls++;
      return jsonResponse(cloudPayload);
    },
  });

  const first = await cloud.get();
  const second = await cloud.get();
  assert.equal(calls, 1, 'a refresh inside the cache window must not re-poll the broker');
  assert.equal(second.counts.pending, 3);
  assert.equal(first.waiting, 2);

  const local = first.workers.find((w) => w.name === 'box-ask');
  assert.equal(local.isLocal, true);
  assert.equal(local.online, false, 'a five-minute-old lane is stale');
  const other = first.workers.find((w) => w.name === 'other-box');
  assert.equal(other.isLocal, false);
  assert.equal(other.online, true);
});

test('cloud status preserves broker quota cooldown instead of calling the lane online', async () => {
  const until = new Date(Date.now() + 5_825_000).toISOString();
  const cloud = createCloudStatus({ lab: 'https://lab.example', token: 'test-token-value',
    workerName: 'windows-pc-1', fetchImpl: async () => jsonResponse({ counts: {}, workers: [{
      name: 'windows-pc-1-agy1', status: 'cooldown', lastSeenAt: new Date().toISOString(),
      cooldownUntil: until, cooldownReason: 'Individual quota reached', types: ['agy.ask'],
    }] }) });
  const lane = (await cloud.get()).workers[0];
  assert.equal(lane.state, 'cooldown');
  assert.equal(lane.online, false);
  assert.equal(lane.cooldownUntil, until);
  assert.equal(lane.cooldownReason, 'Individual quota reached');
});

test('the displayed dashboard says quota reached and counts down to reset', async () => {
  const html = renderDashboardHtml();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  const until = new Date(Date.now() + 5_825_000).toISOString();
  const nodes = new Map();
  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', className: '',
      style: {}, addEventListener() {} });
    return nodes.get(id);
  };
  vm.runInNewContext(script, {
    document: { getElementById: getNode, hidden: false },
    fetch: async () => jsonResponse({
      at: new Date().toISOString(),
      local: { worker: { name: 'windows-pc-1', node: 'v24', platform: 'win32', arch: 'x64' },
        totals: { lanes: 2, cooldown: 2, running: 0, idle: 0 },
        lanes: [{ name: 'windows-pc-1-agy1', state: 'cooldown', types: ['agy.ask'],
          cooldownUntil: until, cooldownReason: 'Individual quota reached', errors: 0, polls: 1 }],
        events: [] },
      cloud: { ok: true, counts: {}, workers: [{ name: 'windows-pc-1-agy1',
        state: 'cooldown', online: false, cooldownUntil: until, ageSec: 1,
        isLocal: true, types: ['agy.ask'] }] },
      gsearch: { extension: {} },
    }),
    setInterval() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(getNode('metrics').innerHTML, /2 quota cooldown/);
  assert.match(getNode('lanes').innerHTML, /QUOTA COOLDOWN/);
  assert.match(getNode('lanes').innerHTML, /Quota reached · waiting for refresh in 1h 37m/);
  assert.match(getNode('workers').innerHTML, /QUOTA COOLDOWN/);
  assert.doesNotMatch(getNode('workers').innerHTML, />ONLINE</);
});

test('cloud status degrades to an error shape instead of throwing or leaking the token', async () => {
  const cloud = createCloudStatus({
    lab: 'https://lab.example',
    token: 'super-secret-token',
    workerName: 'box',
    fetchImpl: async () => {
      throw new Error('connect failed for Bearer super-secret-token at https://lab.example/api/jobs');
    },
  });
  const result = await cloud.get();
  assert.equal(result.ok, false);
  assert.match(result.error, /connect failed/);
  assert.equal(result.error.includes('super-secret-token'), false);
  assert.deepEqual(result.counts, { pending: 0, running: 0 });
});

test('dashboard serves the page, a read-only status snapshot, and health', async (t) => {
  const cloud = createCloudStatus({
    lab: 'https://lab.example',
    token: 'test-token-value',
    workerName: 'box',
    fetchImpl: async () => jsonResponse(cloudPayload),
  });
  const running = await listen({
    getStatus: () => ({
      worker: { name: 'box' },
      totals: { lanes: 2, running: 1, idle: 1, jobsDone: 4, jobsFailed: 1, avgJobMs: 900 },
      lanes: [{ name: 'box', state: 'idle', types: ['ping'], errors: 0, polls: 7 }],
      events: [],
    }),
    cloudStatus: cloud,
    gsearchStatus: () => ({ listening: true, port: 18787, extension: { connected: false }, busy: false, queued: 0 }),
  });
  t.after(() => new Promise((resolve) => running.server.close(resolve)));

  const page = await fetch(running.url + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const body = await page.text();
  assert.match(body, /Worker Dashboard/);
  assert.match(body, /Local lanes/);

  const status = await fetch(running.url + '/api/status');
  assert.equal(status.status, 200);
  const snapshot = await status.json();
  assert.equal(snapshot.local.totals.jobsDone, 4);
  assert.equal(snapshot.cloud.counts.pending, 3);
  assert.equal(snapshot.gsearch.listening, true);
  assert.equal(JSON.stringify(snapshot).includes('test-token-value'), false);

  const health = await fetch(running.url + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

test('dashboard rejects unknown routes and writes, and survives a broken status provider', async (t) => {
  const server = createDashboardServer({
    getStatus: () => { throw new Error('snapshot exploded'); },
    cloudStatus: null,
    gsearchStatus: () => ({ listening: false, extension: { connected: false }, busy: false, queued: 0 }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = 'http://127.0.0.1:' + port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const missing = await fetch(base + '/nope');
  assert.equal(missing.status, 404);

  const write = await fetch(base + '/api/status', { method: 'POST' });
  assert.equal(write.status, 405);

  const status = await fetch(base + '/api/status');
  assert.equal(status.status, 200, 'a throwing snapshot provider must not take the endpoint down');
  const snapshot = await status.json();
  assert.deepEqual(snapshot.local.lanes, []);
  assert.equal(snapshot.cloud.ok, false);
});

const setupSnapshot = {
  at: new Date().toISOString(),
  claimedTypes: ['ping', 'research.contact'],
  groups: [{ id: 'core', label: 'Core' }],
  checks: [{ id: 'node', group: 'core', label: 'Node.js >= 20', severity: 'required', state: 'ok', detail: process.version }],
  overall: { state: 'ready', reasons: [] },
};

test('dashboard serves the setup page and setup JSON, deep only on demand', async (t) => {
  let deepCalls = 0;
  const running = await listen({
    getStatus: () => ({ worker: {}, totals: {}, lanes: [], events: [] }),
    cloudStatus: null,
    gsearchStatus: () => ({ listening: true, extension: { connected: true } }),
    setupStatus: {
      get: () => setupSnapshot,
      getWithDeep: async () => {
        deepCalls++;
        return { ...setupSnapshot, overall: { state: 'degraded', reasons: ['obscura: known defect'] }, deep: { ranAt: new Date().toISOString(), durationMs: 5, checks: [{ id: 'broker', group: 'core', label: 'Broker reachability', severity: 'required', state: 'ok', detail: '3 pending' }] } };
      },
    },
  });
  t.after(() => new Promise((resolve) => running.server.close(resolve)));

  const page = await fetch(running.url + '/setup');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const body = await page.text();
  assert.match(body, /Setup &amp; Health/);
  assert.match(body, /Run deep checks/);

  const shallow = await fetch(running.url + '/api/setup');
  assert.equal(shallow.status, 200);
  const setup = await shallow.json();
  assert.equal(setup.overall.state, 'ready');
  assert.equal(setup.deep, undefined, 'the periodic refresh never triggers probes');
  assert.equal(deepCalls, 0);

  const deep = await fetch(running.url + '/api/setup?deep=1');
  assert.equal(deep.status, 200);
  const deepSetup = await deep.json();
  assert.equal(deepCalls, 1);
  assert.ok(deepSetup.deep, 'the explicit deep request runs the probes');
  assert.equal(deepSetup.overall.state, 'degraded', 'the combined verdict includes deep checks');

  const write = await fetch(running.url + '/api/setup', { method: 'POST' });
  assert.equal(write.status, 405, 'the setup endpoint stays read-only');
});

test('setup JSON degrades to an explicit unknown shape without a provider', async (t) => {
  const running = await listen({
    getStatus: () => ({ worker: {}, totals: {}, lanes: [], events: [] }),
    cloudStatus: null,
    gsearchStatus: () => ({ listening: false, extension: { connected: false } }),
  });
  t.after(() => new Promise((resolve) => running.server.close(resolve)));

  const response = await fetch(running.url + '/api/setup');
  assert.equal(response.status, 200);
  const setup = await response.json();
  assert.equal(setup.overall.state, 'unknown');
  assert.match(setup.overall.reasons[0], /not configured/);
});
