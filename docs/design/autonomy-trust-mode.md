# Design: Autonomy / "trust mode" for `/deliver`

> Status: proposed (not yet implemented). Authored 2026-06-09.

## Context

Today every `/deliver` run pauses at 7 human-approval gates (requirements, architecture,
spec/contract, plan, UX, code-review fix-round, PR publish). That is the right default for a
new workspace — but once the user has run several features and tuned the workspace through a
couple of `/learn` turns, the routine gates become friction with little payoff. The goal is an
opt-in way to let a trusted workspace run with fewer (or no) approval pauses, earned over time.

**Decisions locked with the user:**
- **Graduated levels** — `interactive` (default, today) → `checkpoints` (auto-approve routine
  gates, still pause at spec/contract + PR publish) → `full` (skip *all* approval gates).
- **Suggested unlock** — the setting is always manual; pre-flight only *detects readiness and
  offers* it once. The plugin never flips autonomy silently.
- **Hard-failure-only floor** — in `full`, even PR publish auto-confirms. The *only* thing that
  halts an autonomous run is a real failure (assessor FAIL/blockers, critical security findings,
  contract/spec validation failure, unrecoverable build/test failure). "Skip gates" means "don't
  pause when things look fine," never "ignore problems."

Outcome: a workspace can declare `settings.autonomy` in `config.json` (or pass `--autonomy=`
per run), and the pipeline runs with the matching number of pauses, while every auto-approved
gate is still logged for the audit trail.

## Autonomy model

Effective level resolved with precedence: **`--autonomy=` flag > `config.settings.autonomy` > `interactive`**.

