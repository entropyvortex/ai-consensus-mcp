# ai-consensus-mcp

> A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that turns any MCP host into a multi-model roundtable.
> Generic `consensus` tool plus task-tuned presets — code review, architecture debate, research synthesis, decision support, incident postmortem — each invokable as one command.

[![npm](https://img.shields.io/npm/v/ai-consensus-mcp)](https://www.npmjs.com/package/ai-consensus-mcp)
[![license](https://img.shields.io/npm/l/ai-consensus-mcp)](./LICENSE)

Thin wrapper over [`ai-consensus-core`](https://github.com/entropyvortex/ai-consensus-core). One config file, six tools, zero drama.

## Install in 30 seconds

```bash
# 1. Create a provider config (see "Configure" below for the schema)
cp consensus.config.example.json ~/.consensus.config.json
$EDITOR ~/.consensus.config.json

# 2. Auto-register with every installed MCP host
npx -y ai-consensus-mcp install --config ~/.consensus.config.json
```

The installer detects Claude Code, Cursor, and Windsurf and merges a `consensus` server entry into each one's MCP config (atomic write, never clobbers other entries). Restart the host afterwards — the `consensus` tool plus five preset variants (`consensus_code_review`, `consensus_architecture_debate`, `consensus_research_synthesis`, `consensus_decision_making`, `consensus_debug_postmortem`) appear in autocomplete.

Scope the run with `--hosts claude-code,cursor`. Run `npx ai-consensus-mcp install --list-hosts` to see what's detected on your machine. Full reference in [`docs/install.md`](./docs/install.md).

## What it gives you

- **Six MCP tools, one config.** The generic `consensus` tool plus five task-tuned presets (`consensus_code_review`, `consensus_architecture_debate`, `consensus_research_synthesis`, `consensus_decision_making`, `consensus_debug_postmortem`). Invoke a preset; get a curated panel and tuned defaults without touching the knobs.
- **Any OpenAI-compatible provider.** xAI Grok, Anthropic (via OpenAI-compat endpoint), OpenAI, Groq, Together, Fireworks, or your private gateway. One adapter, configurable per participant.
- **Live progress.** Every structured engine event is forwarded as an MCP [progress notification](https://modelcontextprotocol.io/specification/2025-03-26/basic/utilities/progress) — hosts render real-time round/participant/disagreement/score status.
- **Dependency-light.** `@modelcontextprotocol/sdk`, `zod`, `ai-consensus-core`. SSE parsing is native `fetch` — no provider SDKs.

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

Copy the example and edit it:

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
      "apiKeyEnv": "ANTHROPIC_API_KEY"
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
participants[].provider        string   Key into providers.
participants[].modelId         string   Opaque model id the provider accepts.
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

## Run standalone

```bash
export GROK_API_KEY=xai-...
export ANTHROPIC_API_KEY=sk-ant-...

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
        "ANTHROPIC_API_KEY": "sk-ant-..."
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

## Presets

The generic `consensus` tool exposes every engine knob. For most real work you don't want to tune knobs — you want a tuned panel for a specific task. Presets are that.

Each preset is registered as its own MCP tool, so hosts surface them in autocomplete:

| Tool                            | Panel (personas)                                                         | Rounds | Temp | Output shape                                                              |
| ------------------------------- | ------------------------------------------------------------------------ | -----: | ---: | ------------------------------------------------------------------------- |
| `consensus_code_review`         | pessimist, domain-expert, devils-advocate, first-principles              |      3 |  0.3 | Severity-tagged findings (BLOCKER/MAJOR/MINOR/NIT) with locations + fixes |
| `consensus_architecture_debate` | first-principles, domain-expert, vc-specialist, pessimist                |      4 |  0.6 | Decision matrix + single recommendation + flip conditions                 |
| `consensus_research_synthesis`  | scientific-skeptic, domain-expert, first-principles, optimistic-futurist |      4 |  0.4 | Citation-first claims with HIGH/MEDIUM/LOW confidence + open questions    |
| `consensus_decision_making`     | vc-specialist, pessimist, domain-expert, devils-advocate                 |      4 |  0.5 | Ranked options with EV / risks / upsides + flip conditions                |
| `consensus_debug_postmortem`    | pessimist, domain-expert, first-principles, scientific-skeptic           |      3 |  0.3 | Postmortem report (timeline, 5-whys root cause, remediation items)        |

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

- **No persistence.** Every tool call is a fresh run. If you want history, record `structuredContent` on the host side.
- **No HTTP transport.** Stdio only. For HTTP/SSE, wrap [`ai-consensus-core`](https://github.com/entropyvortex/ai-consensus-core) directly.
- **No token-budget enforcement.** `maxOutputTokens` is advisory per call; put usage alerts on your provider dashboards.
- **No multi-run scheduling.** One run per call, sequential if the host queues them.

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
