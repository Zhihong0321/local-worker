#!/usr/bin/env node
// Restore completed broker answers from a saved snapshot after the report-write
// endpoint is deployed. Preview by default; --apply is the explicit write step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((arg) => arg !== '--apply');
if (!file) {
  console.error('usage: node replay-contact-recovery.mjs <snapshot.json> [--apply]');
  process.exit(2);
}
const snapshot = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
const jobs = (snapshot.jobs ?? []).filter((job) => job.type === 'research.contact'
  && job.status === 'done' && job.result && /^[a-f0-9]{12}$/.test(job.id));
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ mode: 'preview', completedAnswers: jobs.length,
    withPeople: jobs.filter((job) => (job.result.decision_makers?.length ?? 0) > 0).length }));
  process.exit(0);
}

const env = fs.existsSync('.env') ? '.env' : path.join(os.homedir(), '.gmap-worker.env');
if (fs.existsSync(env)) process.loadEnvFile(env);
const lab = (process.env.LAB_URL ?? 'https://ee-auto.up.railway.app').replace(/\/+$/, '');
const token = process.env.LAB_TOKEN;
if (!token) throw new Error('LAB_TOKEN is required');
let restored = 0;
const failed = [];
for (const job of jobs) {
  try {
    const response = await fetch(lab + '/api/jobs/' + job.id + '/result', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ worker: job.worker ?? 'recovery', reportId: job.payload?.reportId ?? null,
        ok: true, result: job.result, error: null }),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = await response.json();
    if (!response.ok || answer.saved !== true) throw new Error('HTTP ' + response.status + ': report was not confirmed saved');
    restored++;
  } catch (error) {
    failed.push({ jobId: job.id, error: error.message });
  }
}
console.log(JSON.stringify({ restored, failed }, null, 2));
if (failed.length) process.exitCode = 1;
