#!/usr/bin/env node
/**
 * ensure-mcp.js — detect / install a named MCP server for the current user.
 *
 * Zero-dep. Wraps the `claude mcp` CLI so phases can check whether an MCP
 * server (e.g. chrome-devtools) is installed + connected before they try to
 * use its tools, and optionally install it.
 *
 * IMPORTANT CONSTRAINT (callers MUST honor): Claude Code loads MCP servers at
 * session start. A server installed mid-session is NOT usable until the next
 * `claude` launch. This script reports presence/health only; deciding what to
 * do about "freshly installed → not usable this session" is the caller's job.
 *
 * Usage:
 *   node ensure-mcp.js status  --name=chrome-devtools
 *   node ensure-mcp.js install --name=chrome-devtools --cmd="npx -y chrome-devtools-mcp@latest" [--scope=local]
 *
 * Output: a single JSON object on stdout. Exit codes:
 *   0  status resolved (present or not) / install succeeded
 *   2  the `claude` CLI is not on PATH (cannot check or install)
 *   3  install was requested but failed
 *   4  bad arguments
 */

const { execFileSync } = require('node:child_process');

function arg(name, fallback = undefined) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
}

const mode = process.argv[2];
const name = arg('name', 'chrome-devtools');

// Resolve the claude CLI. On Windows it may be claude.cmd / claude.exe.
function claude(args) {
  const candidates = process.platform === 'win32'
    ? ['claude.cmd', 'claude.exe', 'claude']
    : ['claude'];
  let lastErr;
  for (const bin of candidates) {
    try {
      return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // A non-zero exit still gives us stdout/stderr (e.g. "No MCP server found").
      if (e.stdout !== undefined || e.stderr !== undefined) {
        return (e.stdout || '') + (e.stderr || '');
      }
      lastErr = e; // ENOENT — try the next candidate name
    }
  }
  const err = new Error('claude CLI not found on PATH');
  err.cliMissing = true;
  err.cause = lastErr;
  throw err;
}

function status() {
  let raw;
  try {
    raw = claude(['mcp', 'get', name]);
  } catch (e) {
    if (e.cliMissing) {
      out({ name, cli_available: false, present: false, connected: false,
            note: 'claude CLI not on PATH — cannot check MCP status' }, 2);
    }
    throw e;
  }
  const text = String(raw);
  const notFound = /no mcp server found|not found|no server named/i.test(text);
  const present = !notFound && new RegExp(`(^|\\n)\\s*${name}\\b`, 'i').test(text);
  const connected = present && /(✔|\bconnected\b)/i.test(text) && !/needs authentication|failed|error/i.test(text);
  return { name, cli_available: true, present, connected, raw: text.trim() };
}

if (mode === 'status') {
  out({ ...status() });
}

if (mode === 'install') {
  const cmd = arg('cmd');
  const scope = arg('scope', 'local');
  if (!cmd) out({ error: 'missing --cmd="<server launch command>"' }, 4);

  // If it's already present, report idempotently — do not double-add.
  const pre = status();
  if (pre.present) {
    out({ name, installed: true, already_present: true, connected: pre.connected,
          needs_restart: false,
          note: 'MCP server already registered; no change made' });
  }

  // claude mcp add <name> -s <scope> -- <cmd...>
  const parts = cmd.split(/\s+/);
  let raw;
  try {
    raw = claude(['mcp', 'add', name, '-s', scope, '--', ...parts]);
  } catch (e) {
    if (e.cliMissing) out({ name, installed: false, cli_available: false,
      note: 'claude CLI not on PATH — cannot install', install_cmd: `claude mcp add ${name} -s ${scope} -- ${cmd}` }, 2);
    out({ name, installed: false, error: String(e.message || e),
      install_cmd: `claude mcp add ${name} -s ${scope} -- ${cmd}` }, 3);
  }
  const text = String(raw);
  const ok = /added .*mcp server|already exists/i.test(text);
  out({
    name,
    installed: ok,
    scope,
    needs_restart: true, // loaded only on next `claude` launch
    raw: text.trim(),
    install_cmd: `claude mcp add ${name} -s ${scope} -- ${cmd}`,
    remove_cmd: `claude mcp remove ${name} -s ${scope}`,
  }, ok ? 0 : 3);
}

out({ error: `unknown mode '${mode}'. Use: status | install` }, 4);
