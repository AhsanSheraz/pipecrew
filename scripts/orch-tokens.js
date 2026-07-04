#!/usr/bin/env node
'use strict';
/**
 * orch-tokens.js — deterministically compute a run's ORCHESTRATOR (main-loop)
 * token overhead by summing the session transcript's own assistant usage.
 *
 * WHY: the old `orch_checkpoint` mechanism asked the orchestrator to
 * byte-offset-diff its own session JSONL inline and subtract agent tokens —
 * too complex, so it was skipped (real runs emit EMPTY orch_checkpoints → the
 * site-view always showed 0 orchestrator overhead, under-reporting total run
 * cost by the orchestrator's 20-40% share).
 *
 * The orchestrator's tokens (loading skills, reading files/specs, scratchpad
 * updates, approval gates, and reading agent RESULTS) are exactly the
 * `message.usage` on the session's own `assistant` lines. Sub-agent tokens live
 * in SEPARATE transcripts (`subagents/agent-*.jsonl`), so they are NOT in the
 * parent session's usage — **no subtraction is needed**. So orchestrator
 * overhead = sum of the session's assistant `message.usage`. Deterministic,
 * one pass, no LLM math.
 *
 * Headline `total` = input + output + cacheCreate (the new tokens generated).
 * cache-read is tracked but excluded — it counts re-reads of the growing
 * context every turn and would dwarf the real cost.
 *
 * Usage:
 *   node orch-tokens.js --session=<id|path>   # id resolved under ~/.claude/projects
 *   node orch-tokens.js --run-dir=<dir>       # resolve session from run_start's session_id
 *   node orch-tokens.js --input=<lines.json>  # offline test hook (array of transcript lines)
 *   (--projects-dir overrides ~/.claude/projects; --session defaults to $CLAUDE_CODE_SESSION_ID)
 *
 * Exit 0 success · 1 could not resolve the session JSONL. Zero dependencies.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name) {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Resolve a session id (or a direct path) to its transcript JSONL.
function resolveSessionJsonl(session, projectsDir) {
  if (!session) return null;
  if (session.endsWith('.jsonl') || session.includes('/') || session.includes('\\')) {
    return fs.existsSync(session) ? session : null;
  }
  const base = projectsDir || defaultProjectsDir();
  let dirs;
  try { dirs = fs.readdirSync(base); } catch (_) { return null; }
  for (const d of dirs) {
    const f = path.join(base, d, session + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Pure core: sum orchestrator assistant usage from parsed transcript lines.
function orchFromLines(lines) {
  const t = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, assistantTurns: 0 };
  for (const o of Array.isArray(lines) ? lines : []) {
    if (!o || o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    const u = o.message.usage;
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheCreate += u.cache_creation_input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.assistantTurns += 1;
  }
  t.total = t.input + t.output + t.cacheCreate;
  return t;
}

// Read the session id a run recorded in its run_start checkpoint (if any).
function readSessionIdFromRunDir(runDir) {
  try {
    const cp = fs.readFileSync(path.join(runDir, 'checkpoints.jsonl'), 'utf8').split(/\r?\n/);
    for (const l of cp) {
      const s = l.trim();
      if (!s) continue;
      let e;
      try { e = JSON.parse(s); } catch (_) { continue; }
      if (e.event === 'run_start' && (e.session_id || e.sessionId)) return e.session_id || e.sessionId;
    }
  } catch (_) {}
  return null;
}

// Compute orchestrator overhead for a session JSONL path.
function computeFromFile(sessionJsonl) {
  let text;
  try { text = fs.readFileSync(sessionJsonl, 'utf8'); } catch (_) { return null; }
  const lines = [];
  for (const l of text.split(/\r?\n/)) {
    const s = l.trim();
    if (!s) continue;
    try { lines.push(JSON.parse(s)); } catch (_) { /* skip partial */ }
  }
  return orchFromLines(lines);
}

module.exports = {
  resolveSessionJsonl,
  orchFromLines,
  readSessionIdFromRunDir,
  computeFromFile,
  defaultProjectsDir,
};

if (require.main === module) {
  const input = arg('input');
  if (input != null) {
    const parsed = JSON.parse(fs.readFileSync(input, 'utf8'));
    process.stdout.write(JSON.stringify(orchFromLines(Array.isArray(parsed) ? parsed : parsed.lines), null, 2));
    process.exit(0);
  }
  let session = arg('session') || process.env.CLAUDE_CODE_SESSION_ID;
  const runDir = arg('run-dir');
  if (!session && runDir) session = readSessionIdFromRunDir(runDir);
  const jsonl = resolveSessionJsonl(session, arg('projects-dir'));
  if (!jsonl) {
    console.error('orch-tokens: could not resolve the session JSONL — pass --session=<id|path>, ensure $CLAUDE_CODE_SESSION_ID is set, or that run_start recorded session_id.');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(computeFromFile(jsonl), null, 2));
  process.exit(0);
}
