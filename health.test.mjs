import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { health } from './health.mjs';

test('a non-Maps lane confirms its process without local storage', async () => {
  const result = await health({ recovery: false });
  assert.equal(result.recovery, 'not_required');
});

test('a Maps lane verifies its local recovery directory is writable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-health-'));
  const previous = process.env.WORKER_RECOVERY_DIR;
  process.env.WORKER_RECOVERY_DIR = directory;
  try {
    const result = await health({ recovery: true });
    assert.equal(result.recovery, 'ok');
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    if (previous === undefined) delete process.env.WORKER_RECOVERY_DIR;
    else process.env.WORKER_RECOVERY_DIR = previous;
    fs.rmdirSync(directory);
  }
});
