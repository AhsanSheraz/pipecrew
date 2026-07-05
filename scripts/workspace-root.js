#!/usr/bin/env node
/**
 * workspace-root.js — resolver for the PipeCrew workspace root directory and
 * the harness-specific user-level agents directory.
 *
 * PipeCrew is a dual-target plugin: it installs in both Claude Code and Cursor.
 * Runtime state must land in the *host harness's* home dir, not a hardcoded
 * `~/.claude` — otherwise a Cursor install writes its config, workspaces, and
 * published agents into Claude Code's directory.
 *
 * Harness detection (see detectHarness): the plugin's own install path is the
 * signal — a Cursor plugin lives under `.../.cursor/plugins/...`, a Claude one
 * under `.../.claude/plugins/...`. This is robust because it doesn't depend on
 * per-call env vars. `PIPECREW_HARNESS=cursor|claude` overrides it (tests / edge
 * cases); an unknown location falls back to `claude` so legacy behavior is
 * preserved byte-for-byte for existing Claude Code users.
 *
 * The workspace_root is resolved with this precedence:
 *
 *   1. $PIPECREW_WORKSPACE_ROOT env var (escape hatch, never persisted)
 *   2. <harness_home>/pipecrew/config.json → workspace_root (set by /deliver
 *      or /discover pre-flight the first time the user is prompted)
 *   3. Default: <harness_home>/pipecrew/workspaces/
 *
 * where <harness_home> is `~/.claude` (Claude Code) or `~/.cursor` (Cursor).
 *
 * All Node scripts and skills should route through this so a single
 * user preference applies everywhere within a harness.
 *
 * Commands:
 *   node workspace-root.js --get        print resolved absolute path, exit 0
 *   node workspace-root.js --default    print the hardcoded default, exit 0
 *   node workspace-root.js --check      exit 0 if workspace_root is configured
 *                                       in the plugin config, exit 2 if not
 *                                       (so skill pre-flights know to prompt).
 *                                       Env var counts as "configured".
 *   node workspace-root.js --set=<path> persist the given path to the plugin
 *                                       config (creates it if absent), print
 *                                       the resolved absolute path, exit 0.
 *                                       Accepts ~-prefixed paths.
 *   node workspace-root.js --config-path print <harness_home>/pipecrew/config.json
 *                                       absolute path, exit 0.
 *   node workspace-root.js --agents-dir print the harness user-level agents dir
 *                                       (~/.claude/agents or ~/.cursor/agents)
 *                                       that the Agent tool resolves
 *                                       `subagent_type` against, exit 0.
 *   node workspace-root.js --harness    print the detected harness
 *                                       (claude | cursor), exit 0.
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const ENV_VAR = 'PIPECREW_WORKSPACE_ROOT';

// Which harness are we running under? The plugin's install path is the signal:
// a Cursor plugin lives under `.cursor/`, a Claude Code plugin under `.claude/`.
// `PIPECREW_HARNESS` overrides. Unknown → `claude` (preserves legacy behavior).
function detectHarness() {
  const override = (process.env.PIPECREW_HARNESS || '').trim().toLowerCase();
  if (override === 'cursor' || override === 'claude') return override;

  const here = __dirname.replace(/\\/g, '/');
  if (/(^|\/)\.cursor(\/|$)/.test(here)) return 'cursor';
  if (/(^|\/)\.claude(\/|$)/.test(here)) return 'claude';

  // Not resolvable from the install path (e.g. running from a repo checkout or
  // a test harness). Fall back to an env hint, else default to claude.
  if (process.env.CURSOR_PROJECT_DIR || process.env.CURSOR_VERSION) return 'cursor';
  return 'claude';
}

const HARNESS = detectHarness();
const HARNESS_HOME = path.join(HOME, HARNESS === 'cursor' ? '.cursor' : '.claude');
const PLUGIN_CONFIG_DIR = path.join(HARNESS_HOME, 'pipecrew');
const PLUGIN_CONFIG_FILE = path.join(PLUGIN_CONFIG_DIR, 'config.json');
const DEFAULT_WORKSPACE_ROOT = path.join(HARNESS_HOME, 'pipecrew', 'workspaces');
const USER_AGENTS_DIR = path.join(HARNESS_HOME, 'agents');

function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

function readPluginConfig() {
  if (!fs.existsSync(PLUGIN_CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PLUGIN_CONFIG_FILE, 'utf8'));
  } catch (e) {
    process.stderr.write(`[workspace-root] failed to parse ${PLUGIN_CONFIG_FILE}: ${e.message}\n`);
    return null;
  }
}

function writePluginConfig(config) {
  fs.mkdirSync(PLUGIN_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PLUGIN_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

function resolveRoot() {
  if (process.env[ENV_VAR]) {
    return path.resolve(expandTilde(process.env[ENV_VAR]));
  }
  const cfg = readPluginConfig();
  if (cfg && typeof cfg.workspace_root === 'string' && cfg.workspace_root.trim()) {
    return path.resolve(expandTilde(cfg.workspace_root.trim()));
  }
  return DEFAULT_WORKSPACE_ROOT;
}

function isConfigured() {
  if (process.env[ENV_VAR]) return true;
  const cfg = readPluginConfig();
  return !!(cfg && typeof cfg.workspace_root === 'string' && cfg.workspace_root.trim());
}

// CLI
if (require.main === module) {
  const arg = process.argv[2];
  if (!arg || arg === '--get') {
    process.stdout.write(resolveRoot() + '\n');
    process.exit(0);
  }
  if (arg === '--default') {
    process.stdout.write(DEFAULT_WORKSPACE_ROOT + '\n');
    process.exit(0);
  }
  if (arg === '--check') {
    process.exit(isConfigured() ? 0 : 2);
  }
  if (arg === '--config-path') {
    process.stdout.write(PLUGIN_CONFIG_FILE + '\n');
    process.exit(0);
  }
  if (arg === '--agents-dir') {
    process.stdout.write(USER_AGENTS_DIR + '\n');
    process.exit(0);
  }
  if (arg === '--harness') {
    process.stdout.write(HARNESS + '\n');
    process.exit(0);
  }
  if (arg.startsWith('--set=')) {
    const raw = arg.slice('--set='.length).trim();
    if (!raw) {
      process.stderr.write('[workspace-root] --set= requires a path\n');
      process.exit(1);
    }
    const resolved = path.resolve(expandTilde(raw));
    const cfg = readPluginConfig() || {};
    cfg.workspace_root = raw; // preserve user's ~-form if they used it
    writePluginConfig(cfg);
    process.stdout.write(resolved + '\n');
    process.exit(0);
  }
  process.stderr.write(`Unknown argument: ${arg}\n`);
  process.stderr.write('Usage: workspace-root.js [--get|--default|--check|--config-path|--agents-dir|--harness|--set=<path>]\n');
  process.exit(1);
}

module.exports = {
  resolveRoot,
  isConfigured,
  detectHarness,
  HARNESS,
  DEFAULT_WORKSPACE_ROOT,
  PLUGIN_CONFIG_FILE,
  USER_AGENTS_DIR,
};
