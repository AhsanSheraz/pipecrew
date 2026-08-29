## Phase Brainstorm: Dispatch + Present

Runs after the SKILL.md resolved `{workspace_root}`, the **perspective** (`product` | `technical`), the product **mode** (`greenfield` | `feature`, product perspective only), and — for `feature` and `technical` — the target `{slug}`.

- **product / greenfield** → dispatch `product-brainstormer` (`MODE: greenfield`)
- **product / feature** → dispatch `product-brainstormer` (`MODE: feature`)
- **technical** → dispatch `solution-architect` (`MODE: brainstorm`)

### Step 1: Gather the seed

- **greenfield**: if the user gave no idea, ask once:

  ```
  What do you want to build? Give me a rough idea — I'll ask follow-ups.
  ```

- **feature**: if the user gave no theme, ask once:

  ```
  What area or goal do you want to explore features around in {slug}?
  ```

- **technical**: if the user gave no problem statement, ask once:

  ```
  What technical problem or area do you want approaches for in {slug}?
  ```

Don't over-interrogate here — the agent does the real questioning. One prompt at most.

### Step 2: Dispatch the resolved agent

**The first line of every dispatch prompt is the `MODE:` line** — it selects the agent's path.

#### 2a — product perspective → `product-brainstormer`

**subagent_type**: `pipecrew:product-brainstormer`
**description**: `"Brainstorm — {mode} — {slug-or-'new'}"`

**Greenfield prompt:**

```
MODE: greenfield

Turn this idea into a PROJECT_BRIEF. Ask clarifying questions in rounds
(one round at a time), propose a stack and repo topology, and produce the
brief using the delimited <!-- BEGIN PROJECT_BRIEF --> format. Iterate
until I approve.

Idea: {user's one-liner}
Workspace name: {name if the user gave one, else omit}
```

**Feature prompt:**

```
MODE: feature

An onboarded workspace exists. Diverge into a ranked set of DISTINCT feature
options grounded in the platform, recommend 1-2, and hand off to the
product-owner. Do NOT write FR/EC, API design, or UX — options only. Stay at
product altitude — no implementation mechanics (that's the solution-architect).

workspace_root: {workspace_root}
slug: {slug}
platform.md: {workspace_root}/{slug}/context/platform.md
theme: {user's theme, if any}

Read {workspace_root}/{slug}/context/platform.md (and
{workspace_root}/{slug}/context/audit-findings.md + platform.md § Open
Questions if present) first. Produce the delimited
<!-- BEGIN FEATURE_BRIEF --> block.
```

#### 2b — technical perspective → `solution-architect`

**subagent_type**: `pipecrew:solution-architect`
**description**: `"Brainstorm — technical — {slug}"`

**Technical prompt:**

```
MODE: brainstorm

Explore the TECHNICAL solution space for the problem below. Diverge into 2–3
genuinely distinct approaches (each with pros/cons, a rough complexity signal,
and the key risk), recommend one with rationale, and give a short high-level
implementation sketch. STOP at options — do NOT emit the pipeline's
<!-- BEGIN … --> design blocks, do NOT write FR/EC, and do NOT edit code or
create worktrees. Offer to record the decision as an ADR only after I pick.

workspace_root: {workspace_root}
slug: {slug}
config.json: {workspace_root}/{slug}/config.json
platform.md: {workspace_root}/{slug}/context/platform.md
problem: {user's problem statement}

Load config.json + platform.md (and context/adrs/INDEX.md if present) first.
Read source sparingly, only to judge feasibility.
```

The agent asks questions — relay them to the user and pass answers back with **SendMessage to continue the SAME agent** (do NOT spawn a new agent per round).

### Step 3: Present the result

When the agent returns:

- **greenfield** — show the `<!-- BEGIN PROJECT_BRIEF -->` content. Point the user at the next step:

  ```
  Brief ready. To turn this into real repos + an onboarded workspace:
    /scaffold --from-scratch --brief=<save-path>   # create repo skeletons
    /discover <parent-dir>                          # onboard them
  ```

  Offer to save the brief to `{workspace_root}/{slug}/brief.md` if a slug/name is known (mirrors `/discover`'s greenfield Step 3), otherwise print it for the user to save.

- **feature** — show the ranked options and the recommendation prose, then surface the `<!-- BEGIN FEATURE_BRIEF -->` recommendation. Point the user at the hand-off:

  ```
  Recommended: {OPT-N titles}. To turn a chosen option into requirements and ship it:
    /deliver <the feature you picked>

  (/deliver's product-owner writes the FR/EC — the brainstormer stopped at options.)
  ```

- **technical** — show the Problem Statement, the 2–3 approaches with pros/cons, and the recommended approach + sketch. Point the user at the hand-off:

  ```
  Recommended approach: {name}. Next:
    - Record it as an ADR? (the architect can write context/adrs/ADR-NNN-*.md)
    - To build it: /deliver <the capability> — /deliver's design phase turns the
      chosen approach into the full technical design + implementation.
  ```

  If the user says yes to the ADR, continue the SAME solution-architect agent (SendMessage) and have it write the ADR; otherwise stop.

Do not scaffold, onboard, write requirements, or implement from this skill — presenting the result and naming the next step is where `/brainstorm` ends.
