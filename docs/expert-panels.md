# Expert Panels

> Versioned, validated, self-describing panel definitions for the
> Consensus Validation Protocol.

## What an expert panel is

An **expert panel** is a curated bundle that turns one tool call into a
tuned multi-perspective consensus run. Each panel declares:

- **A panel of personas** (required + optional, with fallback chains) so the
  Roundtable speaks from the right angles for the task.
- **Tuned engine defaults** — rounds, temperature, convergence threshold,
  disagreement threshold — calibrated by hand for the task family.
- **A task-specific judge prompt** that produces a deterministically-shaped
  synthesis (decision matrix, attack tree, severity-tagged findings, etc.).
- **Structured metadata** (`meta.version`, `meta.rationale`,
  `meta.expectedOutputShape`, `meta.tags`) so MCP clients, doc generators,
  and the bench CLI can introspect a panel without parsing prose.

Panels are the v2 (and later) replacement for the original v1 presets. The
five v1 presets ship unchanged for backward compatibility; new work targets
v2 panels.

## The catalogue (v0.12)

| Id                          | Title                              | v   | Tags                                       |
| --------------------------- | ---------------------------------- | --- | ------------------------------------------ |
| `architecture_v2`           | Architecture decision debate (v2)  | 2.0 | architecture, decision-support, high-stakes|
| `code_review_v2`            | Code review roundtable (v2)        | 2.0 | code-review, engineering, high-precision   |
| `research_synthesis_v2`     | Research synthesis (v2)            | 2.0 | research, synthesis, evidence-based        |
| `decision_making_v2`        | Decision support (v2)              | 2.0 | decision-support, high-stakes              |
| `incident_postmortem_v2`    | Incident postmortem (v2)           | 2.0 | postmortem, incident, high-precision       |
| `security_redteam`          | Security red-team threat model     | 1.0 | security, threat-modelling, defensive      |
| `ml_research_2026`          | ML research critical review (2026) | 1.0 | ml, research, evidence-based               |
| `product_strategy`          | Product strategy roundtable        | 1.0 | product, strategy, market                  |

