# PipeCrew — what it is

A Claude Code plugin that turns one Claude session into the orchestrator of a **multi-repo agent crew**. It's spec-first, config-driven, and runs end-to-end: from "I have these repos lying around" all the way to "draft PRs are open across N repos and the crew has learned from your feedback."

Top-level pieces:
- **13 skills** (slash commands) under `skills/`
- **24 agents** under `agents/` (architect, task-planner, repo-discoverer, implementers per stack, reviewers, learner, security, etc.)
- **Scripts** under `scripts/` — non-LLM utilities the skills call (validators, block extractors, gate driver, observability)
- **Templates** under `templates/` — workspace config schema, per-stack convention docs, agent prompts
- **Plugin hook** in `.claude-plugin/hooks/hooks.json` — installs a Bash `PreToolUse` guard that activates only during `/troubleshoot`

---

# The core mental model

Every command operates against a **workspace** — a directory under a configurable workspaces root (`~/.claude/pipecrew/workspaces/{slug}/` by default, set once via `scripts/workspace-root.js`). The full layout (workspace + per-repo + user-level):

### Workspace tier

```
{workspace_root}/{slug}/
│
├── config.json                                    workspace metadata: repos · services · domain · spec files · spec_copies
│                                                    (validated by scripts/validate-config.js; read by every skill's pre-flight)
│
├── context/                                       active workspace context (read by orchestration-tier agents every dispatch)
│   ├── platform.md                                domain · architecture · Established Patterns · OBSERVABILITY block ·
│   │                                                Known Constraints (workspace-wide reference; read by orchestration-tier
│   │                                                agents — architect, planner, UX, assessor, learner, context-manager,
│   │                                                troubleshooter — NOT loaded per implementer dispatch)
│   ├── audit-findings.md                          real bugs / code smells from B2 scan, by severity + repo
│   ├── architecture-overview.mmd                  high-level C4 block diagram (~10 nodes, 4 subgraphs)
│   ├── architecture.mmd                           detailed topology with every service / DB / queue / Lambda + edge labels
│   └── diagrams/                                  (only when /draw-diagram --topic was used)
│       ├── auth-flow.mmd                          example focused topic diagram
│       ├── event-flow.mmd                         example focused topic diagram
│       └── audit-{YYYY-MM-DD}.md                  (only from /draw-diagram --audit)
│
├── history/                                       durable workspace history (NOT auto-loaded — humans + next /learn dedup)
│   └── learn-log.md                               append-only — populated by /learn over time as institutional memory
│
├── agents/                                        workspace-tailored agent definitions
│   ├── {slug}-product-owner.md                    dispatched in /deliver Phase 1
│   ├── {slug}-ux-consultant.md                    dispatched in /deliver Phase 5b
│   ├── {slug}-assessor.md                         dispatched in /deliver Phase 6 + /assess
│   ├── {slug}-troubleshooter.md                   dispatched in /troubleshoot (read-only)
│   └── {slug}-{type}-implementer.md               (optional — only if a stack has no plugin agent;
│                                                    e.g. Rails / Phoenix / Go-Gin / .NET workspaces)
│
├── agent-memory/                                  architect-owned ADRs (created on first ADR gate)
│   └── solution-architect/
│       └── adrs.md                                Architecture Decision Records — appended at the
│                                                    optional ADR gate after Phase 2 approval
│
├── deferred/                                      deferred follow-up files (only when /deliver Phase 4.5
│   │                                                user picked "Minimum only")
│   └── {feature-slug}.md                          pending sub-tasks; consumed by /deliver --from-deferred=<slug>;
│                                                    Phase 7 flips status: pending → consumed on success
│
└── runs/                                          per-invocation run dirs — one tree per skill
    │
    ├── discover/
    │   └── {YYYY-MM-DD-HHMMSS}-{slug}/            run_id
    │       ├── scratchpad.md                      phase state for --resume
    │       ├── checkpoints.jsonl                  unified machine event log (run_start, phase_start/end, agent_end, retry, run_end)
    │       ├── outputs/
    │       │   ├── platform-draft.md              intermediate (committed to context/platform.md in Phase C)
    │       │   └── repo-profiles/                 ← Phase B2.0 — one file per repo (consumed by architect in B2)
    │       │       └── {repo-key}.json            REPO_PROFILE: framework · entities · endpoints · integrations · auth ·
    │       │                                        persistence · tests · key_conventions · audit_findings (~3 KB)
    │       └── report.md                          Phase D summary
    │
    ├── deliver/
    │   └── {YYYY-MM-DD-HHMMSS}-{feature-slug}/    run_id
    │       ├── scratchpad.md                      phase state · Architecture Flags · Implementation Tasks · Agent Dispatch Log
    │       ├── checkpoints.jsonl                  unified machine event log
    │       ├── pr_urls.json                       (only when --with-pr was used; structured PR map)
    │       ├── outputs/                           phase artifacts (the human-narrative side)
    │       │   ├── phase-1-requirements.md        product-owner output (FR-X / EC-X)
    │       │   ├── phase-2-architecture.md        solution-architect output (full design doc)
    │       │   ├── phase-3-diffs.md               combined contract + spec diffs from Phase 3a/3b
    │       │   ├── phase-5-5-code-review.md       per-repo reviewer reports concatenated
    │       │   ├── phase-6-assess.md              assessor's cross-repo verdict (only when Phase 6 ran)
    │       │   └── blocks/                        per-block JSON side files (split by scripts/split-design.js after Phase 2)
    │       │       ├── affected-services.json     SVCs touched + spec_policy + endpoints + fr_ids
    │       │       ├── affected-contracts.json    (only when contracts touched)
    │       │       ├── api-design.json            architect's API design payload
    │       │       ├── contract-design.json       (only when contracts touched)
    │       │       ├── data-model.json            entity/field changes
    │       │       ├── infrastructure-impact.json (only when infra touched)
    │       │       ├── task-skeleton.json         architect's coarse M/D sub-task skeleton (consumed by task-planner in Phase 4.5)
    │       │       └── findings-summary.json      reviewer counts (per-repo report Step 1.5 also writes here)
    │       ├── tasks/                             per-sub-task markdown files written by task-planner persist mode
    │       │   ├── {feature-slug}-{6hex}.md       one per sub-task (frontmatter: id, repo, fr_refs, status: todo→done, …)
    │       │   └── {feature-slug}-review-{sev}-{slug}.md   one per Phase 5.5 finding (severity + classification)
    │       ├── review/                            per-repo Phase 5.5 reports (saved per reviewer dispatch)
    │       │   └── {repo-name}.md
    │       ├── fix-rounds/                        (only if Phase 5.5 fix rounds ran)
    │       │   └── round-1/
    │       │       └── {repo-name}.md             implementer's fix-round outcome per repo
    │       ├── security-review.md                 (only when Phase 5.75 ran — security-consultant report)
    │       ├── assessment.md                      Phase 6 output (assessor's structured verdict)
    │       └── report.md                          Phase 7 final report (waterfall · token breakdown · trends · insights)
    │
    ├── learn/
    │   └── {YYYY-MM-DD-HHMMSS}-{source-slug}/     source-slug = pr-31 / run-foo / branch-bar / text
    │       ├── scratchpad.md
    │       ├── checkpoints.jsonl
    │       └── learner-output.md                  full feedback-learner reasoning trail (raw)
    │
    ├── context-refresh/
    │   ├── state.json                             per-repo head_sha + last-refresh timestamp + fast_runs_since_full
    │   │                                            (used to skip unchanged repos on the fast path; --full forces re-verification)
    │   └── {YYYY-MM-DD-HHMMSS}-{slug-or-repo}/
    │       ├── scratchpad.md
    │       └── checkpoints.jsonl
    │
    └── troubleshoot/
        └── {YYYY-MM-DD-HHMMSS}-{symptom-slug}/    symptom-slug = first 6-8 words of the symptom, kebab-cased
            ├── scratchpad.md                      initial inputs (symptom, flags, env, user/trace IDs)
            ├── checkpoints.jsonl
            └── report.md                          investigation report (root cause Found / Localized / Not yet · next action · runbook candidate)
```

