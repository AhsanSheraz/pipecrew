### Phase 6: Assessment (assessor)

**Spin-up decision** — the assessor is a cross-repo integration judge (see its charter below), so it only earns its tokens when there is a cross-repo surface to judge. Two skip conditions, checked in order:

1. **Single-repo skip.** Count the distinct repos that had COMPLETED implementation tasks. If only 1 repo was modified, **skip Phase 6 entirely** — the per-repo code reviewer in Phase 5.5 already covered it. Log: `"Only 1 repo modified ({repo-name}) — Phase 6 skipped. Cross-repo assessment requires 2+ repos."`

2. **Standalone-scope skip (2+ repos, no integration surface).** Even with 2+ repos modified, read the architect's `cross_repo_integration` flag from the AFFECTED_SERVICES block (`node {plugin_dir}/scripts/extract-block.js {run_dir}/outputs/phase-2-architecture.md AFFECTED_SERVICES`, field `cross_repo_integration`; or read `{run_dir}/outputs/blocks/affected-services.json`). If it is `false`, **skip Phase 6** — the repos changed independently with no shared contract, no service-to-service call, no cross-stack ref, and no frontend→backend binding, so there is nothing cross-repo to assess; the per-repo Phase 5.5 reviewers already covered each repo standalone. Log: `"{N} repos modified but cross_repo_integration=false ({cross_repo_rationale}) — Phase 6 skipped. No cross-repo surface to assess."` This is the path for bundled-but-independent changes and the same maintenance applied to multiple services.
   - **Fallback if the flag is missing** (older architect output, no `cross_repo_integration` field): do NOT skip — fall through to running the assessor. A missing flag must not silently drop integration verification. Log a warning so the architect prompt can be tightened.

On either skip: set Phase 6 status to SKIPPED and proceed to Phase 7. Otherwise (2+ repos AND `cross_repo_integration` is `true` or absent) run the assessor as below.

> **Routing note:** audit-finding remediation and standalone maintenance are usually better run through `/patch`, which has no assessor phase by design. If such work reaches `/deliver` and touches 2+ repos, the `cross_repo_integration=false` skip above is the safety net that keeps the assessor from spinning up on it.

**MANDATORY PRE-CHECK**: Before launching the assessor, read the scratchpad's Implementation Tasks table. Check every task's status. Build a status summary:

```
IMPLEMENTATION TASK STATUSES:
| Task | Status | Notes |
|------|--------|-------|
| Backend: {service} | COMPLETED/BLOCKED/SKIPPED/FAILED | {reason if not COMPLETED} |
| Frontend | COMPLETED/BLOCKED/SKIPPED/FAILED | {reason if not COMPLETED} |
| Mock | COMPLETED/BLOCKED/SKIPPED/FAILED | {reason if not COMPLETED} |
```

Pass this status summary to the assessor so it knows which repos to assess and which to flag as blockers.

#### Assessor dispatch — E1 slim input set

The assessor is a cross-repo integration judge, not a re-reviewer. The per-repo code reviewers (Phase 5.5) + fix round already verified craft, spec compliance per repo, and requirements coverage per repo. The assessor's **unique value** is the cross-repo view — wire shapes match, role gating symmetric, event/infra wiring aligns.

