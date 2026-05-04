# /discover — efficiency enhancement plan

**Goal**: cut a typical 4-repo `/discover` run by ~40-50% wall-clock and tokens with no UX change.

**Diagnosis** (from reading the phase files + agent dispatches):
- Phase B2 is one Opus dispatch reading every repo's code in series (~80-120k Opus tokens).
- Phase B2 + B2.5 + B3 each re-read repo files; no shared scan cache.
- Phase B2.5 doesn't depend on B2's `platform.md` but runs sequentially after it.
- Phase C.4 (CLAUDE.md) and Phase C.5 (agent-context) dispatch `context-manager` per repo with mostly overlapping inputs.
- Re-running `/discover` on a workspace re-scans every repo even when nothing changed.

---

## Six wins, ranked by impact-per-effort

### 1. Pre-scan repos into a manifest (one JS script, no LLM)

Phase A currently regex-detects stacks but stops there. Extend it to emit a per-repo file inventory (entry points, route files, config files, test dirs, dep manifests) so B2 / B2.5 / B3 can query the manifest instead of walking the filesystem from scratch three times.

- **Mechanism**: new `scripts/extract-repo-manifest.js`, modeled on `scripts/extract-observability.js` (zero deps, regex-based, deterministic).
- **Output**: `{run_dir}/outputs/repo-manifests/{repo-key}.json` per repo.
- **Saving**: ~30% of agent file-reads across B2/B2.5/B3.
- **Risk**: low. Pure additive.

### 2. Run B2.5 in parallel with B2

B2.5 (per-stack discovery) consumes only Phase A's repo list, not B2's `platform.md`. Today they're sequential. Run them in the same orchestrator message — saves the longer of the two phase durations entirely.

- **Mechanism**: dispatch B2 architect AND all B2.5 stack agents in one orchestrator message.
- **Saving**: ~3-5 minutes wall-clock on a typical 4-repo workspace.
- **Risk**: low. Existing agent contracts unchanged.

### 3. Split B2 into Sonnet-discovery + Opus-synthesis

Same pattern as the recent `/deliver` Phase 2 / 4.5 split. Current B2 = one Opus dispatch reading all repos. Split into:

- **Per-repo discovery**: parallel Sonnet, one agent per repo, scans that repo's code, emits a structured `REPO_PROFILE` JSON (entities, routes, integration points).
- **Cross-repo synthesis**: one Opus dispatch reading just the JSON profiles, writes `platform.md`.

Same Opus depth on synthesis (where it matters); Sonnet does the bulk reads.

- **Saving**: B2 cost down ~50% with no quality loss for the synthesis.
- **Risk**: medium. Requires defining `REPO_PROFILE` schema + a thin `repo-discoverer` agent.

### 4. Add an outline-gate before full architect synthesis

Sonnet produces a 5k "platform outline" (sections + 1-line each), user approves the structure, then Opus writes the full `platform.md`. Most "I want to redo this" feedback happens at the structural level — catch it after a 5k pass instead of after a 100k pass.

- **Pattern source**: matches `--minimum-only` from `/deliver` Phase 4.5 (cheap preview before expensive commit).
- **Saving**: avoids wasted Opus tokens when the user wants major direction changes — one full `/discover` run rejected at gate today is more wasteful than three preview cycles tomorrow.
- **Risk**: low.

### 5. Combine Phase C.4 + Phase C.5 into one context-manager dispatch per repo

Currently two dispatches per repo with overlapping inputs (platform.md + stacks/{type}.md + repo scan). One dispatch in `full` mode produces both CLAUDE.md and agent-context.

- **Saving**: ~40% of C.5 cost (which is the most expensive Phase C step today).
- **Risk**: low. `context-manager` already supports a `full` mode.

### 6. Cache per-repo scan output across runs

Hash each repo's `git rev-parse HEAD`. On `/discover --resume` or `--refresh-stacks`, skip repos whose HEAD hasn't moved since the last run; only re-scan changed ones.

- **Pattern source**: `/context-refresh` already uses `runs/context-refresh/state.json`.
- **Mechanism**: write `{workspace_root}/{slug}/runs/discover/state.json` recording per-repo `head_sha` + `ran_at`. Step 1.5-style decision tree at the top of B2 / B2.5.
- **Saving**: huge for monorepos where most repos are stable but one moves.
- **Risk**: low. Read-only optimization that falls back to a full scan on any uncertainty (branch change, dirty tree, missing state).

---

## Smaller cleanups worth bundling

- **B3 ↔ B2 overlap**: have B2 emit a `FRONTEND_SIGNALS` block (component library, design system signals, etc.). B3 only runs if it found nothing or wants depth. Avoids re-reading every component file.
- **Phase D inline report**: today the orchestrator writes the Phase D summary inline. Could route through the existing `reporter` agent (Haiku, ~5k) for richer trend comparison across discover runs. Optional.

---

## Recommended sequencing

Land in this order — each builds on the previous and adds zero risk to the running pipeline:

1. **Wins 1, 2, 5** first. They're independent, low-risk, additive. Net 30-40% faster discover with no behavior change.
2. **Win 6** next. Adds the `state.json` infrastructure that future enhancements (and re-runs) benefit from.
3. **Wins 3, 4** last. Bigger architectural change (B2 split + outline gate). Once the manifest from Win 1 exists and `state.json` from Win 6 is in place, the per-repo discoverer agents are easier to scope.

After all six: typical `/discover` runs at roughly half the current Opus cost and ~half the wall-clock time, with the same outputs.

---

## Open question

`/discover` doesn't currently dispatch a `reporter` agent at Phase D. The `reporter` could be reused at end-of-run to produce a richer summary + trend comparison across `runs/discover/{run_id}/checkpoints.jsonl` files. This is orthogonal to the six wins but would make the new `state.json` (Win 6) more useful to a human reader.
