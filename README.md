# ai-consensus-mcp

> A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that turns any MCP host into a multi-model roundtable.
> Generic `consensus` tool plus 13 task-tuned expert panels — code review, architecture, security red-team, ML research, decision support, incident postmortem, product strategy, and more — each invokable as one command.

[![npm](https://img.shields.io/npm/v/ai-consensus-mcp)](https://www.npmjs.com/package/ai-consensus-mcp)
[![license](https://img.shields.io/npm/l/ai-consensus-mcp)](./LICENSE)

Thin wrapper over [`ai-consensus-core`](https://github.com/entropyvortex/ai-consensus-core). One config file, 14 tools (17 with memory enabled), zero drama.

## What's new in v0.12

- **8 v2 expert panels** with versioned metadata, structured rationale, and
  machine-readable `expectedOutputShape`. New: `security_redteam`,
  `ml_research_2026`, `product_strategy`. Upgrades: `architecture_v2`,
  `code_review_v2`, `research_synthesis_v2`, `decision_making_v2`,
  `incident_postmortem_v2`. See [`docs/expert-panels.md`](./docs/expert-panels.md).
- **`bench` CLI subcommand** — `npx ai-consensus-mcp bench --panel <id>`
  measures panel uplift vs. a single-model baseline with agreement-rate,
  convergence-speed, judge-confidence distribution, and duration/token
  cost ratios. Deterministic with `--seed`. Built-in fixtures shipped
  for architecture / code-review / security / decision suites.
- **Persistent project memory** (opt-in). Set `memory.enabled: true` to
  store every consensus result under a project-keyed directory and recall
  prior decisions through three new MCP tools — `consensus_recall`,
  `consensus_project_memory`, `consensus_what_we_decided`. Atomic
  writes, sentinel-locked index, retention policy, whole-token keyword
  recall with matched fragments. See [`docs/memory-layer.md`](./docs/memory-layer.md).
- **`panel` argument on the generic `consensus` tool** — apply any expert
  panel by id from the generic tool, for hosts that don't enumerate
  per-panel tools.
- All v1 presets continue to work unchanged.

### Tool inventory at a glance

| Tool                                                                                                                                                                                                                                                                          | Available when         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `consensus` (generic, w/ `panel`)                                                                                                                                                                                                                                             | Always                 |
| 5 v1 presets (`consensus_code_review`, `consensus_architecture_debate`, `consensus_research_synthesis`, `consensus_decision_making`, `consensus_debug_postmortem`)                                                                                                            | Always                 |
| 8 v2 expert panels (`consensus_architecture_v2`, `consensus_code_review_v2`, `consensus_decision_making_v2`, `consensus_incident_postmortem_v2`, `consensus_research_synthesis_v2`, `consensus_security_redteam`, `consensus_ml_research_2026`, `consensus_product_strategy`) | Always                 |
| `consensus_recall`                                                                                                                                                                                                                                                            | `memory.enabled: true` |
| `consensus_project_memory`                                                                                                                                                                                                                                                    | `memory.enabled: true` |
| `consensus_what_we_decided`                                                                                                                                                                                                                                                   | `memory.enabled: true` |

## Install in 30 seconds

```bash
# 1. Build a provider config interactively (or copy + edit the example)
npx -y ai-consensus-mcp config
# → walks you through providers, participants, judge, and defaults
# → writes ~/.consensus.config.json (atomic, schema-validated)

# 2. Auto-register with every installed MCP host
npx -y ai-consensus-mcp install --config ~/.consensus.config.json
```

Prefer to edit by hand? `cp consensus.config.example.json ~/.consensus.config.json && $EDITOR ~/.consensus.config.json` works too — see the "Configure" section below for the schema.

The installer detects Claude Code, Cursor, and Windsurf and merges a `consensus` server entry into each one's MCP config (atomic write, never clobbers other entries). Restart the host afterwards — the generic `consensus` tool plus 5 v1 presets and 8 v2 expert panels appear in autocomplete. See the [Tool inventory](#tool-inventory-at-a-glance) above or [`docs/expert-panels.md`](./docs/expert-panels.md) for the full catalogue.

Scope the run with `--hosts claude-code,cursor`. Run `npx ai-consensus-mcp install --list-hosts` to see what's detected on your machine. Full reference in [`docs/install.md`](./docs/install.md).

## What it gives you

- **14 MCP tools, one config.** The generic `consensus` tool (with optional
  `panel` argument), plus 5 v1 presets and 8 v2 expert panels. Invoke a
  panel; get a curated set of personas and tuned defaults without touching
  the knobs. Full catalogue in [`docs/expert-panels.md`](./docs/expert-panels.md).
- **Benchmarking baked in, with held-out quality eval.**
  `npx ai-consensus-mcp bench --panel <id>` runs a panel against built-in
  or user-provided cases and produces a human-readable + JSON uplift
  report — agreement rate, convergence speed, judge confidence,
  duration/token cost ratios. Deterministic with `--seed`. Pass
  `--evaluator-model` + `--evaluator-provider` and the bench scores both
  the consensus synthesis and the baseline against the panel's declared
  rubric using a third, held-out model — measuring answer quality
  against named criteria, not self-reported confidence. See
  [Quality benchmark](#quality-benchmark-held-out-evaluator) below for
  the methodology and the headline result (consensus wins 12/12 runs
  on `architecture_v2` against a frontier baseline).
- **Persistent project memory (opt-in).** Enable with one config flag;
  every panel run is durably stored, project-scoped, with three recall
  tools — `consensus_recall`, `consensus_project_memory`,
  `consensus_what_we_decided`. Atomic writes, sentinel-locked index,
  retention policy, whole-token keyword recall with matched fragments
  so the caller can sanity-check why a hit ranked. Disabled by default;
  see [`docs/memory-layer.md`](./docs/memory-layer.md).
- **Any OpenAI-compatible provider.** xAI Grok, Anthropic (via OpenAI-compat endpoint), OpenAI, Groq, Together, Fireworks, or your private gateway. One adapter, configurable per participant.
- **The calling agent can also play (experimental).** A participant can be `kind: "host-sample"`, in which case the MCP host answers via [MCP sampling](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling) — its own model takes a seat at the roundtable, no extra API key. **Today this only works in Claude Desktop**; Claude Code, Cursor, and Windsurf don't advertise the `sampling` capability yet (tracking: [anthropics/claude-code#1785](https://github.com/anthropics/claude-code/issues/1785)). See [the host-sample section](#participants-can-be-the-calling-host).
- **Live progress.** Every structured engine event is forwarded as an MCP [progress notification](https://modelcontextprotocol.io/specification/2025-03-26/basic/utilities/progress) — hosts render real-time round/participant/disagreement/score status.
- **Dependency-light.** `@modelcontextprotocol/sdk`, `zod`, `ai-consensus-core`. SSE parsing is native `fetch` — no provider SDKs.

## Quality benchmark (held-out evaluator)

`bench` ships with a held-out LLM-as-judge rubric evaluator. Pass
`--evaluator-model` + `--evaluator-provider` and the bench scores both
the consensus synthesis and the single-model baseline against the
panel's declared rubric, using a third model that's neither side. The
rubric measures **answer quality** against named criteria — distinct
from self-reported confidence, which is a meta-signal that does not
track quality.

### Headline finding (`architecture_v2`, 4 cases × 3 runs, seed=42)

| Metric                                                  | Consensus | Baseline |         Δ |
| ------------------------------------------------------- | --------: | -------: | --------: |
| Self-reported (consensus score vs. baseline confidence) |      60.0 |     75.4 |     −15.4 |
| Held-out rubric (judged by `claude-opus-4-5`, blind)    |  **83.3** | **48.0** | **+35.3** |

**Consensus wins on the held-out rubric in 12 of 12 runs (100%).** On
the same 12 runs, the self-reported confidence metric says consensus
wins 1 of 12 (8%) — the two metrics invert. Without the rubric, the
bench reports "consensus loses 11/12, costs 40× tokens for nothing."
With it: "consensus dominates 12/12, +35-point quality lead,
structural advantage on every case."

### Per-case Δ rubric

| Case                          | Runs (Δ rubric) |    Mean |
| ----------------------------- | --------------- | ------: |
| `arch-microservices-day-one`  | +36, +28, +32   | **+32** |
| `arch-event-sourcing-billing` | +44, +52, +56   | **+51** |
| `arch-sync-vs-async-fanout`   | +24, +40, +40   | **+35** |
| `arch-db-multi-tenant`        | +12, +32, +28   | **+24** |

Baseline scored 28/100 on every `event-sourcing-billing` run — a
reproducible single-model blind spot (hand-wavy tripwires, missing
reversibility weighing) that the panel surfaces every time.

### Methodology

- **Judge model:** `grok-4.3` (xai). Synthesises the consensus output
  from the panel's final-round responses.
- **Baseline model:** `grok-4.3` (xai). Same brain, single-shot answer,
  no panel, no judge — this is what the panel is compared against.
- **Evaluator model:** `claude-opus-4-5` (anthropic). **Held out** —
  does not appear on either side of the comparison. Scores each answer
  independently against the rubric, blind to which side produced it.
- **Rubric:** 5 criteria for `architecture_v2`, each scored 0–5:
  quantification, single-recommendation, reversibility-weighing,
  tripwire-specificity, failure-mode-realism. Declared on the preset
  (see [`src/presets/definitions/architecture-v2.ts`](./src/presets/definitions/architecture-v2.ts)).
- **Determinism:** `--seed 42` controls round-order shuffling. Model
  outputs at temperature > 0 are inherently stochastic — 3 runs per
  case averages out the noise.

### Reproducing

```bash
export GROK_API_KEY=...
export CONSENSUS_ANTHROPIC_API_KEY=...
ai-consensus-mcp bench -p architecture_v2 --runs 3 --seed 42 \
  --evaluator-model claude-opus-4-5 --evaluator-provider anthropic \
  --output bench-architecture_v2-rubric.json
```

Cost preview: ~72 provider calls (4 cases × 3 runs × (panel + baseline

- 2 rubric evals)). The CLI prints the exact estimate before spending.

### Honest caveats

- **N=12 is small.** The direction is unambiguous (100% inversion is
  hard to fluke); the magnitude needs broader sampling.
- **One panel.** Only `architecture_v2` declares a rubric in this
  version — the same pattern applies to every other panel by adding a
  `rubric` array to the preset definition.
- **Cost is real.** 40× tokens, 20× wall time vs. one baseline call.
  For high-stakes architecture decisions (the panel's named use case),
  the cost is dwarfed by the cost of a wrong call. For low-stakes
  routine choices, single-model is the right tool — panel-selection
  guidance, not a panel failure.
- **Self-reported confidence remains a poor quality estimator.** Even
  with the upstream parser-contract fix (`ai-consensus-core@0.11.1`),
  judge confidence on these 12 runs is μ=66.9, σ=5.2 — under-estimates
  the actual held-out rubric score (μ=83.3) by ~16 points. Useful as a
  humility signal, not as a quality estimator.

The CLI warns when the evaluator model coincides with the baseline or
the judge — the held-out contract is the bench's only guarantee that
the comparison isn't self-graded.

## The protocol

For the actual protocol — rounds, phases, prompts, scoring — see the [ai-consensus-core protocol diagram](https://github.com/entropyvortex/ai-consensus-core#protocol-diagram). This README covers the server surface only.

## Install

Via npm:

```bash
# Globally, for use as a binary
npm install -g ai-consensus-mcp

# Or as a project dependency
npm install ai-consensus-mcp
```

Or clone and run:

```bash
git clone https://github.com/entropyvortex/ai-consensus-mcp.git
cd ai-consensus-mcp
npm install
npm run build
```

## Configure

### Option A — interactive editor

```bash
ai-consensus-mcp config                                  # edits ~/.consensus.config.json
ai-consensus-mcp config --config ./project.config.json   # any path; created if missing
ai-consensus-mcp configure                               # alias
```

The editor (`@inquirer/prompts`-based) walks you through every section — providers, participants, judge, defaults — with inline help. The full file is checked against the same Zod schema the server uses on startup before saving, so a config that quits the editor cleanly is one the server will accept. Quit any time with `Discard & exit` or Ctrl-C; nothing is written until you choose `Save & exit`. Writes are atomic (`fs.rename(2)`), so a crash mid-save can't leave a half-written file.

### Option B — copy the example and edit it

```bash
cp consensus.config.example.json ~/.consensus.config.json
```

Minimal shape:

```json
{
  "providers": {
    "xai": {
      "baseUrl": "https://api.x.ai/v1",
      "apiKeyEnv": "GROK_API_KEY"
    },
    "anthropic": {
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKeyEnv": "CONSENSUS_ANTHROPIC_API_KEY"
    }
  },
  "participants": [
    { "id": "grok", "provider": "xai", "modelId": "grok-4", "personaId": "pessimist" },
    {
      "id": "domain",
      "provider": "anthropic",
      "modelId": "claude-sonnet-4-6",
      "personaId": "domain-expert"
    },
    { "id": "devil", "provider": "xai", "modelId": "grok-4", "personaId": "devils-advocate" }
  ],
  "judge": {
    "provider": "xai",
    "modelId": "grok-4"
  }
}
```

### Config reference

```
providers.<id>.baseUrl         string   OpenAI-compatible base URL. No trailing /chat/completions.
providers.<id>.apiKeyEnv       string   Name of the env var holding the API key.
providers.<id>.extraHeaders    object?  Static headers sent on every request (rarely needed).

participants[].id              string   Stable participant id (appears in events + progress).
participants[].kind            enum?    "provider" (default) or "host-sample". host-sample
                                        participants are answered by the calling MCP host's
                                        own LLM via sampling/createMessage; they do not
                                        declare a provider or modelId.
participants[].provider        string   Key into providers. Required when kind="provider".
participants[].modelId         string   Opaque model id the provider accepts.
                                        Required when kind="provider".
participants[].modelHint       string?  Soft preference forwarded to the host as
                                        modelPreferences.hints[0].name. Only used when
                                        kind="host-sample"; hosts may ignore it.
participants[].personaId       enum     One of: pessimist, first-principles, vc-specialist,
                                        scientific-skeptic, optimistic-futurist,
                                        devils-advocate, domain-expert.
participants[].label           string?  Optional display label.

judge.provider                 string?  Key into providers.
judge.modelId                  string?  Opaque judge model id.
judge.temperature              number?  Defaults to 0.3.
judge.maxOutputTokens          number?  Defaults to 1500.

defaults.maxRounds             int?     1–10, defaults 4.
defaults.earlyStop             bool?    Defaults true.
defaults.convergenceDelta      number?  Defaults 3.
defaults.disagreementThreshold number?  Defaults 20.
defaults.blindFirstRound       bool?    Defaults true.
defaults.randomizeOrder        bool?    Defaults true.
defaults.participantTemperature number? Defaults 0.7.
defaults.maxOutputTokens       int?     Defaults 1500.
defaults.useJudge              bool?    Defaults true if `judge` is declared, else false.
```

Every field not in that list is rejected by the config loader — typos fail loudly rather than silently.

### Participants can be the calling host

> **Status: experimental, Claude Desktop only.** Of the hosts this server commonly runs under (Claude Desktop, Claude Code, Cursor, Windsurf), **only Claude Desktop currently advertises the MCP `sampling` capability**. In any other host the tool will return an `isError` naming the host-sample participant. Claude Code support is tracked at [anthropics/claude-code#1785](https://github.com/anthropics/claude-code/issues/1785) — when it lands, existing host-sample configs activate without changes.

Sometimes you want the agent that's _invoking_ the consensus tool to also be one of the voices at the table. Set `kind: "host-sample"` on a participant and the server fulfils that participant's turns by issuing an MCP [`sampling/createMessage`](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling) request back to the host. The host's LLM (whatever model it happens to be running) gets the persona system prompt, answers, and the engine continues. No extra API key, no extra provider entry.

```jsonc
{
  "providers": {
    "xai": { "baseUrl": "https://api.x.ai/v1", "apiKeyEnv": "GROK_API_KEY" },
  },
  "participants": [
    { "id": "grok", "provider": "xai", "modelId": "grok-4", "personaId": "pessimist" },
    {
      "kind": "host-sample",
      "id": "self",
      "personaId": "domain-expert",
      "modelHint": "claude-sonnet", // optional — most users skip this
    },
  ],
}
```

That's it. When `consensus` runs and `self`'s turn comes up, the host (Claude Desktop) is the one drafting the Domain Expert response. Claude Desktop prompts the user before each sampling call (human-in-the-loop), so you'll see and approve each one.

**Things to know:**

- **Host support is the gating constraint.** Claude Desktop advertises `sampling` and works today. Claude Code, Cursor, Windsurf, and Codex CLI do not yet — invoking a host-sample participant from any of those returns an `isError` naming the participant rather than hanging. Until upstream support lands (Claude Code: [#1785](https://github.com/anthropics/claude-code/issues/1785)), use a configured provider (Anthropic, OpenAI, Groq, etc.) for those hosts.
- **You don't pin the model.** Whatever the host has loaded answers — Sonnet, Opus, GPT-5, etc. `modelHint` is a soft preference; hosts can (and often will) ignore it.
- **Cost lands on the host.** Sampling tokens bill against the user's host session, not your provider key.
- **No streaming.** MCP sampling returns a complete message; per-token streaming events aren't forwarded for host-sample participants. The engine drops token-level events on this server anyway, so this is rarely visible.
- **The judge is provider-only for now.** `judge.kind = "host-sample"` isn't supported yet — the synthesizer always routes through a configured provider.
- **Configs with zero providers are valid** if every participant is `host-sample`. Two host-sample participants with different personas give you a "two voices, same model" debate that still runs the full CVP loop.

## Run standalone

```bash
export GROK_API_KEY=xai-...
export CONSENSUS_ANTHROPIC_API_KEY=sk-ant-...

ai-consensus-mcp --config ./consensus.config.json
```

The server speaks JSON-RPC over stdio. A ready line like:

```
ai-consensus-mcp ready — 3 participant(s) from 2 provider(s), judge=grok-4 (config: /abs/consensus.config.json)
```

is written to **stderr** on startup; stdout is reserved for the MCP protocol stream.

## Register with an MCP host

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the Windows equivalent:

```json
{
  "mcpServers": {
    "consensus": {
      "command": "ai-consensus-mcp",
      "args": ["--config", "/absolute/path/to/consensus.config.json"],
      "env": {
        "GROK_API_KEY": "xai-...",
        "CONSENSUS_ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

(If you didn't install globally, replace `"command": "ai-consensus-mcp"` with `"command": "node"` and point `args` at `/path/to/ai-consensus-mcp/dist/index.js`.)

Restart Claude Desktop. You should see a `consensus` tool become available.

### Claude Code

```bash
claude mcp add consensus \
  --scope user \
  -- ai-consensus-mcp --config /absolute/path/to/consensus.config.json
```

Or edit `~/.claude.json` directly with the same `command` / `args` / `env` shape.

### Cursor, Windsurf, and other hosts

Point them at `ai-consensus-mcp --config <path>/consensus.config.json` with the relevant provider API keys in the environment. Stdio transport only.

## The `consensus` tool

### Input

```jsonc
{
  "prompt": "Should an early-stage startup adopt microservices from day one?",
  "maxRounds": 4, // optional, 1–10
  "participantIds": ["grok", "domain"], // optional — subset of configured participants
  "earlyStop": true, // optional
  "judge": true, // optional — defaults to config.defaults.useJudge
  "blindFirstRound": true, // optional
  "randomizeOrder": true, // optional
  "convergenceDelta": 3, // optional
  "disagreementThreshold": 20, // optional
  "participantTemperature": 0.7, // optional
  "maxOutputTokens": 1500, // optional
  "randomSeed": 42, // optional — deterministic round-order shuffle
}
```

Only `prompt` is required. Everything else falls back to the config's `defaults`, then to the engine's defaults.

### Output

Two artifacts on every successful call:

1. **`content[0].text`** — a human-readable markdown summary:
   - Final score, duration, stop reason
   - Per-round score table
   - Final-round responses, labeled by persona + model
   - Judge synthesis (if `judge: true`)

2. **`structuredContent`** — the full `ConsensusResult` as JSON for programmatic consumers.

### Progress notifications

Every structured engine event is forwarded as an MCP `notifications/progress` message. Token-level streaming events are intentionally dropped — they would flood the channel.

| Engine event           | Example progress message                                                |
| ---------------------- | ----------------------------------------------------------------------- |
| `roundStart`           | `Round 2/4 — Counterarguments (sequential) starting`                    |
| `participantStart`     | `  grok (grok-4) thinking…`                                             |
| `participantComplete`  | `  grok done — confidence=72 (4132ms)`                                  |
| `confidenceUpdate`     | `  running avg round 2: 74.5 (last: grok=72)`                           |
| `disagreementDetected` | `  ⚠ disagreement: Risk Analyst vs Optimistic Futurist (Δ=35)`          |
| `roundComplete`        | `Round 2 complete — score=71, avg=74.5, σ=7.0, disagreements=1`         |
| `earlyStop`            | `✓ Early stop at round 3: Consensus score delta 2.0 … is at or below …` |
| `synthesisStart`       | `Judge synthesis starting (grok-4)…`                                    |
| `synthesisComplete`    | `Judge synthesis complete (confidence=84)`                              |
| `finalResult`          | `Consensus complete — finalScore=76, rounds=3, stopReason=converged`    |

`progress` increments monotonically on `roundComplete` and `synthesisComplete`; `total` is `maxRounds + (judge ? 1 : 0)`.

## Presets and expert panels

The generic `consensus` tool exposes every engine knob. For most real work you don't want to tune knobs — you want a tuned panel for a specific task. Presets are that.

Each preset is registered as its own MCP tool, so hosts surface them in autocomplete. The slate ships in two generations:

### v1 presets (stable, ship unchanged for backward compat)

| Tool                            | Panel (personas)                                                         | Rounds | Temp | Output shape                                                              |
| ------------------------------- | ------------------------------------------------------------------------ | -----: | ---: | ------------------------------------------------------------------------- |
| `consensus_code_review`         | pessimist, domain-expert, devils-advocate, first-principles              |      3 |  0.3 | Severity-tagged findings (BLOCKER/MAJOR/MINOR/NIT) with locations + fixes |
| `consensus_architecture_debate` | first-principles, domain-expert, vc-specialist, pessimist                |      4 |  0.6 | Decision matrix + single recommendation + flip conditions                 |
| `consensus_research_synthesis`  | scientific-skeptic, domain-expert, first-principles, optimistic-futurist |      4 |  0.4 | Citation-first claims with HIGH/MEDIUM/LOW confidence + open questions    |
| `consensus_decision_making`     | vc-specialist, pessimist, domain-expert, devils-advocate                 |      4 |  0.5 | Ranked options with EV / risks / upsides + flip conditions                |
| `consensus_debug_postmortem`    | pessimist, domain-expert, first-principles, scientific-skeptic           |      3 |  0.3 | Postmortem report (timeline, 5-whys root cause, remediation items)        |

### v2 expert panels (v0.12 — tighter prompts, structured `meta`, machine-readable output shape)

Every v2 panel ships full metadata — `version`, `rationale`,
`expectedOutputShape` (sections + tags), free-form `tags` — so MCP
clients and the bench CLI can introspect what a panel is for and what
its judge synthesis will look like, without parsing prose.

| Tool                               | Rationale (one-line)                                                       |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `consensus_architecture_v2`        | v1 + reversibility column + quantification enforced + specific tripwires   |
| `consensus_code_review_v2`         | Findings must name (location, root cause, trigger, fix); Devil's required  |
| `consensus_research_synthesis_v2`  | Evidence-type tags + independence map + leverage-ranked open questions     |
| `consensus_decision_making_v2`     | Reversibility column + bets-we're-not-making preserves rejected paths      |
| `consensus_incident_postmortem_v2` | Root cause must terminate at mechanism; class-of-incident prevention req'd |
| `consensus_security_redteam`       | Defensive threat model; attack tree by severity × likelihood + CWE/OWASP   |
| `consensus_ml_research_2026`       | 4-tier evidence taxonomy + scaling implications + reproducibility risk     |
| `consensus_product_strategy`       | Market thesis + moats + 90d/1y/3y sequencing + bets-not-made               |

Full per-panel reference (rationale, output sections, tuned defaults)
is in [`docs/expert-panels.md`](./docs/expert-panels.md).

### Invoking a preset

Same MCP tool-call shape as the generic tool — just call the preset's name. The preset owns the panel, so `participantIds` is **not** accepted; everything else is overridable per call.

````jsonc
{
  "name": "consensus_code_review",
  "arguments": {
    "prompt": "Review this diff for the new auth middleware:\n\n```diff\n@@ -42,6 +42,12 @@ export async function …\n```",
    "maxRounds": 4, // optional; preset default is 3
  },
}
````

### Persona requirements

Each preset declares which personas it needs and which are optional. A preset's tool description in `tools/list` lists the panel and flags `[required]` vs `[optional]` per entry. If a required persona isn't in your config (and no fallback is either), the description prefixes `⚠ Currently NOT RUNNABLE` and the tool call returns an `isError` result naming the missing persona.

Most presets degrade gracefully — `code_review`, for example, treats `domain-expert` as required but accepts `first-principles` as a fallback. Check the per-tool description in your host to see what your config supports out of the box.

### Output

Preset tool responses follow the same shape as the generic tool: `content[0].text` is a markdown summary, `structuredContent` is the full `ConsensusResult` JSON. The summary leads with the judge synthesis (since that's the structured task output), then the panel responses, then the per-round score table.

If your config has no judge, presets still run and emit raw panel responses with a note. Configure a judge to get the structured synthesis the preset's `judgeSystemPrompt` is shaped for.

## Errors

- **Config load errors** are fatal at startup and printed to stderr with the offending field path.
- **Tool input errors** return `{ isError: true, content: [{ type: "text", text: "…" }] }` — the host sees them but the server stays up.
- **Provider errors** (HTTP non-2xx, empty streams) are captured into the per-participant `response.error` field and the run continues with the remaining participants. Errors are visible in both the progress stream and the final structured result.
- **Cancellation.** When the host cancels a tool call, the `AbortSignal` propagates into every in-flight `fetch` and the engine returns a `ConsensusResult` with `stopReason: "aborted"`.

## Limits and non-goals

- **Optional persistence only.** The default is stateless — every tool call is a fresh run. Opt in to the [memory layer](./docs/memory-layer.md) for project-scoped recall; the data lives on local disk only.
- **No HTTP transport.** Stdio only. For HTTP/SSE, wrap [`ai-consensus-core`](https://github.com/entropyvortex/ai-consensus-core) directly.
- **No token-budget enforcement.** `maxOutputTokens` is advisory per call; put usage alerts on your provider dashboards.
- **No multi-run scheduling.** One run per call, sequential if the host queues them.
- **No encryption at rest for memory.** The memory layer writes plaintext JSON. Don't enable it for runs whose questions contain secrets you don't want stored. See [`docs/memory-layer.md`](./docs/memory-layer.md#threat-model-and-the-storage-trade).

If any of these become the thing you need most, the core library is the right place to plug in — this server is intentionally tiny.

## Development

```bash
git clone https://github.com/entropyvortex/ai-consensus-mcp.git
cd ai-consensus-mcp
npm install
npm run test        # vitest — config loader + MCP handshake integration
npm run build
npm start -- --config ./consensus.config.json
```

## Philosophy

The core library should be able to live anywhere — Next.js, CLI, worker, Durable Object, another MCP server. That's why it doesn't know what an LLM provider is.

This package is the "anywhere" most people care about first: a stdio MCP server that drops into Claude Code, Cursor, Windsurf, or any host that speaks the protocol. It's deliberately small — loads a config, forwards events, nothing else. If you outgrow it, the core is right there.

## See also

- [`ai-consensus-core`](https://github.com/entropyvortex/ai-consensus-core) — the underlying library. Use it directly if you need HTTP transport, custom schedulers, or deeper integration.

## License

MIT

---

**Part of the [entropyvortex](https://github.com/entropyvortex) stack** — practical, no-bullshit AI open source by [Marcelo Ceccon](https://github.com/marceloceccon).

Made with ❤️ in Brazil.

MIT License • Built to ship.
