#!/usr/bin/env node
/**
 * write-review-diff.js — compute a feature branch's diff and write it to a
 * file, WITHOUT the orchestrator ever ingesting the diff into its context.
 *
 * Reviewers run with no Bash tool (Read/Glob/Grep only) so they are
 * structurally incapable of mutating the worktree. They can therefore no
 * longer run `git diff` themselves — the orchestrator pre-computes it here
 * and passes the OUTPUT FILE PATH to the reviewer, which Reads it in its own
 * context. Crucially, this script prints only a tiny one-line confirmation to
 * stdout (line + byte count) — never the diff body — so the orchestrator's
 * Bash tool-result stays a few tokens regardless of diff size or repo count.
 *
 * Usage:
 *   node write-review-diff.js --worktree=<path> --out=<file> [--base=<ref>]
 *
 * Base resolution: --base if given, else the first existing of
 *   origin/main, main, origin/dev, dev, origin/master, master.
 * The diff is `git diff <merge-base(base,HEAD)> HEAD` — two-dot from the
 * merge-base, i.e. exactly the changes the branch introduced.
 *
 * Exit 0 on success (including an empty diff — writes an empty file).
 * Exit 1 on usage error or git failure.
 *
 * Zero dependencies — pure Node stdlib. execFileSync (no shell) so a worktree
 * path or ref can never inject shell.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name) {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}

const worktree = arg('worktree');
const out = arg('out');
let base = arg('base');

if (!worktree || !out) {
  console.error('usage: write-review-diff.js --worktree=<path> --out=<file> [--base=<ref>]');
  process.exit(1);
}
if (!fs.existsSync(worktree)) {
  console.error(`worktree does not exist: ${worktree}`);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
}

function refExists(ref) {
  try { git(['rev-parse', '--verify', '--quiet', ref]); return true; }
  catch { return false; }
}

if (!base) {
  const candidates = ['origin/main', 'main', 'origin/dev', 'dev', 'origin/master', 'master'];
  base = candidates.find(refExists) || null;
}
if (!base) {
  console.error('could not resolve a base ref (tried origin/main, main, origin/dev, dev, origin/master, master). Pass --base=<ref>.');
  process.exit(1);
}

let mergeBase;
try { mergeBase = git(['merge-base', base, 'HEAD']).trim(); }
catch (e) { console.error(`git merge-base ${base} HEAD failed: ${e.message}`); process.exit(1); }

let diff;
try { diff = git(['diff', mergeBase, 'HEAD']); }
catch (e) { console.error(`git diff failed: ${e.message}`); process.exit(1); }

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, diff);

const lines = diff.length ? diff.split('\n').length : 0;
console.log(`wrote ${lines} lines (${Buffer.byteLength(diff)} bytes) to ${out} [base=${base} merge-base=${mergeBase.slice(0, 8)}]`);
process.exit(0);
