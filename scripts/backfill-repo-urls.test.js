#!/usr/bin/env node
/**
 * Unit tests for backfill-repo-urls.js.
 * Zero deps: run with `node backfill-repo-urls.test.js`.
 * The git call is injected via opts.resolveUrl, so no real repos are needed.
 */
const { backfill, sanitizeUrl } = require('./backfill-repo-urls');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

function cfg() {
  return {
    workspace: { name: 'Acme', slug: 'acme' },
    repos: {
      'acme-backend':  { path: '/src/acme/acme-backend',  type: 'spring-boot', role: 'api-service' },
      'acme-frontend': { path: '/src/acme/acme-frontend', type: 'react',       role: 'frontend' },
    },
    services: {},
  };
}

console.log('\nbackfill-repo-urls tests\n');

test('fills repo_url from resolver for every repo with an origin', () => {
  const c = cfg();
  const { filled, unresolved } = backfill(c, {
    resolveUrl: (key) => `git@github.com:acme/${key}.git`,
  });
  eq(filled.length, 2, 'both filled');
  eq(unresolved.length, 0, 'none unresolved');
  eq(c.repos['acme-backend'].repo_url, 'git@github.com:acme/acme-backend.git', 'backend url set');
  eq(c.repos['acme-frontend'].repo_url, 'git@github.com:acme/acme-frontend.git', 'frontend url set');
});

test('repo with no resolvable origin is reported, not errored, not written', () => {
  const c = cfg();
  const { filled, unresolved } = backfill(c, {
    resolveUrl: (key) => (key === 'acme-backend' ? 'git@github.com:acme/acme-backend.git' : null),
  });
  eq(filled.length, 1, 'one filled');
  eq(unresolved.length, 1, 'one unresolved');
  assert(unresolved.includes('acme-frontend'), 'frontend unresolved');
  assert(!('repo_url' in c.repos['acme-frontend']), 'no url invented for unresolved repo');
});

test('existing repo_url is preserved by default (hand-curated wins)', () => {
  const c = cfg();
  c.repos['acme-backend'].repo_url = 'git@github.com:acme/CUSTOM.git';
  const { filled, kept } = backfill(c, { resolveUrl: () => 'git@github.com:acme/auto.git' });
  assert(kept.includes('acme-backend'), 'existing kept');
  eq(c.repos['acme-backend'].repo_url, 'git@github.com:acme/CUSTOM.git', 'not clobbered');
  assert(filled.some((f) => f.key === 'acme-frontend'), 'other repo still filled');
});

test('--force overwrites an existing repo_url when the origin differs', () => {
  const c = cfg();
  c.repos['acme-backend'].repo_url = 'git@github.com:acme/OLD.git';
  const { filled } = backfill(c, { force: true, resolveUrl: () => 'git@github.com:acme/NEW.git' });
  eq(c.repos['acme-backend'].repo_url, 'git@github.com:acme/NEW.git', 'overwritten under force');
  assert(filled.some((f) => f.key === 'acme-backend'), 'reported as filled');
});

test('--force with identical origin is a no-op (kept, not filled)', () => {
  const c = cfg();
  c.repos['acme-backend'].repo_url = 'git@github.com:acme/same.git';
  const { filled, kept } = backfill(c, { force: true, resolveUrl: () => 'git@github.com:acme/same.git' });
  assert(kept.includes('acme-backend'), 'unchanged value kept');
  assert(!filled.some((f) => f.key === 'acme-backend'), 'not double-counted as filled');
});

test('sanitizeUrl strips https basic-auth creds, leaves ssh + bare https intact', () => {
  eq(sanitizeUrl('https://user:ghp_token@github.com/acme/x.git'), 'https://github.com/acme/x.git', 'creds stripped');
  eq(sanitizeUrl('https://github.com/acme/x.git'), 'https://github.com/acme/x.git', 'bare https untouched');
  eq(sanitizeUrl('git@github.com:acme/x.git'), 'git@github.com:acme/x.git', 'ssh untouched (git@ is the ssh user)');
  eq(sanitizeUrl('  git@github.com:acme/x.git  '), 'git@github.com:acme/x.git', 'trimmed');
  eq(sanitizeUrl(''), null, 'empty -> null');
  eq(sanitizeUrl(null), null, 'null -> null');
});

test('sanitized credential URL is what gets written', () => {
  const c = cfg();
  backfill(c, { resolveUrl: () => 'https://bob:secret@github.com/acme/acme-backend.git' });
  eq(c.repos['acme-backend'].repo_url, 'https://github.com/acme/acme-backend.git', 'no creds in written url');
});

test('empty config / no repos is a safe no-op', () => {
  const { filled, kept, unresolved } = backfill({}, { resolveUrl: () => 'x' });
  eq(filled.length + kept.length + unresolved.length, 0, 'nothing to do');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
