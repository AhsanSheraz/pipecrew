#!/usr/bin/env node
'use strict';
/**
 * migrate-architecture-markers.js — one-time, opt-in, DETERMINISTIC upgrade of an
 * existing `agent-context/architecture.md` from the legacy all-`human-owned`
 * layout to the split layout where the re-derivable factual sections are
 * `agent-updatable` (so `/context-refresh` can keep them current) while the
 * interpretive sections stay `human-owned`.
 *
 * WHY a codemod and not the context-manager agent: reclassifying ownership is a
 * semantic change the user must be able to review. This script is MARKER-ONLY —
 * it inserts marker comment lines and never touches a byte of section content —
 * so the git diff shows nothing but markers moving. It is idempotent (already
 * split → no-op) and conservative (a hand-modified / non-canonical file is
 * skipped, never force-transformed).
 *
 * Backward-compat contract: doing nothing is always safe. A legacy file that is
 * never migrated keeps behaving exactly as before (whole file human-owned →
 * refresh flags drift as a finding, nothing auto-edits). Migration only OPTS IN
 * to auto-maintenance of the factual sections.
 *
 * Usage:
 *   node migrate-architecture-markers.js detect  --file=<path>     # print status word
 *   node migrate-architecture-markers.js migrate --file=<path>     # apply (writes)
 *   node migrate-architecture-markers.js detect  --repo=<repoDir>  # {repo}/agent-context/architecture.md
 *   node migrate-architecture-markers.js migrate --repo=<repoDir>
 *   node migrate-architecture-markers.js detect  --input=<json>    # offline test hook ({text})
 *
 * detect prints one of: legacy | migrated | non-canonical | malformed | missing
 * migrate exits 0 on success/no-op/clean-skip; 1 only on a real error.
 * Zero dependencies.
 */

const fs = require('fs');
const path = require('path');

// Contiguous heading runs that are safe to reclassify as agent-updatable. Order
// matters only for readability; the first group that matches the file is used.
const TARGET_GROUPS = [
  // backend architecture.md
  ['External Service Dependencies', 'Technology Stack', 'Key Directories'],
  // frontend architecture.md
  ['Directory Structure'],
];

const MARKER_RE = /^<!--\s*(\/?)(human-owned|agent-updatable)\s*-->$/;
const H2_RE = /^##\s+(.+?)\s*$/;

// ─── Pure core ───────────────────────────────────────────────────────────────

// Parse the file into an ownership-annotated list of level-2 headings, and
// validate that the marker comments are well-formed (balanced, non-nested).
// Returns { headings: [{text, line, owner}], malformed: bool }.
function parse(text) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  let owner = 'none';          // 'none' | 'human' | 'agent'
  let malformed = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const m = t.match(MARKER_RE);
    if (m) {
      const closing = m[1] === '/';
      const kind = m[2] === 'human-owned' ? 'human' : 'agent';
      if (!closing) {
        if (owner !== 'none') malformed = true; // opened while already open (nested)
        owner = kind;
      } else {
        if (owner !== kind) malformed = true;   // close with no/mismatched open
        owner = 'none';
      }
      continue;
    }
    const h = t.match(H2_RE);
    if (h) headings.push({ text: h[1].trim(), line: i, owner });
  }
  if (owner !== 'none') malformed = true;        // unclosed region
  return { lines, headings, malformed };
}

// Decide the file's migration status and, when legacy, the exact group + the
// two heading lines the boundary markers get inserted before.
// Returns { status, group?, startLine?, reopenLine? }.
function analyze(text) {
  const { lines, headings, malformed } = parse(text);
  if (malformed) return { status: 'malformed' };
  const byText = new Map();
  headings.forEach((h, idx) => { if (!byText.has(h.text)) byText.set(h.text, idx); });

  let sawMigrated = false;
  for (const group of TARGET_GROUPS) {
    const idxs = group.map(g => (byText.has(g) ? byText.get(g) : -1));
    if (idxs.some(x => x < 0)) continue;                 // group not present in this file
    // Already agent-updatable → this file is migrated for this group.
    if (group.every(g => headings[byText.get(g)].owner === 'agent')) { sawMigrated = true; continue; }
    // Migratable only if the group is a contiguous run, fully human-owned, with
    // human-owned content on BOTH sides (so no empty block is created).
    const first = idxs[0], last = idxs[idxs.length - 1];
    const contiguous = idxs.every((x, k) => k === 0 || x === idxs[k - 1] + 1);
    if (!contiguous) continue;
    const allHuman = group.every(g => headings[byText.get(g)].owner === 'human');
    if (!allHuman) continue;
    const before = headings[first - 1];
    const after = headings[last + 1];
    if (!before || before.owner !== 'human') continue;   // no human section before → skip
    if (!after || after.owner !== 'human') continue;      // no human section after → skip
    return { status: 'legacy', group, startLine: headings[first].line, reopenLine: after.line, lines };
  }
  if (sawMigrated) return { status: 'migrated' };
  return { status: 'non-canonical' };
}

// Apply the marker-only transform. Returns the new text, or null if not legacy.
function migrate(text) {
  const res = analyze(text);
  if (res.status !== 'legacy') return null;
  const lines = res.lines.slice();
  // Insert bottom-up so earlier line indices stay valid.
  lines.splice(res.reopenLine, 0, '<!-- /agent-updatable -->', '', '<!-- human-owned -->', '');
  lines.splice(res.startLine, 0, '<!-- /human-owned -->', '', '<!-- agent-updatable -->', '');
  return lines.join('\n');
}

// ─── CLI plumbing ────────────────────────────────────────────────────────────

function arg(name) {
  const p = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}

function resolveFile() {
  const file = arg('file');
  if (file) return file;
  const repo = arg('repo');
  if (repo) return path.join(repo, 'agent-context', 'architecture.md');
  return null;
}

module.exports = { parse, analyze, migrate, TARGET_GROUPS };

if (require.main === module) {
  const mode = process.argv[2];
  if (mode !== 'detect' && mode !== 'migrate') {
    console.error('usage: migrate-architecture-markers.js <detect|migrate> --file=<path> | --repo=<dir> | --input=<json>');
    process.exit(1);
  }
  // Offline test hook.
  const input = arg('input');
  let text = null, file = null;
  if (input != null) {
    const parsed = JSON.parse(fs.readFileSync(input, 'utf8'));
    text = typeof parsed === 'string' ? parsed : parsed.text;
  } else {
    file = resolveFile();
    if (!file) { console.error('pass --file, --repo, or --input'); process.exit(1); }
    if (!fs.existsSync(file)) { console.log('missing'); process.exit(0); }
    text = fs.readFileSync(file, 'utf8');
  }

  const status = analyze(text).status;
  if (mode === 'detect') { console.log(status); process.exit(0); }

  // migrate
  if (status === 'legacy') {
    const out = migrate(text);
    if (file) fs.writeFileSync(file, out);
    else process.stdout.write(out);
    console.error(`migrated: ${file || '(stdin)'} — factual sections are now agent-updatable (content unchanged)`);
    process.exit(0);
  }
  if (status === 'migrated') { console.error(`no-op: ${file || '(stdin)'} already split`); process.exit(0); }
  if (status === 'missing')  { console.error('no-op: no architecture.md'); process.exit(0); }
  // non-canonical / malformed → never force. Skip cleanly and tell the operator.
  console.error(`skipped (${status}): ${file || '(stdin)'} — layout differs from the canonical template; leave it as-is or split the markers by hand`);
  process.exit(0);
}
