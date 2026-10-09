---
name: explain
description: "Explain anything about a workspace — a domain concept, entity, user flow, service, repo, or piece of code — grounded in the curated PipeCrew context (platform docs, ADRs, repo AGENTS.md / agent-context) and the source when needed. Two perspectives: product (what / who / why, plain language) and technical (how, architect depth, cross-repo, file:line). Every answer cites its sources and states confidence; anything the context couldn't answer is reported as a context gap with a ready-to-run /learn hand-off. READ-ONLY — dispatches the `explainer` agent, whose tool list has no write or shell access."
---

# /explain

Ask a question, get an answer grounded in what PipeCrew already knows about your platform. It dispatches the read-only `explainer` agent at one of **two perspectives**:

- **Product** (`--product`) — *what it is, who uses it, who owns it, why it exists*. Plain language, domain vocabulary, no code in the body. For PMs, newcomers, stakeholders.
- **Technical** (`--technical`) — *how it works*. Which repos/services are involved, how they connect, the data and status lifecycle, the decisions behind it, and `file:line` references. For engineers and architects.

The agent reads the cheapest, most curated context first (platform docs → topology / decisions / ADRs → repo `AGENTS.md` + `agent-context/` → source) and stops when it has enough. When the curated context can't answer — or the code contradicts it — that's reported as a **context gap**, and the skill offers to hand it to `/learn` so the next answer doesn't have to dig.

This skill only **explains**. It does not diagnose incidents (`/troubleshoot`), change code (`/deliver`, `/patch`), refresh context (`/context-refresh`), or draw full diagrams (`/draw-diagram`).

## Usage

```
/explain <question>
/explain --product <question>
/explain --technical <question> [--repo=<name>]
/explain <question> [--workspace=<slug>] [--save]
```

### Flags

| Flag | Effect |
|------|--------|
| `--product` | Product perspective — what / who / why, plain language. |
| `--technical` | Technical perspective — how, architect depth, cross-repo, `file:line`. |
| `--repo=<name>` | Narrow the answer to one repo (a `config.json` repo key). The agent still notes cross-repo hops but doesn't trace them. |
| `--workspace=<slug>` | Target a specific onboarded workspace. Required when more than one exists (otherwise the skill asks). |
| `--save` | Also write the answer to `{workspace_root}/{slug}/runs/explain/{run_id}/answer.md`. Off by default — answers are printed, not persisted. |

### Examples

```
/explain what is a reach campaign and who owns it?
/explain --product how does a store go live?
/explain --technical how does a campaign change reach Google and Meta?
/explain --technical what happens when a task-status message arrives? --repo=reach-management-api
/explain why do we sync campaigns asynchronously instead of calling the APIs directly?
```

## Instructions

### Step 1: Resolve the source mode — workspace or repo-only

Resolve the workspace from the registry: `node {plugin_dir}/scripts/workspace-registry.js --resolve --json` (add `--workspace=<slug>` if passed). It applies the same session-scoped precedence every skill uses (`--workspace` → `$PIPECREW_WORKSPACE` → current directory → default → the only registered one).

- **Exit 0** → `{slug, path, root}`; set `{slug}` = `.slug` and `{workspace_root}` = `.root`. Verify `{workspace_root}/{slug}/config.json` and `context/platform.md` exist; if not, report and stop. If the current directory is a git repo whose top level is **not** one of the config's `repos[*].path` (the workspace was picked by default, not by location), ask once: `Explain using workspace {slug}, or just this repo ({repo-name})? (w / r)` — `r` switches to repo-only mode.
- **Exit 3 with several candidates** → list the slugs and ask which one.
- **Exit 3 with none registered** → **repo-only mode** if the current directory is a git repo (`git rev-parse --show-toplevel` → `{repo_path}`). Tell the user once: `No onboarded workspace — answering from this repo only (no cross-repo map). Run /discover for platform-wide answers.` If the current directory isn't a git repo, stop and point at `/discover`.

`--repo=<name>` must match a `config.json` repo key in workspace mode; if it doesn't, list the valid keys and stop. In repo-only mode it is ignored.

### Step 2: Resolve the perspective

| Situation | Perspective |
|-----------|-------------|
| `--product` or `--technical` passed | that one |
| Question is about **meaning, users, ownership, business purpose, what the user sees** ("what is…", "who uses…", "why do customers…") | `product` |
| Question is about **mechanism, services, APIs, events, data, code, architecture decisions** ("how does… work", "what calls…", "where is…", "why is it built…") | `technical` |
| Genuinely unclear | **ask once (below)** |

