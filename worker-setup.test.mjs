import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyOverall,
  createSetupStatus,
  runDeepChecks,
  runSetupChecks,
  severityFor,
} from './worker-setup.mjs';

const stubAgent = (available) => () =>
  available
    ? { available: true, command: 'node', prefixArgs: [], bin: 'pi.cmd' }
    : { available: false, command: null, prefixArgs: [], reason: 'could not find pi' };

const stubSkill = (dir) => () => dir;

function snapshot(overrides = {}) {
  return runSetupChecks({
    claimedTypes: overrides.claimedTypes ?? ['ping', 'research.contact'],
    env: overrides.env ?? { LAB_URL: 'https://lab.example', LAB_TOKEN: 'token-value', PATH: '' },
    gsearchStatus: overrides.gsearchStatus,
    envFile: overrides.envFile ?? '/fixtures/.env',
    nodeVersion: overrides.nodeVersion ?? process.version,
    resolveAgent: overrides.resolveAgent ?? stubAgent(true),
    resolveSkill: overrides.resolveSkill ?? stubSkill('/skills/research-contact'),
    // Everything file-shaped resolves through this stub, so the suite never
    // depends on what happens to be installed on the machine running it.
    exists: overrides.exists ?? (() => true),
  });
}

const find = (snap, id) => snap.checks.find((c) => c.id === id);

test('severity is judged against the job types this device claims', () => {
  const def = { requiredFor: ['research.'], optionalFor: [] };
  assert.equal(severityFor(def, ['research.contact']), 'required');
  assert.equal(severityFor(def, ['ping']), 'inactive');

  const optional = { requiredFor: ['gsearch.'], optionalFor: ['research.'] };
  assert.equal(severityFor(optional, ['research.contact']), 'optional');
  assert.equal(severityFor(optional, ['gsearch.search']), 'required');
  assert.equal(severityFor(optional, []), 'inactive');

  assert.equal(severityFor({ requiredFor: ['*'] }, ['ping']), 'required');
});

test('overall verdict: required bad blocks, optional bad degrades, inactive never counts', () => {
  const check = (id, severity, state) => ({ id, label: id, severity, state, detail: '' });
  assert.equal(classifyOverall([check('a', 'required', 'bad')]).state, 'not_ready');
  assert.equal(classifyOverall([check('a', 'required', 'warn')]).state, 'degraded');
  assert.equal(classifyOverall([check('a', 'optional', 'bad')]).state, 'degraded');
  assert.equal(classifyOverall([check('a', 'optional', 'warn')]).state, 'ready');
  assert.equal(classifyOverall([check('a', 'inactive', 'bad')]).state, 'ready');
  const mixed = classifyOverall([
    check('a', 'required', 'ok'),
    check('b', 'optional', 'bad'),
    check('c', 'required', 'bad'),
  ]);
  assert.equal(mixed.state, 'not_ready');
  assert.equal(mixed.reasons.length, 2, 'the optional reason is kept beside the blocking one');
});

test('core fast checks reflect the injected environment without leaking the token', () => {
  const snap = snapshot();
  assert.equal(find(snap, 'node').state, 'ok');
  assert.equal(find(snap, 'lab-config').state, 'ok');
  assert.equal(find(snap, 'lab-config').detail.includes('token-value'), false, 'the token must never ride along');
  assert.equal(find(snap, 'worker-name').state, 'warn', 'WORKER_NAME unset is a warning, not a blocker');
  assert.equal(snap.overall.state, 'ready');

  const staleNode = snapshot({ nodeVersion: 'v18.19.0' });
  assert.equal(find(staleNode, 'node').state, 'bad');
  assert.equal(staleNode.overall.state, 'not_ready', 'Node < 20 blocks everything');

  const broken = snapshot({ env: { PATH: '' }, exists: () => false });
  assert.equal(find(broken, 'env-file').state, 'bad');
  assert.equal(find(broken, 'lab-config').state, 'bad');
  assert.equal(broken.overall.state, 'not_ready');
});

test('gsearch bridge check separates listening, connected, and disabled', () => {
  const connected = snapshot({ gsearchStatus: () => ({ listening: true, port: 18787, extension: { connected: true, version: '1' } }) });
  assert.equal(find(connected, 'gsearch').state, 'ok');

  const lonely = snapshot({ gsearchStatus: () => ({ listening: true, port: 18787, extension: { connected: false } }) });
  assert.equal(find(lonely, 'gsearch').state, 'warn');
  assert.match(find(lonely, 'gsearch').remediation, /chrome:\/\/extensions/);

  const disabled = snapshot({ gsearchStatus: () => ({ listening: false, extension: { connected: false } }) });
  assert.equal(find(disabled, 'gsearch').state, 'warn');
});

