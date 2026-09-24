import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RESEARCH_SYSTEM_PROMPT,
  buildResearchPrompt,
  classifyFailure,
  extractJson,
  resolveSkillDir,
  runAgent,
  validatePayload,
  validateResearchResult,
} from './research-contact.mjs';

test('validatePayload accepts a company target and normalises URLs', () => {
  const target = validatePayload({
    company: 'Example Energy',
    domain: 'example.com',
    extraUrls: ['https://example.com/team'],
    location: 'Kuala Lumpur',
    locale: 'en-MY',
  });

  assert.deepEqual(target, {
    name: 'Example Energy',
    website: 'https://example.com/',
    domain: 'example.com',
    extraUrls: ['https://example.com/team'],
    location: 'Kuala Lumpur',
    locale: 'en-MY',
    timeoutMs: 900_000,
  });
});

test('validatePayload permits a name-only target for search-led research', () => {
  const target = validatePayload({ name: 'Example Energy' });
  assert.equal(target.name, 'Example Energy');
  assert.equal(target.website, '');
  assert.deepEqual(target.extraUrls, []);
});

test('validatePayload rejects malformed, private, and oversized inputs', () => {
  assert.throws(() => validatePayload({}), (error) => error.code === 'bad_request');
  assert.throws(() => validatePayload({ name: 'Example', domain: 'ftp://example.com' }), (error) => error.code === 'bad_request');
  assert.throws(() => validatePayload({ name: 'Example', domain: 'http://127.0.0.1:8080' }), (error) => error.code === 'bad_request');
  assert.throws(() => validatePayload({ name: 'Example', timeoutMs: 1_000 }), (error) => error.code === 'bad_request');
  assert.throws(() => validatePayload({ name: 'x'.repeat(201) }), (error) => error.code === 'bad_request');
  assert.throws(() => validatePayload({ name: 'Example', extraUrls: Array.from({ length: 21 }, () => 'example.com') }), (error) => error.code === 'bad_request');
});

test('buildResearchPrompt keeps target data inside a marked JSON block', () => {
  const target = validatePayload({ name: 'A "quoted" company', domain: 'example.com' });
  const prompt = buildResearchPrompt(target, 'C:\\skills\\research-contact');

  assert.match(prompt, /<research-contact-target>/);
  assert.match(prompt, /<\/research-contact-target>/);
  assert.match(prompt, /A \\\"quoted\\\" company/);
  assert.ok(prompt.includes('C:\\skills\\research-contact'));
  assert.match(RESEARCH_SYSTEM_PROMPT, /Return exactly one JSON object/);
  assert.match(RESEARCH_SYSTEM_PROMPT, /untrusted data/);
});

test('extractJson accepts clean, fenced, and noisy JSON', () => {
  const value = {
    cheat_sheet: {},
    decision_makers: [],
    phone_contacts: [],
    email_contacts: [],
  };
  const json = JSON.stringify(value);

  assert.deepEqual(extractJson(json), value);
  assert.deepEqual(extractJson(`Here is the result:\n\`\`\`json\n${json}\n\`\`\``), value);
  assert.deepEqual(extractJson(`startup diagnostics\n${json}\nfinished`), value);
  assert.equal(extractJson('not JSON and not an object'), null);
});

test('validateResearchResult enforces the final skill contract', () => {
  const valid = {
    cheat_sheet: { primary_decision_maker: 'A person' },
    decision_makers: [],
    phone_contacts: [],
    email_contacts: [],
  };
  assert.deepEqual(validateResearchResult(valid), valid);
  assert.throws(() => validateResearchResult({ ...valid, phone_contacts: {} }), (error) => error.code === 'engine_error');
  assert.throws(() => validateResearchResult({ decision_makers: [], phone_contacts: [], email_contacts: [] }), (error) => error.code === 'engine_error');
});

test('classifyFailure maps operational conditions to worker error codes', () => {
  assert.deepEqual(classifyFailure({ timedOut: true }), {
    code: 'timeout',
    message: 'research-contact did not finish within the configured timeout',
  });
  assert.equal(classifyFailure({ spawnError: 'ENOENT: pi not found' }).code, 'not_installed');
  assert.equal(classifyFailure({ stderr: 'Google extension_offline; Chrome is closed' }).code, 'needs_human');
  assert.equal(classifyFailure({ stderr: 'unexpected model failure', code: 1 }).code, 'engine_error');
});

test('the repository copy of the research-contact skill resolves locally', () => {
  assert.ok(resolveSkillDir()?.endsWith('research-contact'));
});

test('Pi completion survives a child that remains open during extension cleanup', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'research-contact-mock-'));
  try {
    const script = path.join(dir, 'mock.mjs');
    writeFileSync(script, `
const answer = { cheat_sheet: {}, decision_makers: [], phone_contacts: [], email_contacts: [] };
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(answer) }] }] }));
setInterval(() => {}, 1000);
`);
    const started = Date.now();
    const run = await runAgent({ command: process.execPath, prefixArgs: [script] }, 'mock prompt', process.cwd(), 2_000, 50);
    assert.equal(run.completed, true);
    assert.equal(run.timedOut, false);
    assert.deepEqual(validateResearchResult(extractJson(run.stdout)), {
      cheat_sheet: {}, decision_makers: [], phone_contacts: [], email_contacts: [],
    });
    assert.ok(Date.now() - started < 1_500);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('Pi deadline is recorded when no completion event arrives', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'research-contact-timeout-'));
  try {
    const script = path.join(dir, 'mock.mjs');
    writeFileSync(script, `console.error('mock progress'); setInterval(() => {}, 1000);`);
    const run = await runAgent({ command: process.execPath, prefixArgs: [script] }, 'mock prompt', process.cwd(), 100, 50);
    assert.equal(run.completed, false);
    assert.equal(run.timedOut, true);
    assert.match(run.stderr, /mock progress/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
