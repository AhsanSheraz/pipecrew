---
name: assess
description: "Standalone cross-repo assessment. Checks a feature branch across all repos for cross-repo integration: wire-shape agreement, requirement enforcement symmetry, event/infra wiring. Use for verifying manually-implemented features or pre-merge validation."
---

## Usage
```
/assess --branch=<branch> [--workspace=<slug>]
```

### Flags
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--branch` | yes | — | Feature branch to assess (must exist in at least 2 repos) |
| `--workspace` | no | auto-detect | Workspace slug — reads config for repo list |
| `--requirements` | no | — | Path to a requirements doc (if not from a pipeline run) |
| `--browser-verify` | no | auto on frontend impact | Drive a real Chrome (chrome-devtools MCP) against the running app to verify frontend use-cases + backend integration. Auto-runs when a frontend repo is in the branch set; `--no-browser-verify` skips it. |
| `--no-browser-verify` | no | — | Skip the live browser verification step even when there is frontend impact. |

### Examples
```
/assess --branch=feature/contract-types
/assess --branch=feature/upload --workspace=my-platform --requirements=./requirements.md
```

## Instructions

### Step 1: Read workspace config

Read `{workspace_root}/{workspace}/config.json`. Get the list of all repos.

### Step 2: Find repos with the branch

For each repo in the config, check if the branch exists:

```bash
cd {repo.path} && git rev-parse --verify {branch} 2>/dev/null && echo "HAS_BRANCH" || echo "NO_BRANCH"
```

Collect the repos that have the branch. If fewer than 2 repos have it, warn:
```
Only {N} repo(s) have branch '{branch}'. Cross-repo assessment needs at least 2.
Assess anyway? (yes / no)
```

### Step 3: Gather context

**If `--requirements` is provided**: read the file.
**If a deliver run exists for this workspace** (`{workspace_root}/{slug}/runs/deliver/*/scratchpad.md`): read requirements and architecture from that run's `outputs/` directory.
**Otherwise**: the assessor will work from the spec and code only (less coverage but still useful).

### Step 4: Dispatch the assessor

**Tool**: `Agent`
**subagent_type**: `dal-assessor` (or `{workspace}-assessor` if a workspace-specific one exists at `{workspace_root}/{slug}/agents/assessor.md`)
**description**: `"Cross-repo assessment — {branch}"`
**prompt**:

```
Assess the feature on branch '{branch}' across these repos:

{for each repo with the branch:}
- {repo.name} ({repo.type}, {repo.role}) at {repo.path}
  Spec: {repo.spec_file or "none"}

{if requirements provided:}
REQUIREMENTS FILE: {path}
Read it via the Read tool.
{else:}
No explicit requirements doc. Assess spec compliance and cross-repo integration
from the code diff and OpenAPI specs only.

Platform context: {workspace_root}/{slug}/context/platform.md
Read it for domain and architecture context.

For each repo, get the diff:
  cd {repo.path} && git diff main...{branch}

Focus on CROSS-REPO integration:
1. Wire-shape agreement (backend DTOs ↔ frontend types ↔ mock responses)
2. Requirement enforcement symmetry (same rule enforced on both sides)
3. Event/infra wiring (queue names match, S3 ARNs align)
4. End-to-end requirement coverage (trace each FR through the full stack)

Produce your assessment report with an overall score (PASS / PARTIAL / FAIL)
and fix assignments per repo.
```

### Step 4.5: Live frontend verification (browser, via chrome-devtools MCP)

Run this when the branch set includes a repo with `role: "frontend"` (frontend impact) and `--no-browser-verify` was not passed; `--browser-verify` forces it. It mirrors `/deliver` Phase 6 Step 6.5 — read that step for the full contract. In brief:

1. **Ensure the MCP**: `node {plugin_dir}/scripts/ensure-mcp.js status --name=chrome-devtools`.
   - `present+connected` → proceed.
   - missing → inform the user, ask to install (`node {plugin_dir}/scripts/ensure-mcp.js install --name=chrome-devtools --cmd="npx -y chrome-devtools-mcp@latest" --scope=local`). The install needs a Claude Code restart to load — tell the user and let them choose: continue without browser verification this run (re-run `/assess --branch={branch} --browser-verify` after restarting), or restart now and re-run. Do not install silently.
   - `cli_available:false` → skip with a one-line note.
2. **Run the app**: read an optional `config.workspace.frontend_verify` block (frontend_cmd / base_url / backend=mock|backend / mock_cmd / ready_path / routes); else infer the frontend `dev` command + the mock `start` command from each repo's `package.json` / `CLAUDE.md`. Start them as background processes against the branch's checkouts and poll `base_url` until ready (cap ~60s). If the run command can't be determined or the app won't start, skip with a recorded reason.
3. **Dispatch the assessor in browser-verification mode** with the live `Frontend:`/`Backend:` URLs and an FR→use-case list — it uses the chrome-devtools MCP tools (`navigate_page`, `click`, `fill`, `take_screenshot`, `list_console_messages`, `list_network_requests`) to exercise each use-case, asserting no error-level console messages and that each action's network call hits the right path with the spec-shaped body and the expected status (a happy-path 4xx/5xx is a CRITICAL gap).
4. **Tear down** the servers you started. Fold the verdict (`VERIFIED` / `ISSUES-FOUND` / `COULD-NOT-VERIFY`) into the final report; `ISSUES-FOUND` with a happy-path 4xx/5xx or white-screen means the score cannot be PASS.

### Step 5: Present the report

Show the full assessment report. If the score is PARTIAL or FAIL, list the fix assignments clearly:

```
## Assessment: {PASS / PARTIAL / FAIL}

{N} cross-repo issues found:
- {summary per issue}

Fix assignments:
- {repo}: {what to fix}
```

If the user wants to fix: they can either run `/deliver` with a fix round or fix manually and re-run `/assess`.
