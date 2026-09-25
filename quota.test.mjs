import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaCooldownMs } from './quota.mjs';

test('the actual AGY quota error yields the reset delay', () => {
  const error = 'Error: error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h22m51s. at ask (file:///E:/000/local-worker/agy.mjs:115:25)';
  assert.equal(quotaCooldownMs(error), 15_776_000);
  assert.equal(quotaCooldownMs('Individual quota reached'), 3_605_000);
  assert.equal(quotaCooldownMs('Pi error: 429 {"error":{"type":"rate_limit_error","message":"Token Plan usage limit"}}'), 3_605_000);
  assert.equal(quotaCooldownMs('fetch failed'), null);
});