| Gate | Phase | Auto-approves at |
|---|---|---|
| Requirements approval | 1 | `checkpoints` |
| Architecture approval + ADR prompt | 2 | `checkpoints` (ADR auto = "no") |
| Plan approval | 4.5 | `checkpoints` (auto = "Approve all") |
| UX recommendations | 5b | `checkpoints` |
| Code-review fix-round dispatch | 5.5 | `checkpoints` (auto-dispatch fix round; generalizes today's `--auto-fix-mechanical`) |
| Spec / contract approval | 3 | `full` only |
| Spec-sync follow-up | 3 | `full` only (default "no" anyway) |
| PR publish confirm | 8 | `full` only |
| End-of-run feedback prompt | 8 | suppressed at `checkpoints`+`full` (behaves like `--no-feedback-prompt`) |

**Hard-failure floor — always halts, never auto-approved at any level:**
Phase 6 assessor FAIL/blockers · Phase 5.75 critical security findings · Phase 3 contract/spec
validation failure · build/test failure with no auto-fix path.

## Implementation

### 1. New resolver script — `scripts/autonomy.js` (zero-dep, mirrors `gate.js`)
- `node autonomy.js resolve --workspace-config=<path> [--flag=<level>]` → prints effective level (precedence above).
- `node autonomy.js readiness --workspace-dir=<dir>` → prints JSON
  `{completed_runs, learn_turns, gate_rejections, qualifies, suggested_level}`.
  - `completed_runs`: count dirs in `runs/deliver/*` whose `scratchpad.md` has `Status: COMPLETED`
    (pattern confirmed in `pre-flight.md:43`).
  - `learn_turns`: count `^## \d{4}-\d{2}-\d{2}` headers in `history/learn-log.md`
    (format confirmed in `skills/learn/SKILL.md:382`).
  - `qualifies` true when current level is `interactive` AND `completed_runs >= 5` AND `learn_turns >= 2`;
    `suggested_level` = `checkpoints` (never auto-suggest `full` — that's a deliberate manual step up).
- Reuse `scripts/workspace-root.js` to resolve the workspace dir.
- Co-located `scripts/autonomy.test.js`: precedence cases + readiness counting against a synthetic dir.

### 2. Config schema — `scripts/validate-config.js`
- Add `const VALID_AUTONOMY = ['interactive', 'checkpoints', 'full'];`.
- Validate `config.settings.autonomy` when `settings` present (enum check; optional; default `interactive`).
- Extend `scripts/validate-config.test.js` with valid/invalid autonomy cases.

### 3. Shared gate convention — `skills/deliver/SKILL.md`
- Add the `--autonomy=interactive|checkpoints|full` flag to the flag list (note: `--autonomy=full`
  is the "skip all gates" switch; flag overrides `settings.autonomy`).
- Add **Rule 5b — Gate autonomy**: defines the three levels, the auto-approve table above, the
  hard-failure floor, and the requirement to emit a `gate` checkpoint (`outcome: auto-approved`,
  `autonomy: <level>`) instead of opening a real gate. Each gate site then carries a one-liner:
  *"Before pausing, apply Rule 5b — if this gate auto-approves at the effective level, log the
  decision and continue without pausing."*

### 4. Gate sites — wrap each with the Rule 5b check
- **Explicit gates** (`phase-4-plan.md:74`, `phase-5.5-code-review.md:228`): skip the
  `gate.js open` call entirely when the gate auto-approves; record the auto-decision instead.
  5.5 generalizes the existing `--auto-fix-mechanical` path — at `checkpoints`+ it auto-dispatches
  the fix round (still re-classifying architectural criticals as a hard-stop within the floor).
- **Implicit gates** (`phase-1-requirements.md:46`, `phase-2-architecture.md:58`,
  `phase-3-spec-edit.md:186`, `phase-5-build.md:140`, `phase-8-pr-publish.md` confirm + feedback):
  change "present → wait" to "present; if auto-approved at level, emit checkpoint + continue; else wait."

### 5. Pre-flight — `skills/deliver/phases/pre-flight.md`
- Resolve effective autonomy once via `autonomy.js resolve`; write `Autonomy: <level>` into the
  scratchpad header (extend the template at `pre-flight.md:30`).
- If effective == `interactive`: run `autonomy.js readiness`. If `qualifies` AND not previously
  offered (guard with a marker file `{workspace_dir}/.autonomy-suggested`), print the one-time
  suggestion to enable `checkpoints`. User decides; on yes, write `settings.autonomy` to config.json.

### 6. Observability — `rules/observability.md` + `skills/deliver/phases/phase-7-report.md`
- Add a `gate` event to the schema: `{event, phase, gate, outcome: approved|rejected|auto-approved|awaiting, autonomy}`.
- Reporter surfaces a line: *"N gates auto-approved (autonomy=full)"* so auto-runs aren't silent.

### 7. Site-view (light) — `skills/site-view/server.js` + `docs/site-view.md`
- Auto-approved gates simply never write `awaiting_input.json`, so no false "waiting" banner.
- Note in `docs/site-view.md` that auto-approved gates appear in the timeline via the `gate`
  checkpoint. A richer "auto-approved pulse" UI is a follow-up, not core.

### 8. Docs
- `README.md` + `docs/PIPECREW-DISCOVERY.md`: short "Autonomy / trust mode" section (levels, how to
  enable, the safety floor).
- Marketing website (`pipecrew-website` repo): follow-up, separate PR.

## Verification

1. `node scripts/autonomy.js resolve` against synthetic configs — confirm precedence
   (flag > config > default) for all three levels.
2. `node scripts/autonomy.js readiness` against a synthetic workspace dir with N fake completed
   run dirs + a learn-log with M headers — confirm counts + `qualifies` threshold.
3. `node scripts/validate-config.js` on configs with valid/invalid `settings.autonomy` — enum enforced.
4. `node eval/run.js` — 6/6 PASS, including the new + extended co-located tests.
5. End-to-end smoke via `/simulate-run`: generate the demo workspace, set `settings.autonomy: full`,
   confirm the scratchpad header records `Autonomy: full` and gate checkpoints show `auto-approved`.

## Out of scope (explicit)
- Auto-unlock (rejected — trust is a human judgment, not a run counter).
- Per-gate user-configurable mapping (the level→gate table is fixed; revisit if requested).
- Rich site-view "auto-approved" animation (timeline checkpoint is enough for v1).
