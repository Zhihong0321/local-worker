import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatus, redact } from './worker-status.mjs';

test('status tracks lane lifecycle and aggregate job timing', () => {
  let clock = 1_700_000_000_000;
  const status = createStatus({
    name: 'box',
    lab: 'https://lab.example',
    lanes: [{ suffix: '-a', types: ['ping'], session: 'session-a' }],
    now: () => clock,
  });
  status.lanePolling('box-a');
  status.jobStart('box-a', { id: 'job-1', type: 'ping', payload: { secret: 'do not store' } });
  clock += 1250;
  status.heartbeat('box-a');
  status.jobDone('box-a', { id: 'job-1', type: 'ping', ok: true, durationMs: 1250 });
  const snapshot = status.snapshot();

  assert.equal(snapshot.worker.name, 'box');
  assert.equal(snapshot.totals.jobsDone, 1);
  assert.equal(snapshot.totals.jobsFailed, 0);
  assert.equal(snapshot.totals.avgJobMs, 1250);
  assert.equal(snapshot.lanes[0].state, 'polling');
  assert.equal(snapshot.lanes[0].last.id, 'job-1');
  assert.equal(snapshot.lanes[0].last.ok, true);
  assert.equal(snapshot.lanes[0].current, null);
  assert.equal(JSON.stringify(snapshot).includes('do not store'), false);
});

test('status redacts exact secrets and credential-shaped values', () => {
  const text = redact('Bearer super-secret-token eyJabc123456.xxxxxxxxx.yyyyyyyyy token=another-secret', [
    'super-secret-token',
  ]);
  assert.equal(text.includes('super-secret-token'), false);
  assert.equal(text.includes('eyJabc123456'), false);
  assert.equal(text.includes('another-secret'), false);
  assert.match(text, /redacted/);
});

test('status keeps a bounded sanitized event feed and records backoff', () => {
  let clock = 1_700_000_000_000;
  const status = createStatus({ name: 'box', lab: 'lab', lanes: [{ suffix: '', types: ['ping'] }], now: () => clock });
  status.laneBackoff('box', { error: 'password=top-secret', retryMs: 5000 });
  const snapshot = status.snapshot();
  assert.equal(snapshot.lanes[0].state, 'backoff');
  assert.equal(snapshot.lanes[0].nextPollAt, new Date(clock + 5000).toISOString());
  assert.equal(snapshot.lanes[0].lastError.includes('top-secret'), false);
  assert.equal(snapshot.events[0].message.includes('top-secret'), false);
});

test('quota cooldown is a visible lane state with a decreasing reset timer', () => {
  let clock = 1_700_000_000_000;
  const status = createStatus({ name: 'windows-pc-1', lab: 'lab',
    lanes: [{ suffix: '-agy1', types: ['agy.ask'] }, { suffix: '-agy2', types: ['agy.ask'] }],
    now: () => clock });
  const until = new Date(clock + 5_825_000).toISOString();
  for (const lane of ['windows-pc-1-agy1', 'windows-pc-1-agy2']) {
    status.laneCooldown(lane, { until: Date.parse(until), reason: 'Individual quota reached' });
  }
  const first = status.snapshot();
  assert.equal(first.totals.cooldown, 2);
  assert.ok(first.lanes.every((lane) => lane.state === 'cooldown'));
  assert.ok(first.lanes.every((lane) => lane.cooldownUntil === until));
  assert.ok(first.lanes.every((lane) => lane.cooldownReason === 'Individual quota reached'));
  clock += 60_000;
  assert.equal(status.snapshot().lanes[0].cooldownRemainingMs, 5_765_000);
  clock += 5_765_000;
  status.lanePolling('windows-pc-1-agy1');
  assert.equal(status.snapshot().lanes[0].state, 'polling');
  assert.equal(status.snapshot().lanes[0].cooldownUntil, null);
});
