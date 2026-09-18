#!/usr/bin/env node
/**
 * Unit tests for migrate-architecture-markers.js.
 * Zero deps: run with `node migrate-architecture-markers.test.js`.
 */

const { analyze, migrate } = require('./migrate-architecture-markers');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Legacy backend architecture.md — whole body is one human-owned block.
const legacyBackend = `# Architecture

<!-- human-owned -->

## System Overview

A service.

## Architecture Style

- Layered

## Key Architectural Boundaries

Boxes.

## External Service Dependencies

| Service | Client |
| --- | --- |

## Technology Stack

| Layer | Tech |
| --- | --- |

## Key Directories

- src/

## What NOT to Do

- Do not edit generated sources.

<!-- /human-owned -->
`;

const legacyFrontend = `# Architecture

<!-- human-owned -->

## System Overview

An app.

## Architecture Style

- CSR

## Directory Structure

- src/

## Feature Module Decomposition Rules

Rules.

## What NOT to Do

- Do not bypass the client factory.

<!-- /human-owned -->
`;

test('detects legacy backend', () => {
  assert(analyze(legacyBackend).status === 'legacy');
});

test('detects legacy frontend', () => {
  assert(analyze(legacyFrontend).status === 'legacy');
});

test('backend migration reclassifies the three factual sections, content byte-identical', () => {
  const out = migrate(legacyBackend);
  assert(out, 'expected a migration result');
  const a = analyze(out);
  assert(a.status === 'migrated', `expected migrated, got ${a.status}`);
  // The factual sections now sit in an agent-updatable region.
  const { parse } = require('./migrate-architecture-markers');
  const owners = Object.fromEntries(parse(out).headings.map(h => [h.text, h.owner]));
  assert(owners['External Service Dependencies'] === 'agent');
  assert(owners['Technology Stack'] === 'agent');
  assert(owners['Key Directories'] === 'agent');
  // Interpretive sections stay human-owned.
  assert(owners['System Overview'] === 'human');
  assert(owners['Key Architectural Boundaries'] === 'human');
  assert(owners['What NOT to Do'] === 'human');
  // Content preserved verbatim: every meaningful (non-marker, non-blank) line
  // survives unchanged and in the same order. Only markers + surrounding blank
  // lines are added.
  const strip = s => s.split(/\r?\n/)
    .filter(l => l.trim() !== '' && !/^<!--\s*\/?(human-owned|agent-updatable)\s*-->$/.test(l.trim()));
  assert(JSON.stringify(strip(out)) === JSON.stringify(strip(legacyBackend)), 'section content changed');
});

test('frontend migration reclassifies only Directory Structure', () => {
  const out = migrate(legacyFrontend);
  const { parse } = require('./migrate-architecture-markers');
  const owners = Object.fromEntries(parse(out).headings.map(h => [h.text, h.owner]));
  assert(owners['Directory Structure'] === 'agent');
  assert(owners['Feature Module Decomposition Rules'] === 'human');
  assert(owners['System Overview'] === 'human');
});

test('migration is idempotent (re-running is a no-op)', () => {
  const once = migrate(legacyBackend);
  const twice = migrate(once);
  assert(twice === null, 'second migrate should return null (already migrated)');
  assert(analyze(once).status === 'migrated');
});

test('already-split file reports migrated, not legacy', () => {
  const split = migrate(legacyBackend);
  assert(analyze(split).status === 'migrated');
});

test('hand-modified file (group not contiguous) is skipped as non-canonical', () => {
  const modified = legacyBackend.replace(
    '## Technology Stack\n\n| Layer | Tech |\n| --- | --- |\n\n',
    '## Technology Stack\n\n| Layer | Tech |\n| --- | --- |\n\n## Custom Section\n\nHand-added.\n\n'
  );
  // "Custom Section" now sits between Technology Stack and Key Directories,
  // breaking contiguity → conservative skip.
  assert(analyze(modified).status === 'non-canonical', `got ${analyze(modified).status}`);
  assert(migrate(modified) === null);
});

test('malformed markers (unclosed) are reported, never transformed', () => {
  const bad = legacyBackend.replace('<!-- /human-owned -->', '');
  assert(analyze(bad).status === 'malformed');
  assert(migrate(bad) === null);
});

test('a file with no target sections is non-canonical (nothing to do)', () => {
  const none = `# Architecture\n\n<!-- human-owned -->\n\n## System Overview\n\nx\n\n<!-- /human-owned -->\n`;
  assert(analyze(none).status === 'non-canonical');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
