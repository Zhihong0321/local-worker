import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Avoid depending on a real ~/.gmap-worker/spaces.json in a syntax-only test.
process.env.META_SPACE = '1';
const { buildAskScript, buildProbeScript } = await import('./meta-ego.mjs');

function syntax(script) {
  return spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: script,
    encoding: 'utf8',
  });
}

test('generated Meta ask script is valid JavaScript for arbitrary prompt text', () => {
  const prompt = 'line 1\n"quoted" ${notInterpolation} `backticks`';
  const script = buildAskScript({ id: 'meta-main', prompt, timeoutMs: 1234 });
  const checked = syntax(script);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(script, /region_blocked/);
  assert.match(script, /composer-send-button/);
});

test('generated Meta probe script is valid and distinguishes the region gate', () => {
  const script = buildProbeScript({ id: 'meta-main' });
  const checked = syntax(script);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(script, /region_blocked/);
  assert.match(script, /www\.meta\.ai/);
});
