# ai-consensus-mcp

Catches the blind spots a single model leaves in code review, architecture and security calls, from inside your editor.

[![CI](https://github.com/entropyvortex/ai-consensus-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/entropyvortex/ai-consensus-mcp/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/ai-consensus-mcp)](https://www.npmjs.com/package/ai-consensus-mcp)
[![license](https://img.shields.io/npm/l/ai-consensus-mcp)](./LICENSE)

Used in real Vortex Serviços and SabIA production work for code review, architecture decisions and incident postmortems.

Tests and CI: typecheck, lint, format check, the Vitest suite with coverage and a stdio smoke test run on Node 20 and 22 for every pull request.

> Grok-centered multi-model consensus — in Cursor, Claude Code, and Windsurf (stdio), or as a **Grok custom connector** (remote HTTP). One config file. 14 tools. Measurably better decisions on code review, architecture, security, and hard calls.

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

| Metric (held-out rubric, blind)   | Consensus | Single-Model Baseline | Δ         |
| --------------------------------- | --------- | --------------------- | --------- |
| Average rubric score (0-100)      | **83.3**  | 48.0                  | **+35.3** |
| Wins (external judge, 12/12 runs) | **12**    | 0                     | **100%**  |

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
- Self-reported confidence is a poor quality signal. The panel often surfaces _more_ uncertainty while producing better answers.

The benchmark CLI and held-out rubric evaluator ship with the package. This is not marketing copy — it's an executable claim you can run yourself.

---

## What's new in v0.12

- **8 versioned v2 expert panels** with machine-readable `expectedOutputShape`, structured rationale, and tighter prompts (architecture, code review, security red-team, ML research 2026, product strategy, decision-making, incident postmortem, research synthesis).
- **`bench` CLI subcommand** — deterministic uplift measurement against single-model baseline, with optional held-out LLM-as-judge rubric scoring.
- **Persistent project memory** (opt-in) — every consensus result stored under a project key. Three new recall tools (`consensus_recall`, `consensus_project_memory`, `consensus_what_we_decided`) with atomic writes and fragment-based search.
- `panel` argument on the generic `consensus` tool so hosts that don't enumerate per-panel tools can still target a curated panel.
- **Remote Streamable HTTP** — deploy as a public MCP server and register at [grok.com/connectors](https://grok.com/connectors) as a custom connector (Cloudflare Workers, Node, Docker, etc.).
- All v1 presets continue to work unchanged.

---

## Using as a Grok Custom Connector

Give Grok a self-hosted multi-model consensus layer — Grok plus Claude (or any OpenAI-compatible providers) debating hard questions with structured output and live progress.

**Self-hosting is the model:** you deploy your own instance with your own provider API keys. There is no central hosted service or account system.

### 1. Create a config

```bash
npx -y ai-consensus-mcp config
```

Or copy [`consensus.config.example.json`](./consensus.config.example.json). Each provider declares an `apiKeyEnv` — the server reads the key from that environment variable at runtime.

### 2. Deploy (pick one)

#### Cloudflare Workers (recommended for a public URL)

```bash
git clone https://github.com/entropyvortex/ai-consensus-mcp.git
cd ai-consensus-mcp && npm install
npx -y wrangler@4 secret put CONSENSUS_CONFIG_JSON   # paste your full config JSON
npx -y wrangler@4 secret put CONSENSUS_HTTP_API_KEY  # openssl rand -base64 32
npx -y wrangler@4 secret put GROK_API_KEY
npx -y wrangler@4 secret put ANTHROPIC_API_KEY       # if your config uses Anthropic
npm run deploy:cloudflare
```

Wrangler is not a project dependency; the deploy scripts fetch `wrangler@4` on demand and bundle the TypeScript sources directly (no build step needed).

**Cloudflare Git CI:** root directory `/`, build command `npm install` (or empty), deploy `npm run deploy:cloudflare`. Set the Git branch to `main` (or your feature branch until merge). Do **not** set root directory to `examples/cloudflare`.

Your MCP endpoint is `https://<worker-name>.<account>.workers.dev/mcp`. See [examples/cloudflare/README.md](./examples/cloudflare/README.md).

**Workers limits:** consensus issues multiple sequential model calls. Free-tier CPU may time out on long panels — upgrade to a paid Workers plan (then optionally add `[limits] cpu_ms` in `wrangler.toml`) or use Node for heavy production load. The memory layer is unavailable on Workers (no local disk).

#### Node.js (direct HTTP)

```bash
export GROK_API_KEY=...
export ANTHROPIC_API_KEY=...
export CONSENSUS_HTTP_API_KEY="$(openssl rand -base64 32)"
ai-consensus-mcp serve --http --config /path/to/consensus.config.json \
  --host 0.0.0.0 --port 3000 --path /mcp
```

Put HTTPS in front (Caddy, nginx, Railway, Fly.io, Render). Register the public URL including the path, e.g. `https://consensus.example.com/mcp`.

The server **refuses to start** on any non-loopback `--host` (anything but `127.0.0.0/8`, `::1`, `localhost`) unless `CONSENSUS_HTTP_API_KEY` is set. `--allow-unauthenticated` overrides this for setups where a trusted layer in front enforces access control; it logs a loud warning.

If the proxy runs on the same machine and forwards to `127.0.0.1` while preserving the public `Host` header (Caddy does by default), add that name with `--allowed-hosts consensus.example.com`. Loopback binds validate `Host` to block DNS-rebinding attacks from web pages.

HTTP-mode guardrails (defaults in parentheses): `--max-concurrent-tool-calls` (4; extra calls get HTTP 429), `--max-prompt-chars` (100000), `--max-output-tokens` (8192, the highest `maxOutputTokens` a caller may request). JSON-RPC batches that contain `tools/call` are rejected, and browser `Origin`s are refused unless listed in `--allowed-origins`.

#### Docker (sketch)

```dockerfile
FROM node:22-alpine
RUN npm install -g ai-consensus-mcp
# Binding 0.0.0.0 requires CONSENSUS_HTTP_API_KEY at runtime — the server
# refuses to start without it. Never bake secrets into the image.
CMD ["ai-consensus-mcp", "serve", "--http", "--host", "0.0.0.0", "--port", "3000", \
     "--config", "/config/consensus.config.json"]
```

```bash
docker run -p 3000:3000 -v "$PWD/config:/config:ro" \
  -e CONSENSUS_HTTP_API_KEY -e GROK_API_KEY -e ANTHROPIC_API_KEY ai-consensus-mcp-image
```

Mount the config and inject secrets from your orchestrator's secret manager.

### 3. Protect the endpoint (required for public URLs)

Set `CONSENSUS_HTTP_API_KEY` to a long random secret. Every MCP request must include it:

```http
Authorization: Bearer <your CONSENSUS_HTTP_API_KEY>
```

or `X-Consensus-Api-Key: <your CONSENSUS_HTTP_API_KEY>`. The `/health` probe stays open for deploy checks and returns only `{"status":"ok"}`.

Without this env var, anyone who discovers your URL can invoke consensus and spend your provider keys — which is why the Node server will not bind a non-loopback address without it, and the Workers entry returns 500 until the secret exists.

### 4. Register on Grok

1. Open [https://grok.com/connectors](https://grok.com/connectors)
2. **New Connector → Custom**
3. Paste your public MCP URL (must include the path, e.g. `https://your-host/mcp`)
4. Add the custom header `Authorization: Bearer <CONSENSUS_HTTP_API_KEY>`. If your connector cannot send a custom header, do **not** work around it with a reverse proxy that injects the key: the proxy would authenticate every caller, leaving the endpoint effectively open. This server does not implement MCP OAuth.
5. Save — Grok discovers `consensus`, all `consensus_<panel>` tools, and memory tools (if enabled on the server)

### 5. Example prompts

Try these once the connector is live:

- _"Use consensus_architecture_v2 to evaluate whether we should split our monolith billing service into three microservices given 5 engineers and a Q3 launch deadline."_
- _"Run consensus_security_redteam on this auth flow: JWT in localStorage, refresh via httpOnly cookie, no MFA. Surface the top 5 exploitable risks with concrete mitigations."_
- _"Use consensus_decision_making_v2: stay on Postgres vs migrate to CockroachDB for multi-region. We have 2M rows, 200 QPS, and cannot afford >30 min downtime."_

### Cost, latency, and security

| Topic        | What to expect                                                                                                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cost**     | Consensus deliberately uses ~40× the tokens of a single model call (multiple participants × multiple rounds + optional judge). Budget accordingly on provider dashboards.                                                                                                                                |
| **Latency**  | Wall time is ~20× a single call. Progress notifications stream live status during the run.                                                                                                                                                                                                               |
| **Security** | Set `CONSENSUS_HTTP_API_KEY` on every public deploy (required for non-loopback Node binds). MCP routes return 401 without a matching Bearer / `X-Consensus-Api-Key` header. Provider keys stay server-side; the endpoint secret only gates who may call your instance. Never commit either class of key. |
| **Memory**   | Opt-in persistent memory writes to local disk — enable only on trusted hosts, not on ephemeral Workers.                                                                                                                                                                                                  |

---

## What it gives you

- **One config, 14+ tools.** Generic `consensus` plus 13 task-tuned expert panels. Invoke a panel name; get the right personas, rounds, temperature, and judge prompt without tuning knobs.
- **Any OpenAI-compatible provider.** Grok-4, Claude (via Anthropic compat), OpenAI, Groq, Together, Fireworks, local gateways. Per-participant routing.
- **The calling agent can sit at the table** (experimental). Mark a participant `kind: "host-sample"` and the MCP host answers via `sampling/createMessage`. Currently works in Claude Desktop; tracked for Claude Code / Cursor / Windsurf.
- **Live progress.** Every engine round, confidence shift, and disagreement surfaces as MCP progress notifications.
- **Optional durable memory.** Project-scoped, queryable history of prior decisions with the exact context that produced them.
- **Built-in benchmarking.** `npx ai-consensus-mcp bench` measures whether the panel actually helps on your task class — with the same held-out rubric method shown above.
- **Remote HTTP.** Stateless Streamable HTTP for Grok custom connectors and any remote MCP client — same tool surface as stdio.

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
    }
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

## Subscription CLI seats

The default transport is HTTP (`baseUrl` + `apiKeyEnv`). Omit `transport` and the provider stays HTTP. Set `"transport": "cli"` with `"driver": "grok"` or `"driver": "claude"` to seat a signed-in CLI instead of a metered API key. The config wizard can add and edit those two drivers. Its HTTP form is never opened for a CLI provider, so a save cannot turn `transport: "cli"` into `baseUrl` + `apiKeyEnv`. For grok, `authPath` is the file checked for sign-in readiness (default `~/.grok/auth.json`); it does not change which login grok uses, and the claude driver ignores it.

Each CLI call is a text oracle: a fresh temp directory, an allowlisted child environment (API keys are not copied), and a 120s timeout. Claude denies built-in tools (`--tools ""` and `--restricted`). Grok denies subagents (`--no-subagents`) and web search (`--disable-web-search`) only. Grok's `--disallowed-tools` and `--deny` exist, but `--help` does not list tool names, so this version does not pass a guessed denylist. Other Grok tools are an accepted residual. `~/.grok/config.toml` can still enable tools; there is no executed flag that ignores that file. Writes outside the temp directory are not detected.

Codex is not yet implemented; `driver: "codex"` is refused when a participant uses it. The wizard does not offer it, and editing an existing codex provider leaves the block unchanged.

CLI seats run only where the server process runs next to a signed-in CLI. For remote deployments (see [Using as a Grok Custom Connector](#using-as-a-grok-custom-connector)): Cloudflare Workers reject a `CONSENSUS_CONFIG_JSON` secret that contains any CLI provider when the config is resolved, and the error names the provider, so keep that secret HTTP-only. On Node, CLI seats are disabled in HTTP mode unless you pass `--allow-cli` to `serve --http`. A remote connector cannot see your local `grok login`; for a personal subscription seat, run `ai-consensus-mcp serve` on the machine where the CLI is signed in.

Sizing uses an assumed 30 second median call (an assumption, not a measurement) and `cliMaxInFlight: 2`. Three participants, `maxRounds: 4`, and a judge are 13 calls, about 6 minutes. Early stop after round 2 is 7 calls, about 3 minutes. If every call hits the 120 second timeout those become about 24 minutes and about 12 minutes. The engine default `maxRounds` stays 4. [`consensus.config.subscription.example.json`](./consensus.config.subscription.example.json) sets `maxRounds: 2` and `cliMaxInFlight: 2` and seats grok, claude, and one HTTP provider. It does not seat Codex. HTTP panels are not queued behind the CLI gate.

`bench` does not require a CLI and does not refuse to run when one is configured. Its stderr estimate is `cases × runs × ((participants × maxRounds + judge) + baseline + rubricCalls)`, an upper bound when early-stop fires. If any of those providers is CLI, stderr adds a subscription warning. A CLI judge is also the default baseline, and a CLI rubric evaluator is another spawn. An HTTP-only config never takes that warning.

---

## The `consensus` tool (and every preset)

**Input** (generic tool — presets own the panel):

```jsonc
{
  "prompt": "Should we adopt event sourcing for the new billing ledger?",
  "panel": "architecture_v2", // optional but recommended for real work
  "maxRounds": 4,
  "judge": true,
  "randomSeed": 42, // for deterministic replay
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

- **Transports:** stdio (local MCP hosts) and stateless Streamable HTTP (remote/Grok). No SSE-only or stateful session mode in v1.
- No token-budget enforcement inside the tool — put alerts on your provider keys.
- Memory is plaintext on disk. Do not enable it for prompts containing secrets you do not want persisted locally. Unavailable on Cloudflare Workers.
- Host sampling is currently reliable only in Claude Desktop.
- Public HTTP instances require `CONSENSUS_HTTP_API_KEY` — `serve --http` refuses a non-loopback bind without it (override: `--allow-unauthenticated`).
- Stateless HTTP cancellation is by disconnect: closing the connection aborts the run and its provider calls. An MCP `notifications/cancelled` sent on a separate POST cannot reach the in-flight call in stateless mode.

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

The test suite covers config loading, preset resolution, input schema generation, memory store invariants, stdio MCP handshake, and Streamable HTTP integration (listTools, progress, cancellation).

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
