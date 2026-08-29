---
name: brainstorm
description: "Brainstorm what to build (or how to build it) — one skill, two perspectives. PRODUCT perspective dispatches the product-brainstormer: `greenfield` (no onboarded workspace → a PROJECT_BRIEF, same path as /discover --greenfield) or `feature` (an onboarded workspace exists → a ranked FEATURE_BRIEF for the product-owner). TECHNICAL perspective (`--technical`) dispatches the solution-architect in MODE: brainstorm to diverge into 2–3 technical approaches with pros/cons and a recommendation. Auto-detects perspective and mode from the request; asks when it's unclear which. Standalone — dispatches the agent and presents the result."
---

# /brainstorm

A single entry point for ideation. It resolves the workspace root, then works at one of **two altitudes**:

- **Product perspective** (default) — *what to build and why*. Dispatches the `product-brainstormer`, which auto-detects:
  - **Greenfield** → no onboarded workspace yet → produces a `PROJECT_BRIEF` (identical to `/discover --greenfield`'s brainstorm step). From here you'd typically run `/scaffold` then `/discover`.
  - **Feature** → an onboarded workspace exists → reads `platform.md` and diverges into a ranked set of feature options (a `FEATURE_BRIEF`), recommends 1–2, hands off to the product-owner (via `/deliver`).
- **Technical perspective** (`--technical`) — *how to build it*. Dispatches the `solution-architect` in `MODE: brainstorm`, which diverges into **2–3 candidate technical approaches** with pros/cons and a recommendation, grounded in `platform.md`. Requires an onboarded workspace.

This skill only **brainstorms**. It does not scaffold, onboard, write requirements, or implement — it dispatches the right agent and presents its result.

**Perspective ≠ mode.** Perspective (product / technical) picks the *agent*; within the product perspective, mode (greenfield / feature) picks the product-brainstormer's *path*.

## Usage

```
/brainstorm [idea or theme]                     # auto-detect perspective + mode
/brainstorm --product [theme]                   # force product perspective
/brainstorm --technical [problem] [--workspace=<slug>]   # force technical perspective
/brainstorm --greenfield [idea]                 # product / greenfield
/brainstorm --feature [theme] [--workspace=<slug>]       # product / feature
/brainstorm --workspace=<slug> [theme]
```

### Arguments
- free text: the idea (greenfield), the area/theme to ideate in (feature), or the problem to explore approaches for (technical). Optional — the skill will prompt if absent.

### Flags
| Flag | Effect |
|------|--------|
| `--product` | Force the product perspective (dispatch the product-brainstormer). Greenfield vs feature is still auto-detected. |
| `--technical` | Force the technical perspective (dispatch the solution-architect in `MODE: brainstorm`). Requires a resolvable workspace. Skips the perspective auto-detect. |
| `--greenfield` | Force product / greenfield mode (brand-new project), even if a workspace exists. Implies `--product`. |
| `--feature` | Force product / feature mode (ideate on an onboarded workspace). Implies `--product`. Requires a resolvable workspace. |
| `--workspace=<slug>` | Target a specific onboarded workspace (implies an onboarded workspace exists). Required when more than one workspace exists and the perspective is technical or feature. |

### Examples
```
/brainstorm                                     # auto-detect from the request + what's on disk
/brainstorm a habit tracker for developers      # product / greenfield if no workspace, else confirms
/brainstorm --greenfield a habit tracker        # force new-project ideation
/brainstorm --feature improve the upload flow    # product feature ideation on the onboarded workspace
/brainstorm --technical how should we structure durable memory   # technical approaches via the architect
/brainstorm --workspace=my-saas payments         # feature ideation on a named workspace
```

## Instructions

### Step 0: Resolve the workspace root

Run `node {plugin_dir}/scripts/workspace-root.js --get` to get `{workspace_root}` (this reuses the same resolution `/discover` and `/deliver` use — env var → plugin config → default). Do NOT prompt to configure it here; if it's unset the resolver returns the default and no workspaces will be found (→ product / greenfield).

### Step 1: Enumerate onboarded workspaces

List the immediate subdirectories of `{workspace_root}/`. A directory is an **onboarded workspace** iff it contains `config.json` AND `context/platform.md`. Collect the matching slugs.

### Step 2: Resolve the perspective (product vs technical)

Perspective decides which agent runs. Resolve it in this order:

| Situation | Perspective |
|-----------|-------------|
| `--technical` passed | `technical` (skip the rest of this table) |
| `--product` / `--greenfield` / `--feature` passed | `product` |
| No onboarded workspace found | `product` (technical needs an existing platform to reason about — see EC-5) |
| Request is clearly about **user value / features / what to build / who it's for** | `product` |
| Request is clearly about **architecture / structure / approach / refactor / data model / performance / trade-offs / how to build it** | `technical` |
| Genuinely unclear which altitude the user wants | **ambiguous → confirm (Step 2a)** |

**Step 2a — perspective confirm (only when unclear).** When a request could be read either way — e.g. "restructure the durable memory in the best optimized way" reads as a product goal *and* a technical one — ask **exactly one** question, then proceed:

```
Your request could be a product question (what to build & why) or a technical one
(how to structure / architect it). Which do you want?

  [p]roduct   — features & user value        → product-brainstormer
  [t]echnical — solution approaches & design  → solution-architect

(p / t)
```

Do not ask more than this one question to disambiguate perspective.

- **technical** → go to Step 3 to resolve the workspace, then dispatch technical in Step 4.
- **product** → resolve the product mode in Step 2b, then Step 4.

**Step 2b — resolve the product mode (product perspective only): greenfield vs feature.**

| Situation | Mode |
|-----------|------|
| `--greenfield` passed | `greenfield` |
| `--feature` or `--workspace=<slug>` passed | `feature` (resolve the workspace per Step 3) |
| No onboarded workspace found | `greenfield` |
| Exactly one onboarded workspace, and the request clearly targets it | `feature` |
| One or more onboarded workspaces exist, but the user may mean a brand-new separate project | **ambiguous → confirm (Step 2c)** |

**Step 2c — greenfield/feature confirm (only when ambiguous).** When a workspace exists but it's unclear whether the user wants to ideate on it or start something new, ask **exactly one** question, then proceed:

```
Found an onboarded workspace: {slug}.

Do you want to:
  [f]eature    — brainstorm new features for {slug}
  [g]reenfield — brainstorm a brand-new, separate project

(f / g)
```

Do not ask more than this one question to disambiguate mode.

### Step 3: Resolve the workspace (technical and feature only)

Greenfield needs no workspace; **technical and feature both do** (the architect and the feature path read `config.json` + `platform.md`).

- `--workspace=<slug>` passed → use it; verify `{workspace_root}/{slug}/config.json` + `context/platform.md` exist, else report and stop.
- Exactly one onboarded workspace → use it.
- **Multiple onboarded workspaces and no `--workspace=`** → ask which one (list the slugs). This is the only other prompt the skill makes.

### Step 4: Dispatch + present

Load `phases/phase-brainstorm.md` and follow it. It dispatches the resolved agent — `product-brainstormer` (`MODE: greenfield` | `feature`) or `solution-architect` (`MODE: brainstorm`) — and presents the result.

## PHASE FILES

Each phase lives in its own file. Load only the active phase.

| Phase | File |
|-------|------|
| Brainstorm (dispatch + present) | `phases/phase-brainstorm.md` |

## Edge cases

- **EC-1 — no onboarded workspace, no idea given** → product / greenfield mode; prompt the user for the one-liner (`What do you want to build? Give me a rough idea — I'll ask follow-ups.`) before dispatching.
- **EC-2 — multiple onboarded workspaces** → ask which workspace, or honor `--workspace=<slug>` (Step 3).
- **EC-3 — ambiguous greenfield vs feature (workspace exists, user may mean a new project)** → the single confirm prompt in Step 2c, then proceed.
- **EC-4 — anti-bleed / altitude** is enforced inside the agents themselves. The `product-brainstormer` stays at product altitude (no implementation mechanics; `feature` mode grounds every option in `platform.md`, `greenfield` assumes no existing platform). The `solution-architect` in `MODE: brainstorm` stays at technical altitude but stops at options (no `<!-- BEGIN … -->` design blocks, no FR/EC, no code). This skill just picks perspective + mode; the agents hold the guardrails.
- **EC-5 — technical requested with no onboarded workspace** → the architect reasons over an existing platform, which doesn't exist yet. Tell the user: onboard first with `/discover`, or drop `--technical` to brainstorm the product greenfield. Do NOT silently fall back to product.
- **EC-6 — ambiguous perspective** → the single confirm prompt in Step 2a (product / technical), then proceed.

## See also

- [`agents/product-brainstormer.md`](../../agents/product-brainstormer.md) — the product-perspective agent (greenfield + feature)
- [`agents/solution-architect.md`](../../agents/solution-architect.md) — the technical-perspective agent; `/brainstorm --technical` dispatches its `MODE: brainstorm` (standalone) path
- [`skills/discover/phases/phase-greenfield-brainstorm.md`](../discover/phases/phase-greenfield-brainstorm.md) — the greenfield brainstorm step inside `/discover` (same agent, `MODE: greenfield`)
- [`templates/blocks/block-schemas.md`](../../templates/blocks/block-schemas.md) — schema for the `FEATURE_BRIEF` block emitted in feature mode
- [`scripts/workspace-root.js`](../../scripts/workspace-root.js) — the shared workspace-root resolver used in Step 0