test('pi and skill checks follow their resolvers and name the remediation', () => {
  const ok = snapshot();
  assert.equal(find(ok, 'pi').state, 'ok');
  assert.equal(find(ok, 'pi').severity, 'required');

  const broken = snapshot({ resolveAgent: stubAgent(false), resolveSkill: stubSkill(null) });
  assert.equal(find(broken, 'pi').state, 'bad');
  assert.equal(find(broken, 'research-skill').state, 'bad');
  assert.equal(broken.overall.state, 'not_ready');
});

test('unclaimed engines stay inactive and never block the verdict', () => {
  const snap = snapshot({
    claimedTypes: ['ping', 'research.contact'],
    env: { LAB_URL: 'https://lab.example', LAB_TOKEN: 'token-value', PATH: '' },
    // The env fixture exists (core stays green) but no tool is installed.
    exists: (p) => p === '/fixtures/.env',
  });
  assert.equal(find(snap, 'chrome').severity, 'inactive', 'gmap.scan is not claimed, so Chrome is informational');
  assert.equal(find(snap, 'chrome').state, 'bad');
  assert.equal(find(snap, 'agy').severity, 'inactive');
  assert.equal(find(snap, 'fb-recon').severity, 'inactive');
  assert.equal(find(snap, 'ego-browser').severity, 'inactive');
  assert.equal(find(snap, 'pdftotext').severity, 'optional', 'claimed research makes PDF support optional-but-relevant');
  assert.equal(find(snap, 'pdftotext').state, 'warn');
  // Every optional gap here is a warn (reduced coverage), not a bad (broken) —
  // the device is genuinely ready for ping + research, just with less depth.
  // optional-bad → degraded is covered by the classifyOverall unit test.
  assert.equal(snap.overall.state, 'ready');
});

test('deep checks run through injected probes and inherit severity from the claim', async () => {
  const calls = [];
  const deep = await runDeepChecks({
    claimedTypes: ['research.contact'],
    probes: {
      broker: async () => { calls.push('broker'); return { state: 'ok', detail: '3 pending' }; },
      'pi-process': async () => { calls.push('pi'); return { state: 'ok', detail: 'pi 0.87.1' }; },
      'scrapling-mcp-process': async () => ({ state: 'warn', detail: 'MCP handshake failed at spawn' }),
      'obscura-mcp-process': async () => ({ state: 'warn', detail: 'known obscura 0.2.2 defect' }),
      'linkedin-session': async () => ({ state: 'ok', detail: 'LinkedIn session is valid' }),
    },
  });
  assert.deepEqual(calls.sort(), ['broker', 'pi'], 'only the instrumented probes record calls');
  const byId = Object.fromEntries(deep.checks.map((c) => [c.id, c]));
  assert.equal(byId['pi-process'].severity, 'required');
  assert.equal(byId['scrapling-mcp-process'].severity, 'optional');
  assert.equal(byId['linkedin-session'].state, 'ok');
  assert.equal(typeof deep.durationMs, 'number');
});

test('the provider caches the fast layer and merges deep into the combined verdict', async () => {
  let clock = 1_000;
  const now = () => clock;
  const status = createSetupStatus({
    lanes: [{ types: ['ping', 'research.contact'] }],
    env: { LAB_URL: 'https://lab.example', LAB_TOKEN: 'token-value', WORKER_NAME: 'box', PATH: '' },
    envFile: '/fixtures/.env',
    gsearchStatus: () => ({ listening: true, extension: { connected: true } }),
    resolveAgent: stubAgent(true),
    resolveSkill: stubSkill('/skills/research-contact'),
    exists: () => true,
    probes: {
      broker: async () => ({ state: 'ok', detail: 'fine' }),
      'pi-process': async () => ({ state: 'ok', detail: 'pi 0.87.1' }),
      'scrapling-mcp-process': async () => ({ state: 'ok', detail: '13 tools' }),
      'obscura-mcp-process': async () => ({ state: 'warn', detail: 'known obscura 0.2.2 defect' }),
      'linkedin-session': async () => ({ state: 'ok', detail: 'valid' }),
    },
    now,
  });

  assert.deepEqual(status.claimedTypes, ['ping', 'research.contact']);

  const first = status.get();
  clock += 100; // inside the fast TTL
  assert.equal(status.get(), first, 'the fast snapshot is cached between refreshes');
  clock += 5_000; // past the TTL
  assert.notEqual(status.get(), first);

  const withDeep = await status.getWithDeep();
  assert.ok(withDeep.deep, 'the deep result rides along');
  assert.ok(withDeep.deep.checks.length >= 3);
  assert.equal(withDeep.overall.state, 'ready', 'optional deep warnings do not block');
  const again = await status.getWithDeep();
  assert.equal(again.deep, withDeep.deep, 'the deep result is TTL-cached, not re-probed');
});
