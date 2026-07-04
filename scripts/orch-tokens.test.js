#!/usr/bin/env node
'use strict';
/** Unit tests for orch-tokens.js. Zero deps, plain assert. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { orchFromLines, resolveSessionJsonl, readSessionIdFromRunDir } = require('./orch-tokens.js');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

ok('orchFromLines sums assistant usage; ignores non-assistant + agent transcripts', () => {
  const lines = [
    { type: 'user', message: { role: 'user', content: 'hi' } },              // ignored
    { type: 'assistant', message: { usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000 } } },
    { type: 'assistant', message: { usage: { input_tokens: 400, output_tokens: 120, cache_creation_input_tokens: 10 } } },
    { type: 'assistant', message: {} },                                       // no usage → skipped
    { type: 'file-history-snapshot' },                                        // ignored
  ];
  const t = orchFromLines(lines);
  assert.strictEqual(t.input, 1400);
  assert.strictEqual(t.output, 320);
  assert.strictEqual(t.cacheCreate, 60);
  assert.strictEqual(t.cacheRead, 9000);
  assert.strictEqual(t.assistantTurns, 2);
  assert.strictEqual(t.total, 1400 + 320 + 60);   // cache-read excluded from headline
});

ok('orchFromLines tolerates junk', () => {
  assert.doesNotThrow(() => orchFromLines(null));
  assert.doesNotThrow(() => orchFromLines([null, 1, 'x', {}]));
  assert.strictEqual(orchFromLines([]).total, 0);
});

ok('resolveSessionJsonl finds {id}.jsonl under projects dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  const proj = path.join(tmp, 'C--demo');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'sess-123.jsonl'), '{}\n');
  assert.strictEqual(resolveSessionJsonl('sess-123', tmp), path.join(proj, 'sess-123.jsonl'));
  assert.strictEqual(resolveSessionJsonl('missing', tmp), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

ok('readSessionIdFromRunDir reads run_start.session_id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchrun-'));
  fs.writeFileSync(path.join(tmp, 'checkpoints.jsonl'),
    JSON.stringify({ event: 'run_start', session_id: 'abc-999' }) + '\n' +
    JSON.stringify({ event: 'phase_start', phase: '1' }) + '\n');
  assert.strictEqual(readSessionIdFromRunDir(tmp), 'abc-999');
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(readSessionIdFromRunDir('/no/such/dir'), null);
});

console.log(`\n${passed} tests passed.`);
