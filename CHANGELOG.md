# Changelog

All notable changes to `ai-consensus-mcp` will be documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — adapter HTTP-caller and progress.ts unit tests; coverage ratchet

Two new test files, +16 tests, covering modules that previously had little or no direct coverage. Driven by consensus code-review feedback.

- `src/__tests__/adapter-http.test.ts` — 9 tests for `createOpenAICompatibleCaller`. Mocks `globalThis.fetch` and constructs SSE-formatted `ReadableStream`s to exercise the streaming parser end to end without hitting a real provider. Covers: streamed-delta assembly + usage parsing; computed totalTokens fallback; cross-chunk JSON line reassembly; `data:` lines with unparseable payloads silently skipped; non-OK HTTP responses (status, statusText, truncated body); empty-stream rejection; missing provider mapping; mapped provider id not loaded; bearer auth + extra headers + body shape forwarded correctly.
- `src/__tests__/progress.test.ts` — 7 tests for `wireEngineProgress`. Uses a duck-typed mock engine (on/off/emit) to drive each handler. Covers: `total` calculation with/without judge; progress-counter increments on roundComplete + synthesisComplete; participant lifecycle rendering (success + error tags); confidence updates, disagreements, early stop, synthesis start, final result, engine errors; detach() removing all listeners; sendNotification rejections swallowed (best-effort delivery for disconnected clients).

`adapter.ts` coverage moved from 21.51% → 90.58% statements; `progress.ts` from 0% → ~100%.

Aggregate coverage:

|            | Before | After  | Threshold (Phase 2 ratchet) |
| ---------- | ------ | ------ | --------------------------- |
| statements | 66.78% | 78.45% | 78 (was 55)                 |
| branches   | 61.06% | 69.71% | 69 (was 47)                 |
| functions  | 66.38% | 83.33% | 83 (was 57)                 |
| lines      | 67.79% | 80.05% | 80 (was 55)                 |

`vitest.config.ts` thresholds bumped accordingly per the project's ratchet policy. `src/presets/**/*.ts` keeps its stricter floor (90/75/95/90), unchanged.

### Changed — typed `SamplingError` for host-sample failures

