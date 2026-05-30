#!/usr/bin/env node
/**
 * OBSERVABILITY block validator.
 *
 * Reads platform.md, pipes the OBSERVABILITY block out via extract-block.js,
 * and verifies every log_destinations[] row carries the fields its `type`
 * requires. Trace, dashboards, and runbooks are advisory — only their shape
 * is checked, never their presence (a freshly-discovered workspace can
 * legitimately have no dashboards).
 *
 * Usage:  node validate-observability.js <platform.md path>
 *
 * Exit codes:
 *   0 — block is valid
 *   1 — file unreadable / extract-block failed / structural error
 *   2 — usage error
 *
 * Schema reference: templates/blocks/block-schemas.md#observability
 * Canonical example: templates/blocks/observability.example.json
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node validate-observability.js <platform.md path>');
  process.exit(2);
}

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const extractScript = path.join(__dirname, 'extract-block.js');
const r = spawnSync('node', [extractScript, filePath, 'OBSERVABILITY'], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(`extract-block.js failed (exit ${r.status}): ${r.stderr.trim()}`);
  process.exit(1);
}

let block;
try { block = JSON.parse(r.stdout); }
catch (e) { console.error(`OBSERVABILITY block is not valid JSON: ${e.message}`); process.exit(1); }

const errors = [];
const REQUIRED_BY_TYPE = {
  cloudwatch: ['log_group'],
  kubectl:    ['namespace', 'selector'],
  docker:     ['container'],
  journalctl: ['unit'],
};
const KNOWN_TYPES = Object.keys(REQUIRED_BY_TYPE);

if (!Array.isArray(block.log_destinations)) {
  errors.push('log_destinations must be an array (use [] for empty)');
} else {
  block.log_destinations.forEach((row, i) => {
    const where = `log_destinations[${i}]`;
    for (const f of ['service', 'env', 'type', 'query']) {
      if (!row[f] || typeof row[f] !== 'string') errors.push(`${where}: missing or non-string "${f}"`);
    }
    if (row.type && !KNOWN_TYPES.includes(row.type)) {
      errors.push(`${where}: unknown type "${row.type}" (known: ${KNOWN_TYPES.join(', ')})`);
    }
    if (row.type && REQUIRED_BY_TYPE[row.type]) {
      for (const f of REQUIRED_BY_TYPE[row.type]) {
        if (!row[f] || typeof row[f] !== 'string') {
          errors.push(`${where}: type=${row.type} requires field "${f}"`);
        }
      }
    }
    if (row.source && typeof row.source !== 'string') {
      errors.push(`${where}: source must be a string ("file:line")`);
    }
  });
}

if (block.trace !== undefined) {
  if (typeof block.trace !== 'object' || block.trace === null || Array.isArray(block.trace)) {
    errors.push('trace must be an object');
  } else {
    if (block.trace.correlation_header !== undefined && typeof block.trace.correlation_header !== 'string') {
      errors.push('trace.correlation_header must be a string');
    }
    if (block.trace.propagated_through !== undefined) {
      if (!Array.isArray(block.trace.propagated_through) ||
          !block.trace.propagated_through.every(s => typeof s === 'string')) {
        errors.push('trace.propagated_through must be an array of strings');
      }
    }
  }
}

if (block.dashboards !== undefined) {
  if (!Array.isArray(block.dashboards)) {
    errors.push('dashboards must be an array');
  } else {
    block.dashboards.forEach((d, i) => {
      const where = `dashboards[${i}]`;
      for (const f of ['name', 'url']) {
        if (!d[f] || typeof d[f] !== 'string') errors.push(`${where}: missing or non-string "${f}"`);
      }
    });
  }
}

if (block.runbooks !== undefined) {
  if (typeof block.runbooks !== 'object' || block.runbooks === null || Array.isArray(block.runbooks)) {
    errors.push('runbooks must be an object');
  } else if (block.runbooks.index !== undefined && typeof block.runbooks.index !== 'string') {
    errors.push('runbooks.index must be a string');
  }
}

if (errors.length) {
  console.error(`OBSERVABILITY block invalid (${errors.length} error${errors.length > 1 ? 's' : ''}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`OBSERVABILITY block valid (${(block.log_destinations || []).length} log destinations)`);
process.exit(0);
