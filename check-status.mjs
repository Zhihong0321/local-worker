#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (e) {
    // Ignore error
  }
}

const LAB = (process.env.LAB_URL ?? 'https://ee-auto.up.railway.app').replace(/\/+$/, '');
const TOKEN = (process.env.LAB_TOKEN ?? '').trim();
const WORKER_NAME = (process.env.WORKER_NAME ?? 'windows-pc-1').trim();

console.log('========================================================');
console.log(`  Cloud Hub Status Check: ${LAB}`);
console.log('========================================================\n');

try {
  const headers = {};
  if (TOKEN) headers['authorization'] = `Bearer ${TOKEN}`;

  const res = await fetch(`${LAB}/api/jobs`, { headers });
  if (!res.ok) {
    console.error(`[ERROR] Cloud hub returned status ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const data = await res.json();
  const now = Date.now();

  console.log(`[Summary] Pending: ${data.counts?.pending ?? 0} | Running: ${data.counts?.running ?? 0} | Waiting Workers: ${data.waiting ?? 0}\n`);

  console.log('Connected Workers:');
  console.log('--------------------------------------------------------------------------------');
  console.log(
    'Worker Name'.padEnd(25) +
    'Status'.padEnd(12) +
    'Last Seen'.padEnd(14) +
    'IP'.padEnd(18) +
    'Types'
  );
  console.log('--------------------------------------------------------------------------------');

  const workers = data.workers ?? [];
  let foundLocal = false;

  for (const w of workers) {
    const elapsedSec = Math.round((now - Date.parse(w.lastSeenAt)) / 1000);
    const isLive = elapsedSec <= 90;
    const isLocal = w.name === WORKER_NAME || w.name.startsWith(`${WORKER_NAME}-`);
    if (isLocal) foundLocal = true;

    const prefix = isLocal ? '>> ' : '   ';
    const statusText = isLive ? 'ONLINE' : 'STALE';
    const timeText = elapsedSec < 60 ? `${elapsedSec}s ago` : `${Math.floor(elapsedSec / 60)}m ago`;
    const typesText = (w.types ?? []).join(', ');

    console.log(
      `${prefix}${w.name}`.padEnd(25) +
      statusText.padEnd(12) +
      timeText.padEnd(14) +
      (w.ip ?? 'unknown').padEnd(18) +
      typesText
    );
  }

  console.log('--------------------------------------------------------------------------------');
  if (foundLocal) {
    console.log(`\n[SUCCESS] The Cloud Hub recognizes worker "${WORKER_NAME}"!`);
  } else {
    console.log(`\n[INFO] Worker "${WORKER_NAME}" has not checked in recently or worker is not currently running.`);
  }
} catch (err) {
  console.error(`[ERROR] Failed to reach Cloud Hub: ${err.message}`);
}
