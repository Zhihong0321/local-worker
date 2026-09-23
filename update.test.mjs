import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateWorker } from './update.mjs';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const approved = 'https://github.com/Zhihong0321/local-worker.git';

function fixture({ remote = approved, branch = 'main', dirty = '', fetched = NEW, head = OLD } = {}) {
  const commands = [];
  let current = head;
  const runGit = async (args) => {
    commands.push(args.join(' '));
    switch (args[0]) {
      case 'remote': return remote;
      case 'branch': return branch;
      case 'status': return dirty;
      case 'fetch': return '';
      case 'rev-parse': return args[1] === 'FETCH_HEAD' ? fetched : current;
      case 'merge-base': return '';
      case 'merge': current = args[2]; return '';
      default: throw new Error('unexpected git command: ' + args.join(' '));
    }
  };
  return { commands, runGit, waitForIdle: async () => {}, lock: async (action) => action(), bootCommit: head };
}

test('OTA accepts only a pinned SHA from the approved main branch', async () => {
  await assert.rejects(updateWorker({ commit: 'main' }, fixture()), /40-character/);
  await assert.rejects(updateWorker({ commit: NEW }, fixture({ remote: 'https://example.com/other.git' })), /approved/);
  await assert.rejects(updateWorker({ commit: NEW }, fixture({ branch: 'feature' })), /not on main/);
  await assert.rejects(updateWorker({ commit: NEW }, fixture({ fetched: OLD })), /main changed/);
});

test('OTA refuses to overwrite tracked local edits', async () => {
  const worker = fixture({ dirty: ' M worker.mjs' });
  await assert.rejects(updateWorker({ commit: NEW }, worker), /tracked local changes/);
  assert.equal(worker.commands.some((command) => command.startsWith('fetch ')), false);
});

test('OTA fast-forwards to the pinned commit and asks the supervisor to restart', async () => {
  const worker = fixture();
  const result = await updateWorker({ commit: NEW }, worker);
  assert.deepEqual(result, { status: 'updated', before: OLD, after: NEW, restartRequired: true });
  assert.ok(worker.commands.includes('merge --ff-only ' + NEW));
});

test('OTA is idempotent when checkout and process already run the target', async () => {
  const worker = fixture({ head: NEW });
  const result = await updateWorker({ commit: NEW }, worker);
  assert.equal(result.status, 'current');
  assert.equal(result.restartRequired, false);
  assert.equal(worker.commands.some((command) => command.startsWith('merge ')), false);
});
