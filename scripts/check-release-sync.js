#!/usr/bin/env node
/**
 * check-release-sync.js — guard against release drift.
 *
 * The `.claude-plugin/plugin.json` version, the newest CHANGELOG entry, and the
 * git tag list are supposed to move together. When they don't — version bumped
 * and changelogged but never tagged — release consumers silently fall behind
 * (this is how the repo drifted three versions past its last tag).
 *
 * This script enforces the always-true half as a hard error, and reports the
 * release-time half as a warning (or a hard error under --strict):
 *   - HARD:  plugin.json `version` must equal the newest `## [x.y.z]` heading
 *            in CHANGELOG.md.
 *   - WARN:  a matching `vX.Y.Z` git tag should exist. Missing is legitimate
 *            between a version-bump merge and cutting the release, so it's only
 *            a warning by default; pass --strict to fail (use as a release gate).
 *
 * Zero deps. Run:
 *   node check-release-sync.js                     # dev check (missing tag = warning)
 *   node check-release-sync.js --strict            # release gate (missing tag = error)
 *   node check-release-sync.js --input=bundle.json # test hook, pure core, no git/fs of repo
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/** Newest `## [x.y.z]` version from CHANGELOG text, or null. */
function parseChangelogVersion(text) {
  const m = String(text).match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
  return m ? m[1] : null;
}

/**
 * Pure core — no I/O. Returns { ok, errors[], warnings[] }.
 * @param {{version:string, changelogVersion:string|null, tags:string[], strict:boolean}} input
 */
function check({ version, changelogVersion, tags, strict }) {
  const errors = [];
  const warnings = [];

  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) {
    errors.push(`plugin.json version is missing or not semver: ${version}`);
  }
  if (!changelogVersion) {
    errors.push('CHANGELOG.md has no "## [x.y.z]" version heading');
  } else if (version && version !== changelogVersion) {
    errors.push(
      `version drift: plugin.json is ${version} but the newest CHANGELOG entry is ` +
      `${changelogVersion} — bump both together`,
    );
  }

  const tagList = Array.isArray(tags) ? tags : [];
  const tagged = Boolean(version) && tagList.includes(`v${version}`);
  if (version && !tagged) {
    const hint =
      `no git tag v${version} — cut the release:\n` +
      `    git tag -a v${version} -m "PipeCrew v${version}" && git push origin v${version}`;
    if (strict) errors.push(hint);
    else warnings.push(`${hint}\n  (expected between a version bump and its release tag)`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Read the real repo (or a --input=<bundle.json> for tests). */
function readInputs() {
  const inputArg = process.argv.find((a) => a.startsWith('--input='));
  if (inputArg) {
    const bundle = JSON.parse(fs.readFileSync(inputArg.slice('--input='.length), 'utf8'));
    return {
      version: bundle.version,
      changelogVersion: bundle.changelogVersion,
      tags: Array.isArray(bundle.tags) ? bundle.tags : [],
    };
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  let tags = [];
  try {
    tags = execSync('git tag -l', { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    // git unavailable (e.g. a tarball install) — treat as "no tags"; surfaces as a warning.
    tags = [];
  }
  return { version: pkg.version, changelogVersion: parseChangelogVersion(changelog), tags };
}

function main() {
  const strict = process.argv.includes('--strict');
  const { version, changelogVersion, tags } = readInputs();
  const { ok, errors, warnings } = check({ version, changelogVersion, tags, strict });

  for (const w of warnings) console.warn(`⚠ ${w}`);
  for (const e of errors) console.error(`✗ ${e}`);
  if (ok) {
    const withTag = tags.includes(`v${version}`) ? ', and tag' : '';
    console.log(`✓ release in sync: plugin.json, CHANGELOG${withTag} agree on ${version}`);
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { check, parseChangelogVersion };
