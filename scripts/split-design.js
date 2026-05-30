#!/usr/bin/env node
/**
 * Split a phase output (typically `outputs/phase-2-architecture.md`)
 * into per-block side files under `outputs/blocks/`.
 *
 * Why: today the orchestrator extracts blocks via extract-block.js,
 * which is fine, but downstream consumers (site-view UI, /learn skill,
 * validators, future agents) have to re-parse markdown to find the
 * structured data. Materializing each `<!-- BEGIN X -->` JSON fence as
 * its own file makes those consumers cheap and lets us drop the entire
 * markdown into context only when a human is reading the design.
 *
 * Behavior:
 *   - Scans the input for every `<!-- BEGIN <NAME> -->` ... `<!-- END <NAME> -->` block.
 *   - For each block, looks for a ```json fenced code block inside.
 *   - If found, parses it (fail loud on parse error) and writes
 *     `<output-dir>/<slug>.json` — name lowercased + dashed.
 *   - Blocks without a ```json fence are skipped silently (they're prose-only).
 *   - Idempotent: running twice over the same input produces the same files.
 *
 * Usage:  node split-design.js <input-file> [output-dir]
 *   default output-dir = dirname(input-file) + '/blocks/'
 *
 * Exit codes:
 *   0  — success (some files may have been skipped, see stderr)
 *   1  — input file not found / unreadable
 *   2  — usage error
 *   3  — JSON parse error in any block (loud failure — design is wrong)
 *   4  — output dir cannot be created/written
 *
 * Schema documentation: templates/blocks/block-schemas.md
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');

const [, , inputFile, outDirArg] = process.argv;

if (!inputFile) {
  console.error('Usage: split-design.js <input-file> [output-dir]');
  process.exit(2);
}

let content;
try {
  content = fs.readFileSync(inputFile, 'utf8');
} catch (e) {
  console.error(`Cannot read input: ${inputFile} (${e.message})`);
  process.exit(1);
}

const outDir = outDirArg || path.join(path.dirname(inputFile), 'blocks');

try {
  fs.mkdirSync(outDir, { recursive: true });
} catch (e) {
  console.error(`Cannot create output dir: ${outDir} (${e.message})`);
  process.exit(4);
}

// Scan every BEGIN/END pair. Block names are uppercase + underscores by convention.
const blockRe = /<!--\s*BEGIN\s+([A-Z][A-Z0-9_]*)\s*-->([\s\S]*?)<!--\s*END\s+\1\s*-->/g;

const written = [];
const skipped = [];
const errors = [];

let match;
while ((match = blockRe.exec(content)) !== null) {
  const name = match[1];
  const body = match[2];

  const fence = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fence) {
    skipped.push(name); // prose-only block — that's fine
    continue;
  }

  let parsed;
  try {
    parsed = JSON.parse(fence[1]);
  } catch (e) {
    errors.push(`${name}: ${e.message}`);
    continue;
  }

  const slug = name.toLowerCase().replace(/_/g, '-');
  const outPath = path.join(outDir, `${slug}.json`);

  try {
    fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2) + '\n');
    written.push(slug);
  } catch (e) {
    errors.push(`${name}: write failed (${e.message})`);
  }
}

if (errors.length) {
  console.error(`split-design: ${errors.length} block(s) failed:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(3);
}

const summary = {
  input: inputFile,
  output_dir: outDir,
  written,
  skipped_prose_only: skipped,
};

process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
