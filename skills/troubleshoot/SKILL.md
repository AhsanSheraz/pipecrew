---
name: troubleshoot
description: "Cross-repo incident triage. Takes a one-line symptom + optional flags, runs a hypothesis-driven investigation against the workspace's logs and recent diffs (using the OBSERVABILITY routing table from platform.md), and writes a structured report. Read-only — never modifies code."
---

## Usage

```
/troubleshoot <symptom> [flags]
```

### Required

A free-form symptom description (one line is fine):

```
/troubleshoot bulk upload returns 500 for files larger than 10MB
```

### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--since` | no | `1h` | Log time window (`30m`, `2h`, `2026-04-28T10:00`). |
| `--repo` | no | auto | Narrow to one repo by name (skip cross-repo trace). |
| `--trace-id` | no | — | Trace / request ID — agent jumps straight to that path across services. |
| `--user-id` | no | — | User / tenant ID — for filtering logs and reproducing locally. |
| `--evidence` | no | — | Path to a local file with stack trace / HAR / log paste. Agent reads it instead of re-asking for it. |
| `--env` | no | `prod` | Env to investigate (`prod` / `staging` / `dev` / `local` — or whatever the workspace defines). |
| `--auto` | no | off | Skip the hypothesis-approval gate; agent picks the top candidate and investigates. Use for routine triage; leave off when prod is on fire. |
| `--workspace` | no | auto-detect | Workspace slug (reads config for repo list and which troubleshooter agent to dispatch). |
| `--learn` | no | off | At end of run, propose a runbook / platform.md update from what was learned. User approves before write. |

### Examples

```
/troubleshoot bulk upload 500s on files >10MB --since=2h --env=prod
/troubleshoot login redirect loop --user-id=a8f2 --evidence=./session.har
/troubleshoot worker DLQ growing --auto --since=30m
/troubleshoot 502 from gateway --trace-id=abc123 --learn
```

## Instructions

### Step 1: Read workspace config

Read `{workspace_root}/{workspace}/config.json`. Get the list of all repos and the `workspace.slug` value (used to dispatch the troubleshooter agent by name: `{slug}-troubleshooter`).

If `--workspace` was not provided, auto-detect by checking the current working directory against each `workspace_root/*/config.json`. If multiple match, ask the user to disambiguate.

### Step 2: Pre-flight — verify OBSERVABILITY block

Before dispatching the agent, confirm the platform.md OBSERVABILITY block is populated and valid:

```bash
node {plugin_dir}/scripts/validate-observability.js {workspace_root}/{slug}/context/platform.md
```

If the validator exits non-zero with "0 log destinations":
```
The OBSERVABILITY routing table in platform.md is empty — the troubleshooter
won't be able to query logs by service+env.

Options:
  1. Run /discover --refresh now to populate it.
  2. Continue anyway (agent will work from the symptom + recent diffs only,
     and will ask you to paste any logs it needs).

(1 / 2)?
```

If the validator exits non-zero with structural errors, surface them and stop — don't dispatch the agent against a malformed table.

### Step 3: Initialize run dir

```bash
mkdir -p {workspace_root}/{slug}/runs/troubleshoot/{timestamp}-{slug-of-symptom}
```

Where `{slug-of-symptom}` is the first 6-8 words of the symptom kebab-cased and truncated to 40 chars.

Write a `scratchpad.md` with the initial inputs (symptom, flags, env, user/trace IDs).

### Step 4: Dispatch the troubleshooter agent

**Tool**: `Agent`
**subagent_type**: `{slug}-troubleshooter` (published by `/discover` Phase C)
**description**: `"Troubleshoot — {symptom-truncated}"`
**prompt**:

```
Investigate the following symptom on the {{WORKSPACE_NAME}} platform.

SYMPTOM: {symptom}

FLAGS:
  since: {since}
  env: {env}
  repo: {repo or "any"}
  trace_id: {trace-id or "none"}
  user_id: {user-id or "none"}
  evidence_file: {evidence or "none"}
  auto: {true if --auto else false}

WORKSPACE CONTEXT:
- Platform context: ~/.claude/{slug}-context/platform.md (read this first)
- Workspace config: {workspace_root}/{slug}/config.json
- Run directory: {run_dir} (write your report.md here)

REPOS:
{for each repo in workspace config:}
- {repo.name} ({repo.type}, {repo.role}) at {repo.path}

INPUT MATERIAL:
{if evidence file provided:}
- Pre-supplied evidence: {evidence-path} (read it via the Read tool before
  forming hypotheses)

Follow your system prompt's investigation process:
  Step 0: Read platform.md, extract the OBSERVABILITY block.
  Step 1: Triage (≤3 questions, only if input is genuinely ambiguous).
  Step 2: Hypotheses ranked. {if --auto: "skip the user-approval gate."}
  Step 3: Investigate the top hypothesis using the OBSERVABILITY routing
          table to pick log destinations. Cross-repo trace where evidence
          points across a service boundary.
  Step 4: Cross-repo follow-through.
  Step 5: Write report.md to {run_dir}.

Report your final report.md path back to the orchestrator.
```

If `--auto` was passed, the agent runs end-to-end without prompting. Otherwise, the agent will pause at the hypotheses gate and surface the ranked list — you (the orchestrator) relay it to the user, capture their answer, and forward back to the agent.

### Step 5: Present the report

Read the agent's `report.md` and surface it to the user. Highlight:
- Root cause section (whether Found / Localized / Not yet).
- Suggested next action.
- Any "Runbook update candidate" the agent proposed.

If `--learn` was passed AND the agent proposed a runbook update:

```
The agent proposed adding this to the runbook / platform.md:

  > {proposed-entry}

Apply it? (yes / edit / no)
```

On `yes`: append to `docs/runbooks/{filename}.md` (create the runbooks dir if it doesn't exist) OR add to platform.md's `## Open Questions / Evolving Decisions` section if the entry is more about platform knowledge than incident response.

On `edit`: open an edit loop with the user to refine the entry before writing.

On `no`: skip — but keep the entry in the run's `report.md` for future reference.

### Step 6: Wrap up

Print a one-liner:

```
Troubleshoot run complete: {workspace_root}/{slug}/runs/troubleshoot/{run-id}/report.md
Root cause: {Found / Localized / Not yet}
Next action: {one-line summary}
```

If the user wants to act on the suggested fix:
- For a code fix in a single repo: they can run that repo's implementer agent directly with the fix-list from the report.
- For a cross-repo fix: they can run `/deliver` with the fix scope as the feature description.
- For an infra/config change: they edit and re-deploy manually — the troubleshooter is read-only on infra by design.
