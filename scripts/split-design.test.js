#!/usr/bin/env node
/**
 * Unit tests for split-design.js.
 * Zero deps: run with `node split-design.test.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'split-design.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'split-design-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

let counter = 0;
function writeFixture(content) {
  const filePath = path.join(TMP, `case-${counter++}.md`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function run(filePath, outDir) {
  const args = outDir ? [SCRIPT, filePath, outDir] : [SCRIPT, filePath];
  const r = spawnSync('node', args, { encoding: 'utf8' });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// -------- Happy path --------

test('writes one file per JSON-fenced block, lowercased + dashed', () => {
  const md = [
    '<!-- BEGIN AFFECTED_SERVICES -->',
    '```json', '{"services":[]}', '```',
    '<!-- END AFFECTED_SERVICES -->',
    '<!-- BEGIN API_DESIGN -->',
    '```json', '{"endpoints":[]}', '```',
    '<!-- END API_DESIGN -->',
  ].join('\n');
  const fixture = writeFixture(md);
  const outDir = path.join(TMP, `out-${counter}`);
  const r = run(fixture, outDir);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  assert(fs.existsSync(path.join(outDir, 'affected-services.json')), 'affected-services.json missing');
  assert(fs.existsSync(path.join(outDir, 'api-design.json')), 'api-design.json missing');
  const summary = JSON.parse(r.stdout);
  assert(summary.written.length === 2, 'written count mismatch');
});

test('skips prose-only blocks silently', () => {
  const md = [
    '<!-- BEGIN ARCHITECTURE_DECISION -->',
    'Just prose. No fence.',
    '<!-- END ARCHITECTURE_DECISION -->',
    '<!-- BEGIN DATA_MODEL -->',
    '```json', '{"entities":[]}', '```',
    '<!-- END DATA_MODEL -->',
  ].join('\n');
  const outDir = path.join(TMP, `out-${counter}`);
  const r = run(writeFixture(md), outDir);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  assert(fs.existsSync(path.join(outDir, 'data-model.json')));
  assert(!fs.existsSync(path.join(outDir, 'architecture-decision.json')), 'should not write prose-only block');
  const summary = JSON.parse(r.stdout);
  assert(summary.skipped_prose_only.includes('ARCHITECTURE_DECISION'));
});

test('default output dir is <input-dir>/blocks/', () => {
  const md = '<!-- BEGIN X -->\n```json\n{"k":1}\n```\n<!-- END X -->';
  const fixture = writeFixture(md);
  const r = run(fixture);
  assert(r.exitCode === 0, `exit ${r.exitCode}; stderr: ${r.stderr}`);
  assert(fs.existsSync(path.join(path.dirname(fixture), 'blocks', 'x.json')));
});

test('idempotent — running twice produces same output', () => {
  const md = '<!-- BEGIN AFFECTED_SERVICES -->\n```json\n{"services":[{"name":"a"}]}\n```\n<!-- END AFFECTED_SERVICES -->';
  const fixture = writeFixture(md);
  const outDir = path.join(TMP, `out-idem-${counter}`);
  run(fixture, outDir);
  const first = fs.readFileSync(path.join(outDir, 'affected-services.json'), 'utf8');
  run(fixture, outDir);
  const second = fs.readFileSync(path.join(outDir, 'affected-services.json'), 'utf8');
  assert(first === second, 'second run produced different content');
});

// -------- Error paths --------

test('exit 3 on JSON parse error', () => {
  const md = '<!-- BEGIN X -->\n```json\n{ broken json\n```\n<!-- END X -->';
  const r = run(writeFixture(md), path.join(TMP, `out-err-${counter}`));
  assert(r.exitCode === 3, `expected 3, got ${r.exitCode}`);
});

test('exit 1 on missing input', () => {
  const r = run(path.join(TMP, 'does-not-exist.md'), path.join(TMP, `out-${counter}`));
  assert(r.exitCode === 1, `expected 1, got ${r.exitCode}`);
});

test('exit 2 on missing args', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert(r.status === 2, `expected 2, got ${r.status}`);
});

// Cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