To keep token cost proportional to that value, **pass only these inputs** (do NOT pass `platform.md`, `audit-findings.md`, or full task bodies — the assessor doesn't need to re-derive architecture):

1. **Status summary table** (from pre-check above)
2. **Phase 3 spec diffs** file path: `{run_dir}/outputs/phase-3-diffs.md` (lists what changed in each spec)
3. **Phase 5.5 code-review report** path: `{run_dir}/outputs/phase-5-5-code-review.md` (findings + fix-round outcomes)
4. **Updated spec file paths** — one per affected service (the assessor reads them directly to verify wire shapes)
5. **Files-modified list per repo** — extract from the scratchpad's Implementation Tasks "Files Changed" column. This lets the assessor target its reads to what actually changed, not the whole repo.
6. **Endpoint inventory** — a flat list of `method path → DTO` entries extracted from the spec diffs. Pre-compute this in the orchestrator from Phase 3 output; the assessor uses it as its wire-shape checklist.

Do NOT pass requirements or architecture files in the prompt. The assessor is forbidden from re-reading them — if it needs a specific FR/EC detail, it reads the `phase-5-5-code-review.md` which already maps findings to requirements. This is a deliberate scope narrowing.

#### Dispatch

Launch the `{slug}-assessor` agent (published by onboarding Phase C Step 3 to `~/.claude/agents/`). If it does not exist, fall back to `subagent_type: general-purpose` with a preamble that reads `{workspace_root}/{slug}/agents/assessor.md` — and log a warning prompting `/discover --resume --workspace={slug}` to publish workspace agents.

**Tool**: `Agent`
**subagent_type**: `{slug}-assessor` (substitute actual slug, e.g., `dal-assessor`)
**description**: `"Cross-repo assessment — {feature-slug}"`

```
Assess cross-repo integration for feature "{feature_summary}".

IMPLEMENTATION TASK STATUSES:
{status summary table from pre-check above — CRITICAL: check this FIRST; BLOCKED or FAILED tasks cannot be PASS}

INPUT FILES (read these yourself via Read tool — do NOT request re-reads of platform.md or task bodies; scope is narrowed to these files):
- Phase 3 spec diffs: {run_dir}/outputs/phase-3-diffs.md
- Phase 5.5 code review + fix-round report: {run_dir}/outputs/phase-5-5-code-review.md

UPDATED SPEC FILES (read to verify wire shapes):
{list spec file paths for each affected service}

FILES CHANGED (target your reads to these):
{for each COMPLETED task in the scratchpad:}
  - {repo}: {files-changed list from scratchpad column}

ENDPOINT INVENTORY (pre-computed from spec diffs — use as your wire-shape checklist):
{flat list: method path → response DTO | request DTO}

SCOPE: cross-repo integration only.
1. Wire shapes agree across backend ↔ frontend ↔ mock for every endpoint in the inventory.
2. Requirements surfaced by both sides of each wire are enforced consistently (e.g., a role gate on the server is mirrored by a frontend route guard).
3. Event/infra wiring aligns (queue names, bucket ARNs, event payload fields).
4. End-to-end story — trace each listed endpoint from UI action through API through persistence back to UI.

CRITICAL FOR THIS DISPATCH (do not skip):
- **Score constraint.** Score is PASS / PARTIAL / FAIL. **Cannot be PASS** if any task above is BLOCKED or FAILED, or if any critical cross-repo gap is unfixed. Default to FAIL on uncertainty — re-running is cheap; shipping a broken integration is not.
- **Save to `{run_dir}/assessment.md`.** Phase 7 reporter reads this file.
- **Walk every endpoint in the inventory above.** For each `method path → DTO`, verify wire-shape agreement across the affected sides (backend↔frontend↔mock). Missing one is a critical cross-repo gap.
- **Cross-repo focus only.** Do NOT re-review per-file craft (Phase 5.5 covered it), do NOT re-derive architecture from platform.md, do NOT re-inspect un-modified files, do NOT produce fix assignments for findings already addressed in the Phase 5.5 fix round.

Now: assess the cross-repo integration for "{feature_summary}" and reply with score + 3-5 sentence summary + any deployment-blockers.
```

Wait for the assessor to complete and present the report to the user.

**If the assessor found cross-repo issues not caught by Phase 5.5**, ask: "Should I dispatch fix-round agents to address these?"

If yes, dispatch fixes via the **same `Agent` tool pattern as Phase 5** — one `Agent` call per repo that has fixes, all in a single assistant message so they run in parallel. Use the same generic implementer agents (`spring-boot-implementer`, `react-implementer`, `cdk-stack-implementer`, `mock-implementer`). **Include the requirement reference (FR-X / EC-X) from the assessor's fix assignment** in each fix prompt so the agent can map fixes back to requirements.

Fixes must be applied to the existing feature worktrees from Phase 5 — never on main. If a worktree is missing (cleanup happened), recreate it with `Bash`: `cd {repo_path} && git worktree add ../{repo-name}-{feature-slug} feature/{feature-slug}`. If `--no-worktrees` was passed, apply fixes on the current branch of each repo.

**Fix prompt template** (use for every fix dispatch):

```
You are applying fixes in the {tech-type} worktree at {worktree_path} (branch: feature/{feature-slug}). Work directly in this worktree — do NOT create a new worktree or switch branches.

First read {worktree_path}/CLAUDE.md to confirm the repo's conventions.

FIX LIST from cross-repo assessment:

## Fix 1 — {short title} ({CRITICAL|NON-CRITICAL})
**File**: {path:line}
**Requirement**: {FR-X / EC-X}
**Problem**: {one sentence describing what's wrong}
**Change**: {exact code change or behavior the fix should produce}

## Fix 2 — ...

[Repeat for every fix in this repo.]

After applying all fixes, run {repo's test command — mvn test / npm test -- --run / npm run build} and report pass/fail.

If any existing test fails because it relied on the old (buggy) behavior, update those tests — the fix is correct.

Report: files modified (with what changed), test results, FR/EC coverage map (which file:line enforces each requirement after the fix).

Do not touch any other feature or make any changes outside this fix list.
```

Wait for all fix dispatches to complete. If there were critical cross-repo issues, re-run the assessor (same `Agent` call as the first pass) to verify the fixes.

**Update scratchpad**: Set Phase 6 Status to COMPLETED. Record score and fix rounds.

---
