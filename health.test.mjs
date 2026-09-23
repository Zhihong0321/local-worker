import { test } from 'node:test';
import assert from 'node:assert/strict';
import { health } from './health.mjs';

test('a non-Maps lane confirms its process without requiring database credentials', async () => {
  const result = await health({ database: false }, { configured: () => false });
  assert.equal(result.database, 'not_required');
});

test('a Maps lane fails if its database credentials are absent', async () => {
  await assert.rejects(health({ database: true }, { configured: () => false }), /not configured/);
});

test('a Maps lane checks connectivity and every write grant', async () => {
  const ok = { company_insert: true, company_update: true, report_insert: true, link_insert: true };
  const result = await health({ database: true }, { configured: () => true, sql: async () => ({ rows: [ok] }) });
  assert.equal(result.database, 'ok');
  await assert.rejects(health({ database: true }, { configured: () => true,
    sql: async () => ({ rows: [{ ...ok, link_insert: false }] }) }), /privilege/);
  await assert.rejects(health({ database: true }, { configured: () => true,
    sql: async () => { throw new Error('proxy token expired'); } }), /proxy token expired/);
});