`callViaSampling` (and `createSamplingCaller`'s routing guard) now reject with a typed `SamplingError` instead of generic `Error` instances. Callers can branch on `code` instead of pattern-matching the message string.

```typescript
import { SamplingError } from "ai-consensus-mcp";

try {
  await caller(req);
} catch (err) {
  if (err instanceof SamplingError) {
    switch (err.code) {
      case "missing-entry": // routing bug — should never happen at runtime
      case "host-error": // host's createMessage rejected; original in err.cause
      case "unsupported-content": // host returned image/audio/etc; type in err.contentType
      case "empty-response": // host returned text but the string is empty
    }
  }
}
```

- `err.code` is one of `"missing-entry" | "host-error" | "unsupported-content" | "empty-response"`.
- `err.participantId` always set.
- `err.cause` carries the original host-side error for `code: "host-error"` (ES2022 `Error.cause`).
- `err.contentType` set when `code: "unsupported-content"`, e.g. `"image"`.
- Existing message strings are preserved verbatim, so tooling that grepped them still works.
- `err.toJSON()` is implemented so `JSON.stringify(err)` preserves `code`, `participantId`, `contentType`, `cause`, `message`, and `stack` for structured logging pipelines (a plain `Error` subclass would otherwise reduce to just the message string).

`SamplingError` is exported from `src/adapter.ts`. Ten unit tests in `adapter-sampling.test.ts` cover each failure mode plus the `toJSON` shape (Error cause, plain-object cause, unserializable cause, omitted optional fields).

### Changed — host-sample marked experimental; default Anthropic env var renamed

The `host-sample` participant kind is now positioned as experimental and **Claude Desktop only**. Of the hosts this server commonly runs under (Claude Desktop, Claude Code, Cursor, Windsurf), only Claude Desktop currently advertises the MCP `sampling` capability — Claude Code support is tracked at [anthropics/claude-code#1785](https://github.com/anthropics/claude-code/issues/1785). The feature itself is unchanged; what changed is how it's pitched and shipped:

- `consensus.config.example.json` no longer includes a `host-sample` participant by default; users opt in by editing the config.
- README's lead bullet and the dedicated section now state up front that host-sample only works in Claude Desktop today.
- The capability-gate error in `src/server.ts` no longer recommends "Claude Code" — it now names Claude Desktop and links the upstream tracking issue.

In parallel, the **default Anthropic `apiKeyEnv` renamed from `ANTHROPIC_API_KEY` to `CONSENSUS_ANTHROPIC_API_KEY`**. Reason: Claude Code auto-detects `ANTHROPIC_API_KEY` and warns about a conflict when the user is on a Claude Max subscription. Namespacing avoids the collision.

- `consensus.config.example.json`, `src/cli/config.ts` (provider catalog + starter config), `README.md`, and `docs/install.md` all updated.
- **Not breaking for existing configs.** Users with their own `consensus.config.json` keep whatever `apiKeyEnv` value they set. Only the defaults shipped to new users change.

### Added — host-sample participants (MCP sampling)

A participant can now be answered by the calling MCP host (Claude Code, Cursor, etc.) instead of a configured provider — it takes a seat at the consensus roundtable using whatever model the host happens to be running.

```jsonc
{
  "kind": "host-sample",
  "id": "self",
  "personaId": "domain-expert",
  "modelHint": "claude-sonnet", // optional; soft preference, hosts may ignore
}
```

When the engine asks for a host-sample participant's turn, the server issues an MCP `sampling/createMessage` request and forwards the host's reply as that participant's response. No extra API key, no extra provider entry — the host's LLM does the work and bills against the user's host session.

- `participants[].kind` defaults to `"provider"` (existing configs unchanged).
- `kind: "host-sample"` participants must omit `provider` and `modelId` — the host owns the model. They carry the synthetic `modelId` `"host-sample"` in engine events for clarity.
- Configs with zero providers are valid when every participant is `host-sample` — two host-sample participants with different personas give a "two voices, same model" debate.
- Pre-flight capability check: a tool call that would need sampling against a host that didn't advertise the `sampling` capability returns an `isError` response naming the participant, instead of hanging.
- The judge stays provider-only for now (no `judge.kind` field).

Internals:

- `src/config.ts` — `ParticipantConfigSchema` becomes a discriminated union (`ProviderParticipantConfigSchema` | `HostSampleParticipantConfigSchema`); `LoadedConfig` gains `hostSampleParticipants: Record<string, HostSampleMeta>`.
- `src/adapter.ts` — `createSamplingCaller` issues `server.createMessage(...)`; `createRoutedCaller` dispatches per-participant between sampling and the OpenAI-compatible HTTP caller.
- `src/server.ts` — `ensureSamplingSupported` gate runs before each tool call; the active `Server` instance flows into the routed caller so sampling requests land on the right transport.
- `src/presets/resolve-panel.ts` — `ResolvedPanel` now exposes `hostSampleParticipants`; preset task suffixes apply to host-sample participants the same way as provider-backed ones.
- `src/cli/config.ts` — interactive editor lets you pick "Configured provider" vs "MCP host sampling" when adding a participant; participant menu is reachable with zero providers configured.
- Tests: 5 focused unit tests for `createSamplingCaller` (positive path, modelHint forwarding, non-text rejection, host-error wrapping, missing-entry guard); config-loader tests for the new kind; server test for the capability-gate error; resolve-panel test for end-to-end propagation.

### Added — interactive config editor

CLI gains a `config` subcommand (alias: `configure`) that launches an
interactive TUI for managing the entire `consensus.config.json`:

```
ai-consensus-mcp config                            # edits ~/.consensus.config.json
ai-consensus-mcp config --config ./project.json    # any path; created if missing
```

- Add / edit / remove providers (baseUrl, apiKeyEnv, optional extraHeaders).
- Add / edit / remove participants with provider + persona selection from
  the in-process `PERSONAS` registry; participant ids enforced unique.
- Toggle / configure the optional judge (provider, modelId, optional
  temperature + maxOutputTokens).
- Edit any subset of `defaults` via a checkbox-driven form.
- "View raw JSON" and "Validate now" actions for sanity checks at any
  point; the full config is re-validated against the existing Zod
  schemas on save and the editor refuses to write a file the server
  wouldn't accept.
- Save is atomic: contents land in `<path>.tmp`, then `rename(2)` into
  place — a crash mid-write can't leave a half-written config.
- Ctrl-C and "Discard & exit" never write anything.

Internals:

- `src/cli/config.ts` — interactive flow, top-level menu + per-section
  sub-menus.
- `src/config.ts` gains `readRawConfig` / `writeRawConfig` helpers and
  exports `RawConfigSchema` + sub-schemas + `formatZodError` for reuse.
- New dependency: `@inquirer/prompts ^8.4.2` (modern function-per-prompt
  API maintained by the Inquirer.js project — ESM-first, typed, no
  classic `inquirer.prompt(...)` builder).
- Tests: round-trip + atomic-write + invalid-config-rejection cases for
  `readRawConfig` / `writeRawConfig`; dispatcher tests for the new
  `config` / `configure` subcommands.

### Added — presets

Five task-tuned preset tools, each registered as a separate MCP tool so hosts surface them in autocomplete:

- `consensus_code_review` — pessimist + domain-expert + devils-advocate + first-principles, low temp (0.3), 3 rounds; judge synthesis emits BLOCKER/MAJOR/MINOR/NIT findings.
- `consensus_architecture_debate` — first-principles + domain-expert + vc-specialist + pessimist, mid temp (0.6), 4 rounds; judge produces a decision matrix + single recommendation.
- `consensus_research_synthesis` — scientific-skeptic + domain-expert + first-principles + optimistic-futurist, low-mid temp (0.4), 4 rounds; judge produces citation-first claims with confidence levels.
- `consensus_decision_making` — vc-specialist + pessimist + domain-expert + devils-advocate, mid temp (0.5), 4 rounds; judge produces ranked options with EV / risks / upsides.
- `consensus_debug_postmortem` — pessimist + domain-expert + first-principles + scientific-skeptic, low temp (0.3), 3 rounds; judge produces a postmortem report with remediation items.

Internals:

- `src/presets/{types,registry,resolve-panel,build-input-schema,format}.ts`
- `src/presets/definitions/*.ts` — five preset definitions
- `Preset` interface: `id`, `toolName`, `title`, `description`, `panel`, `defaults`, `judgeSystemPrompt`, `extraInputs?`, `formatResult?`, `toolBindings?`
- Panel resolution: per-preset persona overrides applied as `taskSystemSuffix` appended to base persona prompts; never mutates the global `PERSONAS`. Fallback chains and a "used persona" guard prevent double-binding.
- Runnability: `checkRunnability` reports missing required personas; preset tool descriptions in `tools/list` flag `⚠ Currently NOT RUNNABLE` when the user's config can't satisfy the preset.
- Tests: 4 test files, ~50 cases, 6 inline snapshots locking the resolved system prompts so a careless edit can't silently drift behaviour.

### Added — installer subcommand

CLI gains an `install` subcommand that registers the server with detected MCP hosts (Claude Code, Cursor, Windsurf):

```
ai-consensus-mcp install --config /abs/path/to/consensus.config.json
```

- Atomic merge into each host's `mcpServers` map — never clobbers other top-level fields, never overwrites an existing `consensus` entry without `--force`, idempotent on re-run.
- Detection probes config-file paths and parent dirs.
- `--list-hosts`, `--hosts <ids>`, `--name <id>`, `--command <cmd>`, `--force` flags.
- Tested against `mkdtemp`-rooted fake `$HOME` directories so CI runs without touching the real home.

Backward compatibility: the bare `ai-consensus-mcp --config X` invocation still works (implicit `serve` subcommand). Existing 0.10 host configs are unaffected.

### Added — registry manifest

`server.json` at repo root, schema-keyed to `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`. Once the package is published, this manifest can be submitted to `registry.modelcontextprotocol.io` so universal installers like `npx add-mcp ai-consensus-mcp` pick it up.

### Foundations

- ESLint v10 (flat config) + typescript-eslint v8 + Prettier v3.8 — `npm run lint`, `npm run format`, `npm run check` aggregator.
- vitest upgraded 2.1.8 → 4.1.5 (clears 6 moderate audit findings via esbuild < 0.24.2; aligns with upstream `ai-consensus-core`).
- Coverage thresholds in `vitest.config.ts` with a `src/presets/**` gate set to 90/75/95/90.
- `scripts/smoke-stdio.mjs` — handshake smoke test that requires no API keys.
- CI flow: `npm install` → `npm run check` → `npm run build` → `npm run test:smoke`.

### Deferred (planned for follow-up releases)

- **Tool calling integration** (planned for the next minor): blocked on `ai-consensus-core@0.11.0` publishing. Once the upstream lands, the wrapper will gain `tools.upstreamServers` config, an `executor.ts` that drives MCP composition, and updated presets that bind tools (`code_review` → fs/read, `research_synthesis` → fetch).
- **`docs/install.html` for GitHub Pages**: the markdown doc at `docs/install.md` covers the same surface; HTML page with a Cursor deeplink button is a polish follow-up.
- **`--verify` smoke after install**: today users run `scripts/smoke-stdio.mjs` separately.
- **Config-side preset overrides** (`LoadedConfig.presets`): the `mergePresets` infrastructure is in place; hooking up a config schema waits for a concrete user request.

## [0.10.0] — 2026-04-24

- Took ownership of the seven debate personas locally after `ai-consensus-core@0.10.0` stopped shipping them.
- Bumped `ai-consensus-core` dep to `^0.10.0`.
- Renamed the unscoped npm package to `ai-consensus-core` (was `@entropyvortex/ai-consensus-core`).

(Earlier history is in git; this CHANGELOG starts at 0.10.0.)
