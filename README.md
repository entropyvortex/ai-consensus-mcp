# ai-consensus-mcp

[![npm](https://img.shields.io/npm/v/ai-consensus-mcp)](https://www.npmjs.com/package/ai-consensus-mcp)
[![license](https://img.shields.io/npm/l/ai-consensus-mcp)](./LICENSE)

> Grok-centered multi-model consensus inside Cursor, Claude Code, and Windsurf. One config file. 14 tools. Measurably better decisions on code review, architecture, security, and hard calls.

**Turn any set of models into a disciplined roundtable that catches what single-model prompting misses.**

## 30-second install

```bash
npx -y ai-consensus-mcp config          # walks you through providers + participants
npx -y ai-consensus-mcp install --config ~/.consensus.config.json
```

Restart your host. The `consensus` tool and 13 expert panels appear in autocomplete.

**Benchmarks are the point.** Scroll one section for the data.

---

## Proven in Benchmarks – Not Just Marketing

**Consensus beats single-model prompting on objective quality on real software engineering tasks.**

In the most rigorous evaluation to date (architecture_v2 panel, 4 held-out cases, 3 deterministic runs each, seed=42, external judge model never involved in the debate):

| Metric (held-out rubric, blind)          | Consensus | Single-Model Baseline | Δ      |
|------------------------------------------|-----------|-----------------------|--------|
| Average rubric score (0-100)             | **83.3**  | 48.0                  | **+35.3** |
| Wins (external judge, 12/12 runs)        | **12**    | 0                     | **100%**  |

The panel won on **every single run** against the identical model used as a strong single-shot baseline. The gap was largest on the case that single-model prompting handled worst (+51 points).

Self-reported confidence told the opposite story: consensus runs averaged **lower** confidence (60.0) than the baseline (75.4). The external judge still preferred the consensus output every time.

### Why this matters
- **+35 rubric points** on a 5-criterion architecture rubric (quantification, single recommendation, reversibility weighing, tripwire specificity, failure-mode realism).
- The baseline repeatedly missed reversibility analysis and concrete tripwires. The panel surfaced them consistently.
- This is not "more opinions = better." This is a specific protocol (blind round 1 → full-visibility debate → confidence-weighted scoring + structured judge synthesis) beating a strong frontier model at the same task.

**Full benchmark suite, raw JSON outputs, rubric definitions, human eval protocol, and one-click reproduction:**

```bash
npx ai-consensus-mcp bench -p architecture_v2 --runs 3 --seed 42 \
  --evaluator-model claude-opus-4-5 --evaluator-provider anthropic
```

The same harness exists for code review, security red-teaming, decision-making, incident postmortems, ML research, and product strategy panels. Early runs show the same structural pattern: the multi-model debate surfaces edge cases and trade-off rigor that single-model answers elide.

**Reproduce the exact numbers above** with the command in the current repo (requires Grok + Anthropic keys for the evaluator). Raw data lives in the repo under `bench-*.json` artifacts.

**Honest caveats** (we ship these in the output):
- N=12 is small but the direction was 12/12 with a 35-point gap. Reproducible with the seed.
- Real cost: ~40× tokens and 20× wall time vs one baseline call. For high-stakes architecture or security decisions this is cheap insurance. For routine refactors, single-model is usually fine.
- Self-reported confidence is a poor quality signal. The panel often surfaces *more* uncertainty while producing better answers.

The benchmark CLI and held-out rubric evaluator ship with the package. This is not marketing copy — it's an executable claim you can run yourself.

---

## What's new in v0.12

- **8 versioned v2 expert panels** with machine-readable `expectedOutputShape`, structured rationale, and tighter prompts (architecture, code review, security red-team, ML research 2026, product strategy, decision-making, incident postmortem, research synthesis).
- **`bench` CLI subcommand** — deterministic uplift measurement against single-model baseline, with optional held-out LLM-as-judge rubric scoring.
- **Persistent project memory** (opt-in) — every consensus result stored under a project key. Three new recall tools (`consensus_recall`, `consensus_project_memory`, `consensus_what_we_decided`) with atomic writes and fragment-based search.
- `panel` argument on the generic `consensus` tool so hosts that don't enumerate per-panel tools can still target a curated panel.
- All v1 presets continue to work unchanged.

---

## What it gives you

- **One config, 14+ tools.** Generic `consensus` plus 13 task-tuned expert panels. Invoke a panel name; get the right personas, rounds, temperature, and judge prompt without tuning knobs.
- **Any OpenAI-compatible provider.** Grok-4, Claude (via Anthropic compat), OpenAI, Groq, Together, Fireworks, local gateways. Per-participant routing.
- **The calling agent can sit at the table** (experimental). Mark a participant `kind: "host-sample"` and the MCP host answers via `sampling/createMessage`. Currently works in Claude Desktop; tracked for Claude Code / Cursor / Windsurf.
- **Live progress.** Every engine round, confidence shift, and disagreement surfaces as MCP progress notifications.
- **Optional durable memory.** Project-scoped, queryable history of prior decisions with the exact context that produced them.
- **Built-in benchmarking.** `npx ai-consensus-mcp bench` measures whether the panel actually helps on your task class — with the same held-out rubric method shown above.

See [docs/expert-panels.md](./docs/expert-panels.md) for the full catalogue and per-panel output shapes.

---

## Install & Configure

Full instructions: [docs/install.md](./docs/install.md)

The interactive config wizard handles providers, participants (including host-sample), judge, and defaults, then writes an atomic, schema-validated `~/.consensus.config.json`.

Manual example (minimal):

```json
{
  "providers": {
    "xai": { "baseUrl": "https://api.x.ai/v1", "apiKeyEnv": "GROK_API_KEY" },
    "anthropic": { "baseUrl": "https://api.anthropic.com/v1", "apiKeyEnv": "CONSENSUS_ANTHROPIC_API_KEY" }
  },
  "participants": [
    { "id": "grok", "provider": "xai", "modelId": "grok-4", "personaId": "pessimist" },
    { "id": "domain", "provider": "anthropic", "modelId": "claude-sonnet-4-6", "personaId": "domain-expert" }
  ],
  "judge": { "provider": "xai", "modelId": "grok-4" }
}
```

### Host-sample participants (the calling agent joins the debate)

```json
{
  "kind": "host-sample",
  "id": "self",
  "personaId": "domain-expert",
  "modelHint": "claude-sonnet"
}
```

When this participant's turn arrives, the MCP host is asked to answer in character. Human approval is required in Claude Desktop today.

---

## The `consensus` tool (and every preset)

**Input** (generic tool — presets own the panel):

```jsonc
{
  "prompt": "Should we adopt event sourcing for the new billing ledger?",
  "panel": "architecture_v2",           // optional but recommended for real work
  "maxRounds": 4,
  "judge": true,
  "randomSeed": 42                      // for deterministic replay
}
```

**Output** on every successful call:
1. Human-readable markdown summary (final score, per-round table, participant responses, judge synthesis).
2. `structuredContent`: the full typed `ConsensusResult` for programmatic use.

Every engine event (`roundComplete`, `disagreementDetected`, `synthesisComplete`, etc.) is forwarded as an MCP progress notification.

Presets (e.g. `consensus_architecture_v2`, `consensus_security_redteam`) are registered as first-class tools. They accept the same knobs except `participantIds` (the panel owns the voices).

---

## Persistent Memory (opt-in)

Set `"memory": { "enabled": true }` in your config.

Three new tools become available:
- `consensus_recall` — keyword search with matched fragments
- `consensus_project_memory` — full project history
- `consensus_what_we_decided` — distilled prior conclusions on a topic

Atomic writes, sentinel-locked index, retention policy. Data lives on local disk only. See [docs/memory-layer.md](./docs/memory-layer.md) for threat model and format.

---

## Protocol (what actually happens)

See the [ai-consensus-core protocol diagram](https://github.com/entropyvortex/ai-consensus-core#protocol-diagram) for the round structure, scoring formula, and `CONFIDENCE: N` contract.

This server is a thin, faithful wrapper: it loads your config, builds the right `ModelCaller` (HTTP or host sampling), wires progress, applies preset panels when requested, and surfaces results + optional memory.

---

## Limits & Non-Goals

- Stdio transport only (the MCP server itself). For HTTP/SSE use the core library directly.
- No token-budget enforcement inside the tool — put alerts on your provider keys.
- Memory is plaintext on disk. Do not enable it for prompts containing secrets you do not want persisted locally.
- Host sampling is currently reliable only in Claude Desktop.

If you need something this server deliberately does not do, the right place is almost always `ai-consensus-core` or a thin custom wrapper around it.

---

## Development

```bash
git clone https://github.com/entropyvortex/ai-consensus-mcp.git
cd ai-consensus-mcp
npm install
npm run build
npm test
npm start -- --config ./consensus.config.json
```

The test suite covers config loading, preset resolution, input schema generation, memory store invariants, and MCP handshake behavior.

---

## Philosophy

Most "multi-agent" frameworks are toys or vendor lock-in.

This one is the opposite: a minimal, observable, deterministic debate protocol (core) + the thinnest possible product surface that makes it usable inside real coding agents (this package).

We optimize for **ground-truth quality on hard engineering questions**, not for marketing slogans or lowest token count. The benchmark harness ships with the product because claims without executable reproduction are worthless.

---

## License

MIT

**Part of the [entropyvortex](https://github.com/entropyvortex) stack** — practical, no-bullshit AI open source.

Made with ❤️ in Brazil.

See also: [`ai-consensus-core`](https://github.com/entropyvortex/ai-consensus-core) — the protocol engine and TypeScript library.
