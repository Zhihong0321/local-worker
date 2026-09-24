#!/usr/bin/env node
// Bootstrap installer + CLI mirror of the dashboard's /setup checklist.
//
// WHY NOT A DIST PACKAGE. The worker spans state that cannot be shipped: Chrome
// and its logins, the gsearch extension (manual Load unpacked), CLIs with their
// own credentials (pi, agy, ego-browser), a Python venv, and LinkedIn cookies.
// Bundling code would hide that state; this script instead automates the
// automatable (.env bootstrap, skill install), prints the exact manual steps for
// everything else, and finishes with the same checks the dashboard serves so
// "is this device ready" has one answer in both places.
//
// Usage:
//   node setup.mjs                 # bootstrap .env if missing, print manual steps, run checks
//   node setup.mjs --checks        # checks only (also what the dashboard /setup page serves)
//   node setup.mjs --install-skill # also install the research-contact skill into ~/.pi
//   node setup.mjs --deep          # additionally run the deep probes (spawns real processes)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSetupStatus, runDeepChecks } from './worker-setup.mjs';
import * as gsearch from './gsearch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- env loading

// Mirrors worker.mjs's .env resolution so the checklist judges the same
// configuration the running worker actually reads.
function loadEnvFile() {
  const local = path.join(HERE, '.env');
  const fallback = path.join(os.homedir(), '.gmap-worker.env');
  const file = existsSync(local) ? local : existsSync(fallback) ? fallback : null;
  if (file) {
    try { process.loadEnvFile(file); } catch {}
  }
  return file;
}

function claimedTypesFromEnv() {
  const pinned = (process.env.WORKER_TYPES ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (pinned.length) return pinned;
  // No pin: worker.mjs serves its default lane set. Keep in sync with LANES.
  return [
    'ping', 'gmap.scan',
    'chatgpt.ask', 'chatgpt.probe',
    'agy.ask', 'agy.probe',
    'fb.company', 'fb.person', 'fb.discover', 'fb.probe',
    'x.subject', 'x.company', 'x.probe',
    'ads.company', 'ads.market', 'ads.probe',
    'gsearch.search', 'gsearch.probe',
    'research.contact', 'research.probe',
  ];
}

// ------------------------------------------------------------------ bootstrap

function bootstrapEnv() {
  const target = path.join(HERE, '.env');
  const source = path.join(HERE, '.env.example');
  if (existsSync(target)) {
    console.log('[env] .env already exists — left untouched');
    return;
  }
  if (!existsSync(source)) {
    console.log('[env] no .env.example to copy from; create .env yourself');
    return;
  }
  copyFileSync(source, target);
  console.log('[env] created .env from .env.example');
  console.log('[env] >>> EDIT IT NOW: LAB_URL, LAB_TOKEN, WORKER_NAME, WORKER_TYPES <<<');
}

function installSkill() {
  const installer = path.join(HERE, 'scrapling-deep', 'agent-skill', 'research-contact', 'install.mjs');
  if (!existsSync(installer)) {
    console.log('[skill] research-contact installer not found at ' + installer);
    return;
  }
  console.log('[skill] running research-contact installer…');
  const run = spawnSync(process.execPath, [installer], { stdio: 'inherit', cwd: path.dirname(installer) });
  if (run.status !== 0) console.log('[skill] installer exited ' + run.status);
}

function printManualSteps() {
  const lines = [
    'Manual steps (cannot be automated — they need a human or a login):',
    '  1. Node.js >= 20                        https://nodejs.org/',
    '  2. Google Chrome                        https://www.google.com/chrome/ (or set CHROME_PATH)',
    '  3. gsearch extension                    Chrome → chrome://extensions → Developer mode →',
    '                                          Load unpacked → scrapling-deep/gsearch-extension',
    '  4. Pi CLI (research.contact)            npm install -g @earendil-works/pi-coding-agent',
    '                                          then sign in once: pi',
    '     Pi MCP bridge                       node install-pi-extension.mjs',
    '  5. Antigravity CLI (agy.*)              install + sign in, or set AGY_BIN',
    '  6. pdftotext (optional, PDFs)           install poppler-utils',
    '  7. LinkedIn channel (optional)          scrapling-deep/agent-skill/research-contact/INSTALL.md §3',
    '                                          re-login helper: ~/bin/linkedin-login.cmd',
    '  8. Scrapling venv (optional)            cd scrapling-deep && python -m venv .venv &&',
    '                                          .venv/Scripts/pip install "scrapling[all]" && scrapling install',
    '  9. Obscura (optional)                   set OBSCURA_BIN if installed outside D:/Tools/obscura',
    ' 10. ego-browser + spaces.json (chatgpt.*) install ego-browser; register profiles in ~/.gmap-worker',
    ' 11. gmap-recon (fb.*/x.*/ads.*)          clone gmap-recon beside this repo (~/project/gmap-recon)',
    '                                          needs claude + jq on PATH',
    ' 12. Start the worker                     start-worker.bat  (Windows)  ·  node worker.mjs',
    ' 13. Open the checklist in a browser      http://127.0.0.1:18788/setup',
    '',
  ];
  console.log(lines.join('\n'));
}

// ------------------------------------------------------------------- checks

const MARK = { ok: '✓', warn: '!', bad: '✗', unknown: '?' };

function printChecks(snapshot) {
  console.log('Claimed job types: ' + (snapshot.claimedTypes.join(', ') || '(none)'));
  for (const group of snapshot.groups) {
    const rows = snapshot.checks.filter((c) => c.group === group.id);
    if (!rows.length) continue;
    console.log('\n' + group.label);
    for (const c of rows) {
      const mark = MARK[c.state] ?? '?';
      const sev = c.severity === 'required' ? 'required' : c.severity === 'optional' ? 'optional ' : 'inactive ';
      console.log(`  ${mark} [${sev}] ${c.label}`);
      if (c.detail) console.log(`        ${c.detail}`);
      if (c.remediation && c.state !== 'ok') console.log(`        fix: ${c.remediation}`);
    }
  }
  console.log('');
  const overall = snapshot.overall;
  if (overall.state === 'ready') console.log('✔ Setup completed and healthy for the claimed work.');
  else {
    console.log(overall.state === 'not_ready' ? '✘ Setup incomplete:' : '⚠ Setup complete with warnings:');
    for (const reason of overall.reasons) console.log('   - ' + reason);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log('usage: node setup.mjs [--checks] [--install-skill] [--deep]');
    return;
  }

  if (!args.has('--checks')) {
    bootstrapEnv();
    if (args.has('--install-skill')) installSkill();
    printManualSteps();
  }

  loadEnvFile();
  const types = claimedTypesFromEnv();
  const status = createSetupStatus({
    lanes: [{ types }],
    gsearchStatus: () => gsearch.status(),
  });

  if (args.has('--deep')) {
    console.log('Running deep checks (spawns real processes; can take a few minutes)…\n');
    const deep = await runDeepChecks({
      claimedTypes: types,
      probes: { broker: async () => ({ state: 'unknown', detail: 'run via the dashboard, which owns the cloud cache' }) },
    });
    for (const c of deep.checks) {
      console.log(`  ${MARK[c.state] ?? '?'} [deep] ${c.label}: ${c.detail}`);
    }
    console.log('');
  }

  printChecks(status.get());
}

await main();
