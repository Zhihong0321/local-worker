import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Run inside a targeted lane; the hub probes its own database separately. */
export async function health(payload = {}) {
  const result = {
    hostname: os.hostname(),
    pid: process.pid,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    at: new Date().toISOString(),
    recovery: 'not_required',
  };
  if (!payload?.recovery) return result;
  const directory = process.env.WORKER_RECOVERY_DIR || path.join(os.homedir(), '.gmap-worker', 'unsaved-scans');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, '.health-' + process.pid + '-' + Date.now());
  try {
    fs.writeFileSync(file, 'ok', { flag: 'wx', mode: 0o600 });
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  result.recovery = 'ok';
  return result;
}
