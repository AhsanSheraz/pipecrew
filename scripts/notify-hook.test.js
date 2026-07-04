#!/usr/bin/env node
'use strict';
/**
 * Unit tests for notify-hook.js pure helpers (classifyMessage, extractPreview).
 * Zero deps, plain assert. Run: node scripts/notify-hook.test.js
 */
const assert = require('assert');
const { classifyMessage, extractPreview } = require('./notify-hook.js');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

ok('classifyMessage — permission/approval prompts are waits (not skipped)', () => {
  for (const m of [
    'Claude needs your permission to use Bash',
    'Approve these changes?',
    'Claude is waiting for your input',
    'Claude needs you to respond',
  ]) {
    const c = classifyMessage(m);
    assert.strictEqual(c.looksWaiting, true, m);
    assert.strictEqual(c.skip, false, m);
  }
});

ok('classifyMessage — pure informational pings are skipped', () => {
  for (const m of ['Task completed', 'Build succeeded', 'All set — done']) {
    const c = classifyMessage(m);
    assert.strictEqual(c.skip, true, m);
  }
});

ok('classifyMessage — empty/unknown falls through to NOT-skip (never miss a wait)', () => {
  assert.strictEqual(classifyMessage('').skip, false);
  assert.strictEqual(classifyMessage(null).skip, false);
  assert.strictEqual(classifyMessage('some unrecognized text').skip, false);
});

ok('classifyMessage — a message that is both informational AND a wait is NOT skipped', () => {
  // "review completed items — approve?" contains both hints; wait wins.
  const c = classifyMessage('Review completed items and approve');
  assert.strictEqual(c.skip, false);
});

ok('extractPreview — Bash command', () => {
  const p = extractPreview({ tool_name: 'Bash', tool_input: { command: 'mvn test' }, message: 'needs permission' });
  assert.strictEqual(p.tool, 'Bash');
  assert.strictEqual(p.command_preview, 'mvn test');
  assert.strictEqual(p.message, 'needs permission');
});

ok('extractPreview — Edit/Write file_path', () => {
  const p = extractPreview({ tool_name: 'Write', tool_input: { file_path: '/repo/src/App.tsx' } });
  assert.strictEqual(p.tool, 'Write');
  assert.strictEqual(p.command_preview, '/repo/src/App.tsx');
});

ok('extractPreview — tolerates junk', () => {
  assert.doesNotThrow(() => extractPreview(null));
  assert.doesNotThrow(() => extractPreview('a string'));
  const p = extractPreview({});
  assert.strictEqual(p.tool, null);
});

console.log(`\n${passed} tests passed.`);
