import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REMOTES = new Set([
  'https://github.com/Zhihong0321/local-worker.git',
  'https://github.com/Zhihong0321/local-worker',
  'git@github.com:Zhihong0321/local-worker.git',
]);
const SHA = /^[a-f0-9]{40}$/i;

async function git(args) {
  const { stdout } = await execFileAsync('git', ['-C', ROOT, ...args], {
    timeout: args[0] === 'fetch' ? 120_000 : 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

/** Prevent two worker processes sharing one checkout from updating it together. */
async function withUpdateLock(action) {
  const name = crypto.createHash('sha256').update(ROOT.toLowerCase()).digest('hex').slice(0, 20);
  const file = path.join(os.tmpdir(), 'local-worker-update-' + name + '.lock');
  const deadline = Date.now() + 120_000;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(file, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 10 * 60_000) {
        await fs.unlink(file).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) throw new Error('another worker process is updating this checkout; retry later');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  try {
    await handle.writeFile(String(process.pid));
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(file).catch(() => {});
  }
}

/** Fetch only the trusted main branch, pin it to the hub's SHA, and fast-forward. */
export async function updateWorker(payload, { runGit = git, waitForIdle = async () => {}, lock = withUpdateLock, bootCommit = null } = {}) {
  const target = String(payload?.commit ?? '').trim().toLowerCase();
  if (!SHA.test(target)) throw new Error('worker.update requires a 40-character main-branch commit SHA');
  const remote = await runGit(['remote', 'get-url', 'origin']);
  if (!REMOTES.has(remote)) throw new Error('worker update refused: origin is not the approved local-worker repository');
  const branch = await runGit(['branch', '--show-current']);
  if (branch !== 'main') throw new Error('worker update refused: checkout is not on main');

  // No file from the new commit is installed while another lane is running a job.
  await waitForIdle();
  return lock(async () => {
    const dirty = await runGit(['status', '--porcelain', '--untracked-files=no']);
    if (dirty) throw new Error('worker update refused: tracked local changes must be reviewed before updating');
    await runGit(['fetch', '--no-tags', 'origin', 'refs/heads/main']);
    const fetched = (await runGit(['rev-parse', 'FETCH_HEAD'])).toLowerCase();
    if (fetched !== target) throw new Error('worker update refused: main changed after the hub pinned its commit; trigger again');
    const before = (await runGit(['rev-parse', 'HEAD'])).toLowerCase();
    if (before !== target) {
      try {
        await runGit(['merge-base', '--is-ancestor', before, target]);
      } catch {
        throw new Error('worker update refused: local history diverged from main');
      }
      await runGit(['merge', '--ff-only', target]);
    }
    const after = (await runGit(['rev-parse', 'HEAD'])).toLowerCase();
    if (after !== target) throw new Error('worker update did not reach the pinned commit');
    return { status: before === target ? 'current' : 'updated', before, after,
      restartRequired: bootCommit !== null && bootCommit.toLowerCase() !== target };
  });
}

export async function currentCommit() {
  try { return await git(['rev-parse', 'HEAD']); } catch { return null; }
}
