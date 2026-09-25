import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContactOutbox } from './contact-outbox.mjs';

test('a completed answer survives a failed post and replays after restart', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'contact-outbox-'));
  const receipt = { jobId: 'abcdef123456', reportId: '42', worker: 'pc', ok: true,
    result: { decision_makers: [{ name: 'Saved Person' }] }, error: null };
  try {
    const offline = createContactOutbox({ dir, post: async () => { throw new Error('hub offline'); } });
    assert.equal((await offline.deliver(receipt)).queued, true);
    assert.deepEqual(readdirSync(dir), ['abcdef123456.json']);
    const posted = [];
    const restarted = createContactOutbox({ dir, post: async (value) => { posted.push(value); } });
    assert.equal(await restarted.replay(), 1);
    assert.deepEqual(posted, [receipt]);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
