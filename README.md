# ai-consensus-mcp

> A minimal stdio [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the Consensus Validation Protocol as a single `consensus` tool.
> Give Claude Code, Cursor, Windsurf — or any MCP host — a real multi-model roundtable.

[![npm](https://img.shields.io/npm/v/ai-consensus-mcp)](https://www.npmjs.com/package/ai-consensus-mcp)
[![license](https://img.shields.io/npm/l/ai-consensus-mcp)](./LICENSE)

Thin wrapper over [`@entropyvortex/ai-consensus-core`](https://github.com/entropyvortex/ai-consensus-core). One tool, one config file, zero drama.

## What it gives you

- **One MCP tool: `consensus`.** Point it at a list of models + personas and run a multi-round debate.
- **Any OpenAI-compatible provider.** xAI Grok, Anthropic (via OpenAI-compat endpoint), OpenAI, Groq, Together, Fireworks, or your private gateway. One adapter, configurable per participant.
- **Live progress.** Every structured engine event is forwarded as an MCP [progress notification](https://modelcontextprotocol.io/specification/2025-03-26/basic/utilities/progress) — hosts render real-time round/participant/disagreement/score status.
- **Dependency-light.** `@modelcontextprotocol/sdk`, `zod`, `@entropyvortex/ai-consensus-core`. SSE parsing is native `fetch` — no provider SDKs.

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
cp consensus.config.example.json ./consensus.config.json
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
    { "id": "grok",   "provider": "xai",       "modelId": "grok-4",            "personaId": "pessimist" },
    { "id": "domain", "provider": "anthropic", "modelId": "claude-sonnet-4-6", "personaId": "domain-expert" },
    { "id": "devil",  "provider": "xai",       "modelId": "grok-4",            "personaId": "devils-advocate" }
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
  "maxRounds": 4,            // optional, 1–10
  "participantIds": ["grok", "domain"],  // optional — subset of configured participants
  "earlyStop": true,         // optional
  "judge": true,             // optional — defaults to config.defaults.useJudge
  "blindFirstRound": true,   // optional
  "randomizeOrder": true,    // optional
  "convergenceDelta": 3,     // optional
  "disagreementThreshold": 20, // optional
  "participantTemperature": 0.7, // optional
  "maxOutputTokens": 1500,   // optional
  "randomSeed": 42           // optional — deterministic round-order shuffle
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

| Engine event            | Example progress message                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| `roundStart`            | `Round 2/4 — Counterarguments (sequential) starting`                             |
| `participantStart`      | `  grok (grok-4) thinking…`                                                      |
| `participantComplete`   | `  grok done — confidence=72 (4132ms)`                                           |
| `confidenceUpdate`      | `  running avg round 2: 74.5 (last: grok=72)`                                    |
| `disagreementDetected`  | `  ⚠ disagreement: Risk Analyst vs Optimistic Futurist (Δ=35)`                   |
| `roundComplete`         | `Round 2 complete — score=71, avg=74.5, σ=7.0, disagreements=1`                  |
| `earlyStop`             | `✓ Early stop at round 3: Consensus score delta 2.0 … is at or below …`          |
| `synthesisStart`        | `Judge synthesis starting (grok-4)…`                                             |
| `synthesisComplete`     | `Judge synthesis complete (confidence=84)`                                       |
| `finalResult`           | `Consensus complete — finalScore=76, rounds=3, stopReason=converged`             |

`progress` increments monotonically on `roundComplete` and `synthesisComplete`; `total` is `maxRounds + (judge ? 1 : 0)`.

## Errors

- **Config load errors** are fatal at startup and printed to stderr with the offending field path.
- **Tool input errors** return `{ isError: true, content: [{ type: "text", text: "…" }] }` — the host sees them but the server stays up.
- **Provider errors** (HTTP non-2xx, empty streams) are captured into the per-participant `response.error` field and the run continues with the remaining participants. Errors are visible in both the progress stream and the final structured result.
- **Cancellation.** When the host cancels a tool call, the `AbortSignal` propagates into every in-flight `fetch` and the engine returns a `ConsensusResult` with `stopReason: "aborted"`.

## Limits and non-goals

- **No persistence.** Every tool call is a fresh run. If you want history, record `structuredContent` on the host side.
- **No HTTP transport.** Stdio only. For HTTP/SSE, wrap [`@entropyvortex/ai-consensus-core`](https://github.com/entropyvortex/ai-consensus-core) directly.
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

- [`@entropyvortex/ai-consensus-core`](https://github.com/entropyvortex/ai-consensus-core) — the underlying library. Use it directly if you need HTTP transport, custom schedulers, or deeper integration.

## License

MIT

---

**Part of the [entropyvortex](https://github.com/entropyvortex) stack** — practical, no-bullshit AI open source by [Marcelo Ceccon](https://github.com/marceloceccon).

Made with ❤️ in Brazil.

MIT License • Built to ship.
