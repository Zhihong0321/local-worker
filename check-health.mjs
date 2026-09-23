#!/usr/bin/env node
// Ask the hub to run one targeted diagnostic job on every registered lane.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const localEnv = path.resolve('.env');
const envFile = process.env.WORKER_ENV_FILE || (fs.existsSync(localEnv) ? localEnv : path.join(os.homedir(), '.gmap-worker.env'));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const token = (process.env.LAB_TOKEN || '').trim();
if (!token) throw new Error('LAB_TOKEN is required');
const lab = (process.env.LAB_URL || 'https://ee-auto.up.railway.app').replace(/\/+$/, '');
const response = await fetch(lab + '/api/jobs/health-check', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({ waitMs: 15_000 }),
  signal: AbortSignal.timeout(45_000),
});
const report = await response.json();
if (!response.ok) throw new Error('Hub health check failed (' + response.status + '): ' + (report.error || 'unknown error'));
console.log('Hub database: ' + report.hub.database.status + (report.hub.database.error ? ' — ' + report.hub.database.error : ''));
for (const lane of report.workers) {
  console.log(lane.worker + ': ' + lane.status
    + (lane.result?.recovery ? ' (recovery: ' + lane.result.recovery + ')' : '')
    + (lane.error ? ' — ' + lane.error : '')
    + (lane.jobId ? ' [job ' + lane.jobId + ']' : ''));
}
if (report.hub.database.status !== 'ok' || report.workers.some((lane) => lane.status !== 'done')) process.exitCode = 1;