Every panel is exposed as its own MCP tool — `consensus_<id>` — and can
also be invoked via the generic `consensus` tool's `panel` argument
(see [Using a panel](#using-a-panel) below).

## Per-panel reference

Every v2+ panel ships with a structured `meta.expectedOutputShape` that
declares the markdown sections the judge will produce. The tables below
are the same shape, in human-readable form.

### `architecture_v2` — Architecture decision debate (v2)

**Rationale:** v2 tightens v1's good-but-loose debate by enforcing
quantification, adding reversibility as a first-class matrix column, and
requiring tripwires to be specific measurable signals. Devil's Advocate
is required (not optional) so the steelmanned counter-case is always voiced.

**Output sections:**

| Heading                | What it contains                                                                  |
| ---------------------- | --------------------------------------------------------------------------------- |
| Constraint surface     | Load-bearing constraints with units; assumed values tagged ‹assumed›.             |
| Decision matrix        | Table: Option / Approach / Key trade-off / Risk (1-5) / Reversibility / Switching cost. |
| Recommendation         | Single architecture, dominant reason, next-best alternative.                      |
| Tripwire conditions    | Measurable thresholds that flip the recommendation.                               |
| Open questions         | Unresolved questions blocked on missing information.                              |

**Tuned defaults:** `maxRounds=4`, `participantTemperature=0.5`,
`convergenceDelta=3`, `disagreementThreshold=18`.

### `code_review_v2` — Code review roundtable (v2)

**Rationale:** v2 enforces the four-part finding shape — location, root
cause, trigger, fix — that v1 left implicit. Devil's Advocate is required
to prevent the panel from converging on a defect that doesn't survive the
author's steelmanned defense. Temperature drops to `0.25` for precision.

**Output sections:**

| Heading                 | What it contains                                                  |
| ----------------------- | ----------------------------------------------------------------- |
| Findings                | Numbered, severity-tagged (BLOCKER / MAJOR / MINOR / NIT) with location, root cause, trigger, recommended fix. |
| Agreed                  | Issues every reviewer flagged.                                    |
| Disagreements           | Issues where reviewers split, with each side's reasoning.         |
| Refactor opportunities  | Out-of-scope work worth tracking.                                 |

**Tuned defaults:** `maxRounds=3`, `participantTemperature=0.25`,
`convergenceDelta=4`.

### `research_synthesis_v2` — Research synthesis (v2)

**Rationale:** v2 hardens citation discipline (every claim tagged with
evidence type) and adds the **independence map** — surfaces claims that
rest on the same load-bearing assumption so callers don't mistake
correlated confirmations for independent validation. Open questions are
leverage-ranked.

**Output sections:**

| Heading                              | What it contains                                                  |
| ------------------------------------ | ----------------------------------------------------------------- |
| Claims and confidence                | Each claim with evidence type, source, HIGH/MEDIUM/LOW, counter-evidence. |
| Independence map                     | Claims grouped by shared load-bearing assumption.                 |
| Open questions, ranked by leverage   | Open questions ordered by how many downstream claims they shift.  |
| Where to dig next                    | Specific papers, experiments, datasets.                           |

**Tuned defaults:** `maxRounds=4`, `participantTemperature=0.35`,
`convergenceDelta=3`.

### `decision_making_v2` — Decision support (v2)

**Rationale:** v2 adds two structural elements v1 missed: **reversibility**
as a first-class column on every option, and the **"bets we're consciously
not making"** section that preserves rejected alternatives. Both target
the same failure mode — decisions that get second-guessed in 6 months
because the context evaporated.

**Output sections:**

| Heading                                  | What it contains                                                  |
| ---------------------------------------- | ----------------------------------------------------------------- |
| Ranked options                           | Best-to-worst with EV, reversibility, risks, upsides, agreement strength. |
| Recommendation                           | Single recommended option with dominant reason.                   |
| Tripwire conditions                      | Specific signals that would flip the ranking.                     |
| Bets we're consciously not making        | Rejected alternatives, preserving decision context.               |
| Information we still need                | Missing inputs and why they matter.                               |

**Tuned defaults:** `maxRounds=4`, `participantTemperature=0.45`,
`convergenceDelta=3`, `disagreementThreshold=18`.

### `incident_postmortem_v2` — Incident postmortem (v2)

**Rationale:** v2 enforces three disciplines v1 left implicit:

1. Root cause must terminate at a real mechanism (not "we should have
   monitored X").
2. Contributing factors are separated from root cause so organisational
   fixes don't masquerade as mechanism fixes.
3. Class-of-incident prevention is a required section — the structural
   fix is the only durable answer.

**Output sections:**

| Heading                                   | What it contains                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| Summary                                   | 2-4 sentences: what broke, scope, duration, top remediation.                              |
| Timeline                                  | Timestamped events with computed gaps (detection, escalation, mitigation, recovery).      |
| Root cause                                | 5-whys chain ending at a real mechanism.                                                  |
| Contributing factors                      | Organisational/process factors, separated from root cause.                                |
| Detection gap analysis                    | Why detection lagged and what signal would catch it earlier.                              |
| Remediation items                         | Severity-tagged actions with owner role, gap closed, cost.                                |
| Class-of-incident prevention              | Architectural change that prevents the whole failure category.                            |

**Tuned defaults:** `maxRounds=3`, `participantTemperature=0.25`,
`convergenceDelta=4`.

### `security_redteam` — Security red-team threat model

**Rationale:** Defensive threat modelling needs both breadth (enumerate
everything) and depth (steelman the strongest attack). The panel pairs
an exhaustive Risk Analyst with a focused Devil's Advocate who picks one
path and chains it end-to-end. First Principles surfaces shared-assumption
boundaries because one bug there breaks everything downstream.
Disagreement threshold is tighter (`15`) — security splits on small
confidence deltas matter.

**Output sections:**

| Heading                  | What it contains                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Threat model             | Assets protected, trust boundaries, realistic adversaries.                         |
| Attack tree              | Top attack paths ranked by severity × likelihood with preconditions.               |
| Confirmed vulnerabilities| Findings tagged with severity, mechanism, repro outline, impact, CWE/OWASP.        |
| Prioritised mitigations  | Concrete fixes ranked by leverage with cost and detection counterpart.             |
| Open attack surface      | Unanalyzed areas and what's needed to close them.                                  |

**Tuned defaults:** `maxRounds=4`, `participantTemperature=0.3`,
`disagreementThreshold=15`.

**Defensive use only.** The judge prompt explicitly instructs that
exploit code is not produced — attacks are outlined at the level needed
to verify the fix, no further.

### `ml_research_2026` — ML research critical review

**Rationale:** ML in 2026 is a landscape where capability claims accelerate
faster than verification. This panel forces every claim into one of four
evidence tiers (RIGOROUS / CONTROLLED / SUGGESTIVE / ANECDOTAL) and demands
the practitioner-reality gap be named explicitly. Scaling implications are
required, not optional, because the question that matters is "does this
hold at the next scale."

**Output sections:**

| Heading                  | What it contains                                                  |
| ------------------------ | ----------------------------------------------------------------- |
| Claim taxonomy           | Claims with evidence tier, methodological strength, practitioner gap. |
| Scaling implications     | Honest projection at 10× / 100× / 1000× with saturation signals.  |
| Reproducibility risk     | Risk level with named drivers (data, eval, hyperparams).          |
| Next experiments to run  | Information-gain-ranked with cost estimates.                      |
| Bottom line              | Build-on / watch / discount verdict with confidence.              |

**Tuned defaults:** `maxRounds=4`, `participantTemperature=0.4`,
`convergenceDelta=3`.

### `product_strategy` — Product strategy roundtable

**Rationale:** Strategy frequently fails by collapsing into one of two
patterns: vision without execution reality, or execution without vision.
This panel forces four perspectives that triangulate the decision — market
thesis (VC), execution reality (Domain), competitive threat (Devil's
Advocate), upside path (Futurist). The "bets we're not making" section
is required because strategy is what you choose not to do.

**Output sections:**

| Heading                                   | What it contains                                                  |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Market thesis                             | Customer, job-to-be-done, why-now, with TAM/SAM/SOM where available. |
| Differentiation                           | Top 3 differentiation claims with specific competitors or alternatives. |
| Moat analysis                             | Moats with type, strength, compounding direction, hardening action. |
| Sequencing plan                           | 90-day / 1-year / 3-year inflection points.                       |
| Top risks + early signals                 | Risks with probability and the early signal metric.               |
| Bets we're consciously not making         | Rejected adjacent paths with the reason.                          |

**Tuned defaults:** `maxRounds=4`, `participantTemperature=0.55`,
`convergenceDelta=3`.

## Using a panel

There are three ways to invoke an expert panel.

### 1. Via the panel's dedicated MCP tool

Each panel is registered as `consensus_<id>` and appears in MCP host
autocomplete. Best when your host enumerates tool names (Claude Code,
Cursor, Windsurf).

```jsonc
// In an MCP host, the tool call:
{
  "name": "consensus_architecture_v2",
  "arguments": {
    "prompt": "Should our 5-person team adopt microservices from day one?"
  }
}
```

### 2. Via the generic `consensus` tool's `panel` argument

The generic `consensus` tool now accepts an optional `panel` field. When
set, the panel's persona panel and tuned defaults are applied to the run —
equivalent to calling the dedicated tool, but accessible via the generic
interface for hosts that don't enumerate per-panel tools.

```jsonc
{
  "name": "consensus",
  "arguments": {
    "prompt": "Threat-model this webhook endpoint.",
    "panel": "security_redteam",
    "maxRounds": 5    // tool input still wins over panel defaults
  }
}
```

`panel` and `participantIds` are mutually exclusive — a panel id selects
the panel composition; `participantIds` picks raw participants from the
config.

### 3. Via the bench CLI

```bash
# Run the default built-in fixtures for a panel
npx ai-consensus-mcp bench --config ./consensus.config.json --panel architecture_v2

# Multi-run averaging
npx ai-consensus-mcp bench --config <path> --panel security_redteam --runs 3

# Your own case file
npx ai-consensus-mcp bench --config <path> --panel code_review_v2 \
    --cases ./internal-review-suite.json --output ./report.json
```

See [bench output example](#example-bench-output) below.

## Contributing a new panel

Panels live in `consensus-mcp/src/presets/definitions/`. Adding one is
five steps:

1. **Author the TS file.** Mirror the shape of an existing v2 panel
   (e.g. [`security-redteam.ts`](../src/presets/definitions/security-redteam.ts)).
   Required fields: `id` (snake_case), `toolName` (`consensus_${id}`),
   `title`, `description`, `panel` (≥2 entries), `defaults`,
   `judgeSystemPrompt`, `meta` (with `version`, `rationale`,
   `expectedOutputShape`, `tags`).

2. **Add to the slate.** Import in
   [`src/presets/definitions/index.ts`](../src/presets/definitions/index.ts)
   and add to the `BUILT_IN_PRESETS` const array.

3. **Add a snapshot.** Run `npm test -- -u` to regenerate the
   [presets snapshot](../src/presets/__tests__/__snapshots__/presets-snapshot.test.ts.snap).
   Review the diff carefully — every resolved persona prompt your panel
   produces will appear.

4. **Add bench fixtures.** Author 3-5 cases in
   `consensus-mcp/src/benchmark/fixtures/<area>.json` so contributors
   can verify the panel produces sensible output.

5. **Update this doc.** Add your panel to the catalogue table and
   per-panel reference. Keep the rationale tight — one paragraph is
   enough; the system-prompt files are the actual specification.

The validator in `registry.ts` will reject ill-formed metadata at server
start, so a typo can't ship — see
[`registry-meta.test.ts`](../src/presets/__tests__/registry-meta.test.ts)
for the full contract.

## Versioning policy

- **v1 panels keep their ids.** The original five presets
  (`architecture_debate`, `code_review`, `research_synthesis`,
  `decision_making`, `debug_postmortem`) ship unchanged. They're stable.
- **v2 panels take a `_v2` suffix on related panels** (e.g.
  `architecture_v2`, `code_review_v2`). The v1 and v2 versions coexist
  so existing integrations don't break.
- **Major versions are panel rewrites.** Output shape changes, persona
  changes, or default changes that meaningfully alter behaviour bump
  the major version.
- **Minor + patch bumps live on the same id.** Bug fixes to a system
  prompt, expanded fallback chains, or small default tweaks don't get
  a new id; they bump `meta.version` (e.g. `2.0.0` → `2.1.0`).

## Example bench output

A real `bench` invocation produces a markdown report like this:

```text
# Bench Report

**Panel:** Architecture decision debate (v2) (`architecture_v2`) v2.0.0
**Cases:** 4
**Runs per case:** 3
**Total runs:** 12
**Baseline model:** `grok-4`
**Base seed:** 42
**Generated at:** 2026-05-25T18:30:00.000Z

## Metrics

- **Agreement rate** (final σ ≤ 15): 83% (10/12 runs)
- **Convergence speed:** 3.20 rounds avg • **Early-stop rate:** 67%
- **Judge confidence:** μ=78.5, σ=8.2
- **Inter-rater reliability proxy:** 0.84 (1.00 = unanimous)
- **Avg disagreements per run:** 1.5
- **Duration ratio (consensus / baseline):** 4.23×
- **Token ratio (consensus / baseline):** 5.18×
- **Consensus score > baseline confidence:** 75% of runs

## Per-case results

| Case                          | Run | Score | σ    | Rounds | Stop | Disagree | Judge conf | Baseline conf | Δ   |
| ----------------------------- | --- | ----- | ---- | ------ | ---- | -------- | ---------- | ------------- | --- |
| arch-microservices-day-one    | 0   | 82    | 7.1  | 3      | conv | 1        | 88         | 70            | +12 |
| arch-microservices-day-one    | 1   | 79    | 8.4  | 3      | conv | 2        | 85         | 72            | +7  |
| arch-microservices-day-one    | 2   | 81    | 6.8  | 3      | conv | 1        | 87         | 68            | +13 |
| ...                                                                                                          |

## Qualitative notes

• arch-microservices-day-one#0: converged at round 3 (Δ=2.0); judge confidence 88
• arch-microservices-day-one#1: converged at round 3 (Δ=1.0); judge confidence 85
...
```

The same data is available as JSON when `--output <path>` is set.

## See also

- [`docs/install.md`](./install.md) — installing the MCP server with
  Claude Code / Cursor / Windsurf.
- [`ai-consensus-core` protocol docs](https://github.com/entropyvortex/ai-consensus-core)
  — rounds, phases, confidence parsing.
- [`src/presets/definitions/`](../src/presets/definitions) — the
  canonical source for every shipped panel.
