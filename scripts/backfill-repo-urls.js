#!/usr/bin/env node
/**
 * backfill-repo-urls.js — populate `repos.{key}.repo_url` in a workspace
 * config.json by reading each repo's `git remote get-url origin`.
 *
 * WHY: `repo_url` is the machine-independent clone URL that rides into
 * config.portable.json so a teammate running /pipecrew:join can CLONE a repo
 * instead of hand-pointing to a local copy. It is captured opportunistically by
 * /discover (an LLM step), so workspaces onboarded before that — or where the
 * step was skipped — ship with zero clone URLs, which forces every join into
 * fully manual point-to-local. This script is the deterministic owner-side
 * remedy: run it (directly, or automatically via sync-memory.js before it
 * regenerates the portable config) and the shared memory gains clone URLs with
 * no /discover re-run.
 *
 * Best-effort by design: a repo whose path is missing, isn't a git repo, or has
 * no `origin` is left untouched and reported — never an error. Existing
 * repo_url values are preserved unless --force (so a hand-curated URL wins).
 *
 * Credential safety: a URL of the form https://user:token@host/... is sanitized
 * to https://host/... before it is written, mirroring /discover's capture rule
 * and keeping validate-config.js's credential check happy. SSH URLs
 * (git@host:org/repo.git) are left as-is — `git@` is the SSH user, not a secret.
 *
 * Usage:
 *   node backfill-repo-urls.js <config.json> [--force] [--dry-run] [--quiet]
 *     --force    overwrite repo_url even when already present
 *     --dry-run  report what would change; do not write the file
 *     --quiet    suppress the per-repo summary (errors still print)
 *
 * Exit: 0 always on a readable config (best-effort enrichment never blocks a
 *       sync); 2 only on usage error / unreadable-or-unparseable config.
 * Zero dependencies — pure Node stdlib + git on PATH.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');

// Strip HTTP basic-auth creds (user:token@) that would leak into committed
// config.portable.json. Returns null for empty/whitespace input. SSH URLs and
// bare https URLs pass through unchanged.
function sanitizeUrl(raw) {
  if (!raw) return null;
  const url = String(raw).trim().replace(/^(https?:\/\/)[^@/]+@/, '$1');
  return url || null;
}

// Default resolver: read `git remote get-url origin` for a repo on disk.
// Returns null when the path is absent, not a git repo, or has no origin.
function gitOriginUrl(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return null;
  const r = spawnSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

/**
 * Pure core: enrich `config.repos[*].repo_url` in place.
 *   opts.resolveUrl : (repoKey, repoPath) => string|null  (injectable for tests)
 *   opts.force      : overwrite an existing repo_url
 * Mutates and returns `config`, plus three disjoint report lists:
 *   filled[]     : { key, url } — newly set or (with force) changed
 *   kept[]       : keys left as-is because a repo_url was already present
 *   unresolved[] : keys with no derivable origin (stay point-to-local on join)
 */
function backfill(config, opts = {}) {
  const resolveUrl = opts.resolveUrl || ((_k, p) => gitOriginUrl(p));
  const force = !!opts.force;
  const filled = [], kept = [], unresolved = [];
  const repos = (config && config.repos) || {};

  for (const [key, repo] of Object.entries(repos)) {
    if (repo.repo_url && !force) { kept.push(key); continue; }
    const url = sanitizeUrl(resolveUrl(key, repo.path));
    if (!url) { unresolved.push(key); continue; }
    if (repo.repo_url === url) { kept.push(key); continue; } // force re-run, same value
    repo.repo_url = url;
    filled.push({ key, url });
  }
  return { config, filled, kept, unresolved };
}

// ---- CLI ----
if (require.main === module) {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const dry = argv.includes('--dry-run');
  const quiet = argv.includes('--quiet');
  const cfgPath = argv.find((a) => !a.startsWith('--'));

  if (!cfgPath) {
    console.error('Usage: backfill-repo-urls.js <config.json> [--force] [--dry-run] [--quiet]');
    process.exit(2);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    console.error(`backfill-repo-urls: cannot read/parse ${cfgPath}: ${e.message}`);
    process.exit(2);
  }

  const { filled, kept, unresolved } = backfill(config, { force });

  if (filled.length && !dry) {
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n');
  }
  if (!quiet) {
    const verb = dry ? 'would backfill' : 'backfilled';
    console.log(`backfill-repo-urls: ${verb} ${filled.length} repo_url(s)${filled.length ? ': ' + filled.map((f) => f.key).join(', ') : ''}`);
    if (kept.length) console.log(`  kept ${kept.length} existing: ${kept.join(', ')}`);
    if (unresolved.length) console.log(`  no git origin for ${unresolved.length} (stay point-to-local on /join): ${unresolved.join(', ')}`);
  }
  process.exit(0);
}

module.exports = { backfill, sanitizeUrl, gitOriginUrl };