### Per-repo tier (created by `/discover` Phase C, lives inside each repo)

```
{repo}/
├── CLAUDE.md                                      project summary · Stack/Role · Build & run · Must-know ·
│                                                    Quick facts · Deep context (index pointing at agent-context/)
│                                                    — read by every agent that touches this repo (R1)
│
└── agent-context/                                 opt-in per repo (recommended for complex repos)
    ├── architecture.md                            repo-internal architecture
    ├── AGENT_INDEX.md                             feature catalog — used by R10 to find analogs
    ├── api-conventions.md                         (api-service repos)
    ├── common/                                    cross-cutting topic files (each indexed in CLAUDE.md's Deep context)
    │   ├── TESTING.md                             test framework, fixtures, harness
    │   ├── AWS_INTEGRATION.md                     (when the repo imports an AWS SDK)
    │   ├── DESIGN_SYSTEM.md                       (frontend repos only — Phase B3 emits this)
    │   └── …                                      other topics surfaced during Phase C scan
    └── features/                                  one file per shipped feature — context-manager appends here in /deliver Phase 7
        └── {feature-slug}.md                      what shipped + key design decisions
```

### User-level tier (under `~/.claude/`)

```
~/.claude/
├── pipecrew/
│   └── config.json                                workspaces-root setting (set once by /discover Pre-phase 0)
│
├── agents/                                        Claude Code's user-level agents dir
│   ├── {slug}-product-owner.md                    ┐  copy of {workspace_root}/{slug}/agents/{role}.md
│   ├── {slug}-ux-consultant.md                    │  published by /discover Phase C step 3 so
│   ├── {slug}-assessor.md                         │  Claude Code's `subagent_type` resolves
│   └── {slug}-troubleshooter.md                   ┘
│
├── stats-cache.json                               daily token aggregates per model (read by reporter for budget gates)
│
└── .pipecrew-troubleshooter-active                marker file — exists ONLY during an active /troubleshoot run
                                                     (orchestrator pid + run_id; the bash-guard hook checks for this
                                                      before vetting Bash calls. Auto-cleaned on stale pid.)
```

