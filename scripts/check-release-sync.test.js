#!/usr/bin/env node
/**
 * Unit tests for check-release-sync.js.
 * Zero deps: run with `node check-release-sync.test.js`.
 *
 * Drives the pure check() / parseChangelogVersion() cores directly (where the
 * drift logic lives), plus the CLI via the --input=<bundle.json> hook to cover
 * exit codes without touching real git/plugin.json/CHANGELOG.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { check, parseChangelogVersion } = require('./check-release-sync.js');

const SCRIPT = path.join(__dirname, 'check-release-sync.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-release-sync-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

// --- parseChangelogVersion ---
test('parses the newest version heading', () => {
  assert.strictEqual(
    parseChangelogVersion('# Changelog\n\n## [1.6.1] - 2026-08-29\n\n## [1.6.0] - 2026-08-27'),
    '1.6.1',
  );
});
test('returns null when there is no version heading', () => {
  assert.strictEqual(parseChangelogVersion('# Changelog\nno versions here'), null);
});

// --- check() pure core ---
test('in sync (version == changelog, tag present) → ok, no warnings', () => {
  const r = check({ version: '1.6.1', changelogVersion: '1.6.1', tags: ['v1.6.0', 'v1.6.1'], strict: false });
  assert.ok(r.ok);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.warnings.length, 0);
});
test('version/changelog mismatch → hard error', () => {
  const r = check({ version: '1.6.1', changelogVersion: '1.6.0', tags: ['v1.6.1'], strict: false });
  assert.ok(!r.ok);
  assert.match(r.errors[0], /version drift/);
});
test('missing tag, non-strict → ok with a warning', () => {
  const r = check({ version: '1.6.1', changelogVersion: '1.6.1', tags: [], strict: false });
  assert.ok(r.ok);
  assert.strictEqual(r.errors.length, 0);
  assert.match(r.warnings[0], /no git tag v1\.6\.1/);
});
test('missing tag, strict → hard error', () => {
  const r = check({ version: '1.6.1', changelogVersion: '1.6.1', tags: [], strict: true });
  assert.ok(!r.ok);
  assert.match(r.errors[0], /no git tag v1\.6\.1/);
});
test('non-semver version → hard error', () => {
  const r = check({ version: 'nope', changelogVersion: 'nope', tags: [], strict: false });
  assert.ok(!r.ok);
  assert.match(r.errors[0], /not semver/);
});

// --- CLI via --input ---
function runCli(bundle, args = []) {
  const f = path.join(TMP, `bundle-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(bundle));
  return spawnSync('node', [SCRIPT, `--input=${f}`, ...args], { encoding: 'utf8' });
}
test('CLI exits 0 when in sync', () => {
  const r = runCli({ version: '1.6.1', changelogVersion: '1.6.1', tags: ['v1.6.1'] });
  assert.strictEqual(r.status, 0);
});
test('CLI exits 1 on version/changelog drift', () => {
  const r = runCli({ version: '1.6.1', changelogVersion: '1.5.0', tags: ['v1.6.1'] });
  assert.strictEqual(r.status, 1);
});
test('CLI --strict exits 1 on a missing tag', () => {
  const r = runCli({ version: '1.6.1', changelogVersion: '1.6.1', tags: [] }, ['--strict']);
  assert.strictEqual(r.status, 1);
});
test('CLI without --strict exits 0 on a missing tag', () => {
  const r = runCli({ version: '1.6.1', changelogVersion: '1.6.1', tags: [] });
  assert.strictEqual(r.status, 0);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
