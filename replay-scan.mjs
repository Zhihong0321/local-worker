#!/usr/bin/env node
// Restore one unsaved Google Maps worker result to its existing public report.
// Uses the lab's database connection; it never opens Google Maps again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const localEnv = path.resolve('.env');
const envFile = process.env.WORKER_ENV_FILE || (fs.existsSync(localEnv) ? localEnv : path.join(os.homedir(), '.gmap-worker.env'));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const file = process.argv[2];
if (!file) {
  console.error('Usage: node worker/replay-scan.mjs /path/to/unsaved-scans/JOB_ID.json');
  process.exit(2);
}
const recovery = JSON.parse(fs.readFileSync(file, 'utf8'));
const publicId = String(recovery.reportPublicId || '');
const scan = recovery.scan;
if (!/^[A-Za-z0-9_-]{20}$/.test(publicId) || !scan || !Array.isArray(scan.businesses)) {
  console.error('Recovery file has no valid report id or business list. Keep the file for investigation.');
  process.exit(2);
}
const token = (process.env.LAB_TOKEN || '').trim();
if (!token) {
  console.error('LAB_TOKEN is required to restore a worker recovery copy.');
  process.exit(2);
}
const lab = (process.env.LAB_URL || 'https://ee-auto.up.railway.app').replace(/\/+$/, '');
const response = await fetch(`${lab}/api/reports/${publicId}/repair`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ snapshot: {
    search: scan,
    companies: scan.businesses,
    scan_metadata: { save_error: scan.saveError || null, restored_from_worker: true },
  } }),
  signal: AbortSignal.timeout(120_000),
});
const body = await response.json();
if (!response.ok) {
  console.error(`Repair failed (${response.status}): ${body.error || 'unknown error'}. Recovery file kept: ${file}`);
  process.exitCode = 1;
} else {
  console.log(`Repaired ${publicId}: ${body.saved?.linked ?? 0} businesses linked. Recovery file kept: ${file}`);
}