`run_id` = `{YYYY-MM-DD-HHMMSS}-{slug-or-feature-or-symptom}`. Every skill emits the same JSONL event schema (`run_start`, `phase_start/end`, `agent_end`, `retry`, `bash_slow`, `run_end`) into its run dir's `checkpoints.jsonl` — that's what powers the live UI, the post-hoc reporter, and trend comparison across runs.

---

# The 13 skills

## Setup & maintenance
| Skill | What it does |
|---|---|
| `/discover` | One-time onboarding — scan repos, interrogate domain, write workspace files |
| `/scaffold` | Create empty repos `--from-scratch` (from a brief) or `--from-example` (clone structure). Standalone or invoked by `/discover --greenfield` |
| `/context-refresh` | Audit/refresh `platform.md` and per-repo `CLAUDE.md`/`agent-context/`/`DESIGN_SYSTEM.md` (with a git-diff fast path + periodic full-audit safety net) |
| `/draw-diagram` | Regenerate the two canonical Mermaid diagrams, or produce a focused `--topic=auth-flow` view, in flowchart or `--c4` style. `--scan` mode reads code directly without needing `/discover` to have run |

## Feature work
| Skill | What it does |
|---|---|
| `/deliver <feature>` | The headline pipeline — requirements → design → spec edits → parallel implementation → review → assessment → optional PR publish |
| `/review` | Standalone code review on one repo's branch (dispatches the right tech-stack reviewer agent) |
| `/assess` | Standalone cross-repo assessment of a branch (wire-shape agreement, requirement symmetry, event/infra wiring) |

