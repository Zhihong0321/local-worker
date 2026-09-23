// The scan's one rule, tested without needing Google to misbehave on cue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, saveRecoveryCopy } from './gmap.mjs';

const page = (over = {}) => ({
  feedPresent: true,
  signals: { captcha: false, consent: false, limitedView: false, signedIn: true, ...(over.signals ?? {}) },
  ...over,
});
const list = (n) => Array.from({ length: n }, (_, i) => ({ name: 'biz ' + i }));

test('a hub-owned scan leaves a replayable worker recovery copy', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmap-recovery-test-'));
  const previous = process.env.WORKER_RECOVERY_DIR;
  process.env.WORKER_RECOVERY_DIR = directory;
  let file;
  try {
    file = saveRecoveryCopy({ businesses: [{ name: 'Example Shop' }], saveError: 'proxy expired' }, { reportPublicId: 'abcdefghijklmnopqrst' }, { id: 'job/1' });
    assert.equal(path.dirname(file), directory);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.reportPublicId, 'abcdefghijklmnopqrst');
    assert.equal(saved.jobId, 'job/1');
    assert.equal(saved.scan.businesses[0].name, 'Example Shop');
  } finally {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
    if (previous === undefined) delete process.env.WORKER_RECOVERY_DIR;
    else process.env.WORKER_RECOVERY_DIR = previous;
  }
});

test('an empty feed is blocked with a null count, never found: 0', () => {
  const r = classify(page(), [], 50);
  assert.equal(r.found, null, 'found must be null, not 0');
  assert.equal(r.blocked, true);
  assert.match(r.blockedReason, /soft block/);
});

test('a missing feed is blocked and named as such', () => {
  const r = classify(page({ feedPresent: false }), [], 50);
  assert.equal(r.found, null);
  assert.equal(r.blockedReason, 'no results feed');
});

test('captcha and consent are reported distinctly, results discarded', () => {
  assert.equal(classify(page({ signals: { captcha: true } }), list(9), 50).blockedReason, 'captcha');
  assert.equal(classify(page({ signals: { consent: true } }), list(9), 50).blockedReason, 'consent wall');
  // Results present but the page is compromised: the count is still withheld.
  assert.equal(classify(page({ signals: { captcha: true } }), list(9), 50).found, null);
});

test('a real result set counts, and caps only at the limit', () => {
  const ok = classify(page(), list(12), 50);
  assert.deepEqual([ok.found, ok.blocked, ok.capped], [12, false, false]);
  assert.equal(classify(page(), list(50), 50).capped, true);
});

test('a blocked scan is never also capped', () => {
  assert.equal(classify(page({ feedPresent: false }), [], 0).capped, false);
});

test('limitedView is carried through, and is not itself a block', () => {
  const r = classify(page({ signals: { limitedView: true, signedIn: false } }), list(30), 50);
  assert.equal(r.limitedView, true);
  assert.equal(r.blocked, false);
  assert.equal(r.found, 30);
});

// The failure this file did not cover: a keyword specific enough to name one
// business gets no feed at all, because Maps redirects to that place's own card.
// It was scored as a block and published as an empty report.
test('a place card with no feed is a reading, not a block', () => {
  const r = classify(page({ feedPresent: false, placeCard: true }), list(1), 10);
  assert.equal(r.blocked, false);
  assert.equal(r.found, 1);
  assert.equal(r.blockedReason, null);
  assert.equal(r.capped, false);
});

test('a place card that read nothing is still a block', () => {
  const r = classify(page({ feedPresent: false, placeCard: false }), [], 10);
  assert.equal(r.blocked, true);
  assert.equal(r.found, null);
  assert.equal(r.blockedReason, 'no results feed');
});

test('a captcha over a place card still blocks', () => {
  const r = classify(page({ feedPresent: false, placeCard: true, signals: { captcha: true } }), list(1), 10);
  assert.equal(r.blocked, true);
  assert.equal(r.blockedReason, 'captcha');
});
