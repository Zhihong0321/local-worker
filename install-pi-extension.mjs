#!/usr/bin/env node
// Install the bundled MCP bridge into Pi without copying local node_modules.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(root, 'scrapling-deep', 'agent-skill', 'mcp-bridge');
const destination = path.join(os.homedir(), '.pi', 'agent', 'extensions', 'mcp-bridge');
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

if (!existsSync(path.join(source, 'index.ts')) || !existsSync(path.join(source, 'package-lock.json'))) {
  throw new Error(`MCP bridge source is incomplete: ${source}`);
}
console.log(`source: ${source}`);
console.log(`destination: ${destination}`);
if (dryRun) {
  console.log(`existing installation: ${existsSync(destination) ? 'yes' : 'no'}`);
  process.exit(0);
}
if (existsSync(destination) && !force) {
  throw new Error('Pi already has an mcp-bridge extension. Inspect it, then rerun with --force to replace it.');
}

if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
mkdirSync(path.dirname(destination), { recursive: true });
cpSync(source, destination, {
  recursive: true,
  filter: (entry) => !entry.split(path.sep).some((part) => part === 'node_modules' || part === '.git'),
});

const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm ci --omit=dev']
  : ['ci', '--omit=dev'];
const installed = spawnSync(command, args, { cwd: destination, stdio: 'inherit' });
if (installed.error) throw installed.error;
if (installed.status !== 0) throw new Error(`npm ci failed with exit ${installed.status}`);
console.log('MCP bridge installed. Restart Pi and the worker to load it.');