## Learning & ops
| Skill | What it does |
|---|---|
| `/learn` | Read feedback from a merged PR / `/deliver` run / branch diff / free-form text; propose tier-classified doc updates; optionally dispatch implementers to bring the existing branch in line with the new convention |
| `/troubleshoot` | Read-only cross-repo incident triage. Three layers of read-only enforcement: agent system prompt, `troubleshooter-bash-guard.js`, and a `PreToolUse` hook that self-gates on a marker file so it only activates during a live `/troubleshoot` run |

## UI
| Skill | What it does |
|---|---|
| `/site-view` | Live browser UI on `127.0.0.1:5173` — characters animate queued → working → done as the orchestrator progresses, fed by SSE off `scratchpad.md` + `checkpoints.jsonl`. Auto-started by `/deliver`. |
| `/siteview-list` | Inventory site-view servers running on ports 5173–5195 |
| `/siteview-cleanup` | Kill stale site-view servers (`--keep-port`, `--keep-run`, `--keep-latest`, `--all`); defaults to `--dry-run` |
| `/simulate-run` | Fabricates a fully-populated demo workspace (zero agent cost) and animates it through the UI. For UI regression testing and demos. |

---

# Step-by-step: `/discover` (one-time onboarding)

Pre-phase 0:
1. Resolve workspaces root (prompt once, persist to `~/.claude/pipecrew/config.json`).
2. Ask workspace name → derive slug.
3. Pre-flight usage gate (warn if today's `stats-cache.json` shows >80% of observed daily ceiling).
4. Compute `run_id`, create `runs/discover/{run_id}/`, emit `run_start`, write scratchpad.

Pipeline:

```
[Greenfield]  brainstorm + /scaffold  (only if --greenfield or zero repos)
  ↓
Phase A     scan parent dirs, detect tech stacks, confirm with user (~8k)
  ↓
Phase B1    4 domain questions to user
  ↓
Phase B2.0  repo-discoverer × N (Sonnet, parallel) → REPO_PROFILE JSON per repo (~3 KB each, ~20–25k Sonnet total for 7 repos)
  ↓
Phase B2    solution-architect (Opus, MODE: discovery) reads the JSON profiles, writes platform.md + audit-findings.md + diagrams (~30–45k Opus, synthesis only)
  ↓
Phase B2.6  observability extraction (CDK/Terraform/k8s/compose) → OBSERVABILITY block
  ↓
Phase B3    design system discovery (frontend repos only) (~20–40k Sonnet)
  ↓
Phase C     generate config.json → commit platform.md → publish workspace agents (slug-product-owner / -ux-consultant / -assessor / -troubleshooter to ~/.claude/agents/) → CLAUDE.md per repo (parallel) → optional agent-context per repo (parallel)
  ↓
Phase D     verify, validate checkpoints, write report.md
```

Each phase emits a one-line `[phase X ✔] ...` status. Scratchpad updated after every phase so `--resume` can pick up exactly where an interruption left off. Targeted refresh flag: `--refresh-observability`.

> **Note**: a previous version of `/discover` had a Phase B2.5 that produced per-stack convention docs (`stacks/{type}.md`). That phase was dropped; workspace-wide patterns now live in `platform.md § Established Patterns`, per-repo conventions live in each repo's `CLAUDE.md`, and generic stack-conventional pitfalls are pre-injected into per-task files by the task-planner from `{plugin_dir}/docs/pitfalls/{type}.md`. The discipline that B2.5's docs implicitly enforced is now explicit via **R10 (Inherit, don't invent)** in `docs/implementer-common-rules.md` and is gate-checked by reviewers via a Pattern Adherence pass.

---

# Step-by-step: `/deliver <feature>` (the main pipeline)

Pre-flight: load `config.json`, validate, derive which phases auto-run from what repos exist, create run dir, auto-start `/site-view`.

```
Phase 1   Requirements        {slug}-product-owner agent  →  WHAT  ──────── user gate
Phase 2   Architecture        solution-architect          →  HOW + AFFECTED_CONTRACTS + AFFECTED_SERVICES + DATA_MODEL + API_DESIGN + FRONTEND_ARCHITECTURE + INFRASTRUCTURE_IMPACT + RISKS + TASK_SKELETON (all JSON-fenced; split-design.js materializes outputs/blocks/*.json)  ──────── user gate
Phase 3a  Contract edit       schema-implementer (JSON Schema / Avro / Protobuf)  ┐
Phase 3b  Spec edit           openapi-spec-editor (in-place YAML edits)           ┴── single user gate over both diffs (orchestrator does git checkout to roll back if rejected)
Phase 4   Spec sync           copy edited specs to repos with `spec_copies`  ──── default OFF — opt-in via follow-up question at the Phase 3 gate
Phase 4.5 Implementation plan        task-planner agent (3 modes: draft / adjust / persist)  ──────── user gate
            ↳ draft   → produces plan summary from architect's TASK_SKELETON
            ↳ adjust  → re-issued per natural-language pushback round
            ↳ persist → writes per-task markdown files under {run_dir}/tasks/
                         + optional deferred follow-up file
Phase 5   PARALLEL DISPATCH (one Agent message, multiple tool calls):
            5a backend     spring-boot- / nestjs- / fastapi- / flask- / django- / python-worker-implementer (one per service)
            5b frontend    {slug}-ux-consultant → user gate → react- / nextjs-feature-implementer
            5c mock        mock-endpoint-implementer
            5d infra       cdk-stack-implementer / terraform-implementer (worktrees per repo by default)
Phase 5.5 Per-repo code review — {type}-reviewer per touched repo, parallel
            critical findings → user gate (auto-skipped with --auto-fix-mechanical when every critical is `mechanical`) → fix-round dispatch
Phase 5.75 Security review (security-consultant — keyword trigger or --force-security-review)
Phase 6   Cross-repo assessment by {slug}-assessor (skipped if only 1 repo changed)
Phase 7   Reporter agent → report.md → context-manager refresh → archive
Phase 8   --with-pr: user gate → push → draft PRs → cross-repo linking → append PR URLs to report.md
            Always: feedback offering (offer to dispatch /learn)
```

Cross-cutting rules:
- **Worktrees by default** for Phases 3 & 5 — each repo is touched in its own worktree, never the user's checkout. `--no-worktrees` opts out.
- **Section extraction**: architect output uses `<!-- BEGIN X --> ... <!-- END X -->` delimiters; `scripts/split-design.js` materializes each block as a separate file so later phases `cat outputs/blocks/<slug>.json` instead of re-reading the full design markdown.
- **Gate UX**: every approval gate calls `scripts/gate.js open/close` so the live UI shows a yellow "waiting for input" banner.
- **Transient retries**: all agent dispatches share a 529/503/network retry policy; emit `retry` + follow-up `agent_end` events.
- **Workspace agents** dispatch by slug-prefixed name; fall back to `general-purpose` with a preamble that reads the canonical agent file.

---

# The other skills, briefly

**`/review <repo-key> --branch=...`** — Looks up the repo's `type` in config, maps it to a reviewer agent (`spring-boot-code-reviewer` / `react-code-reviewer` / `nestjs-reviewer` / `nextjs-reviewer`), dispatches with the diff. Reports findings; doesn't fix.

**`/assess --branch=...`** — Finds repos that have the branch (≥ 2), gathers requirements (from `--requirements` / pipeline scratchpad / spec only), dispatches `{slug}-assessor` with focus on wire-shape agreement, requirement symmetry, event/infra wiring. Returns PASS / PARTIAL / FAIL with per-repo fix assignments.

**`/learn`** pipeline:
```
1. Resolve workspace
2. Collect signal (--pr via gh / --run / --branch / free text)
3. Dispatch feedback-learner (read-only)
4. Present findings tier-classified: run-local / repo-durable / workspace-durable / plugin-level   ─── per-finding user gate
5. Apply approved doc edits (Edit only, never full-file Write; never plugin-level)
6. Append to learn-log.md
6.5. Optional fix-round — group findings by repo, resolve implementer + branch (refuses main/master/dev), per-repo confirmation gate, parallel dispatch
7. One-line status + (if --run) update parent /deliver scratchpad row
```

**`/context-refresh`** — three scopes (single repo / `--workspace` / `--all`), two modes (`audit` / `refresh`). Smart fast path: maintains `runs/context-refresh/state.json` per repo; uses `git diff` to limit scope, falls back to a full audit on branch change, >100 modified files, >5 fast runs since last full, or `--full`.

**`/troubleshoot`** is the exception in this whole plugin — the only **read-only** skill, with three layers of enforcement (agent prompt, bash guard script, plugin hook gated by a marker file at `~/.claude/.pipecrew-troubleshooter-active`). The marker contains the orchestrator pid; the guard auto-cleans stale markers when the pid is dead. Outside an active `/troubleshoot` run, the hook is a no-op for every other Bash dispatch in the user's environment.

**`/draw-diagram`** — two source modes. Workspace mode dispatches `solution-architect` against pre-discovered `platform.md` (fast, narrative-grounded). Code-scan mode (`--scan` / `--repos`) dispatches `architecture-mapper` directly against repos with no `/discover` required. `--c4` switches output style; `--topic=<name>` produces a focused single-file diagram without touching the canonical pair; `--audit` reports staleness without writing.

**`/simulate-run`** — pure JS (`scripts/simulate-run.js`), no agents. Fabricates a complete demo workspace with two `/deliver` runs, two `/learn` runs, one `/discover` run, full diagrams, then steps the active deliver run through ~22 timeline events (~33s) so the UI animates. For demos and UI regression testing.

**`/site-view`** — Node server in `skills/site-view/server.js` watching the run's scratchpad + checkpoints, broadcasting state over SSE. Pyramid tiers rise as agents complete; yellow banner whenever a gate is open.

---

# What makes this thing tick

A few patterns that show up everywhere once you read the source:

1. **Config is the single source of truth** — `config.json` says which repos exist, their type, role, spec file, and (for frontend/mock) where copied specs live. Phase auto-detection in `/deliver` is derived from this, not hardcoded. Schema validated by `scripts/validate-config.js`.
2. **One run dir per invocation, one event log per run** — `runs/{skill}/{run_id}/checkpoints.jsonl` is unified across every skill, so the reporter and site-view work the same way for `/discover`, `/deliver`, `/learn`, `/context-refresh`, `/troubleshoot`.
3. **Scratchpad for resume, checkpoints for telemetry** — two different files, two different jobs.
4. **Section-extracted artifacts** — agents emit `<!-- BEGIN X -->` blocks; `scripts/extract-block.js` and `scripts/split-design.js` give later phases tiny, focused inputs instead of the full design doc.
5. **Tier-stratified docs** — workspace-level (`platform.md` § Established Patterns) governs cross-cutting convention; repo-level (`CLAUDE.md`, `agent-context/`, `DESIGN_SYSTEM.md`) governs implementation; plugin-level (`docs/pitfalls/{type}.md`) provides universal stack traps that the task-planner injects into per-task files. `/learn` and `/context-refresh` keep the workspace + repo tiers in sync; `/discover` bootstraps them. Implementers follow R10 (Inherit, don't invent) — find the closest analog in this repo before writing new code; reviewers gate-check via the Pattern Adherence pass.
6. **Architect–planner split for Phase 2 / 4.5** — SA owns architecture and emits a coarse `TASK_SKELETON` (per-repo M/D sub-task list grounded in `AFFECTED_SERVICES` + `RISKS`). The dedicated `task-planner` agent (Sonnet) hydrates the skeleton in Phase 4.5 with workspace-shaped material the architect didn't have (pitfalls, audit-findings, post-Phase-3 spec paths) and writes the task files. The orchestrator never reads the full architecture markdown — it routes between SA, the planner, and the user gate.
7. **Lazy phase loading** — `/deliver` loads only the active phase file into context; same for `/discover`. Keeps mid-run context lean.
8. **Hooks are scoped by marker, not by matcher** — the troubleshooter bash guard works around Claude Code's lack of `agentMatcher` by self-gating on a marker file, so it can be installed plugin-wide without affecting any other agent.