```
I can explain this two ways:

  [p]roduct   — what it is, who uses it, why it matters (plain language)
  [t]echnical — how it works across services and code (architect depth)

(p / t)
```

Ask at most this one question to disambiguate perspective.

**Route away before dispatching** when the question isn't an explanation:
- It describes a live malfunction ("X is failing", "why does Y return 500 today") → suggest `/troubleshoot <symptom>` and ask whether to explain how X is *meant* to work instead.
- It asks for a change ("add…", "make X do Y") → suggest `/deliver` or `/patch`; offer to explain the current behavior first.

### Step 3: Dispatch the explainer

**subagent_type**: `pipecrew:explainer`
**description**: `"Explain — {perspective} — {question, truncated to ~40 chars}"`

**Workspace-mode prompt:**

```
PERSPECTIVE: {product | technical}

Answer this question about the {workspace.name} platform, following your
tiered context loading and output format. Read-only. Cite every claim.

question: {the user's question, verbatim}
workspace_root: {workspace_root}
slug: {slug}
config.json: {workspace_root}/{slug}/config.json
context dir: {workspace_root}/{slug}/context
repo: {--repo value, or "any"}
```

**Repo-only-mode prompt:**

```
PERSPECTIVE: {product | technical}

Answer this question about the repo below, in repo-only mode (no onboarded
workspace — no cross-repo map). Follow your tiered context loading and output
format. Read-only. Cite every claim.

question: {the user's question, verbatim}
repo_path: {repo_path}
```

If the agent comes back with a clarifying question, relay it to the user and pass the answer back with **SendMessage to continue the SAME agent** — do not spawn a new one.

### Step 4: Present the answer + hand off gaps

Show the agent's answer as returned. Then:

- **`--save`** (workspace mode only) → write the answer to `{workspace_root}/{slug}/runs/explain/{YYYY-MM-DD-HHMMSS}-{question-slug}/answer.md` (`{question-slug}` = the first 6–8 words of the question kebab-cased, max 40 chars) and print the path. In repo-only mode, say `--save` needs an onboarded workspace and skip it.
- **Context gaps** (the `### Context gaps` section is not `None.`, workspace mode) → offer the hand-off:

  ```
  The curated context couldn't fully answer this. To teach the crew:

    /learn "{one-paragraph summary of the gaps, naming the doc each belongs in}" --workspace={slug}

  Run it now? (y / n)
  ```

  On `y`, invoke `/learn` with exactly that free-form text — `/learn` does its own tier-classification and per-finding approval, so nothing is written without the user's sign-off. On `n`, stop. In repo-only mode, suggest `/discover` instead (there's no workspace context to update).

Nothing else is written. Presenting the answer and naming the next step is where `/explain` ends.

## Edge cases

- **EC-1 — no question given** → ask once: `What do you want explained? A concept, a flow, a service, or a piece of code.`
- **EC-2 — multiple onboarded workspaces** → the registry infers from the current directory / default; if still ambiguous, ask (Step 1).
- **EC-3 — no onboarded workspace** → repo-only mode, clearly labeled; the agent's Confidence line says `repo-only mode`. No `/learn` hand-off.
- **EC-4 — ambiguous perspective** → the single `p / t` question (Step 2).
- **EC-5 — incident or change request** → route to `/troubleshoot` / `/deliver` / `/patch` before dispatching (Step 2).
- **EC-6 — context contradicts code** → the agent trusts the code, says so, and lists the stale doc under Context gaps, which feeds the `/learn` hand-off.

## See also

- [`agents/explainer.md`](../../agents/explainer.md) — the read-only agent this skill dispatches (perspectives, tiered context loading, output format)
- [`skills/brainstorm/SKILL.md`](../brainstorm/SKILL.md) — same workspace + perspective resolution, for *what to build* instead of *how it works*
- [`skills/learn/SKILL.md`](../learn/SKILL.md) — where context gaps go to become durable docs
- [`skills/troubleshoot/SKILL.md`](../troubleshoot/SKILL.md) — read-only incident triage (symptom → root cause)
- [`scripts/workspace-registry.js`](../../scripts/workspace-registry.js) — the shared workspace resolver used in Step 1
