# Changelog

All notable changes to `ai-consensus-mcp` will be documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **`--init-config` to bootstrap a starter config**: today users `cp consensus.config.example.json` manually.
- **Config-side preset overrides** (`LoadedConfig.presets`): the `mergePresets` infrastructure is in place; hooking up a config schema waits for a concrete user request.

## [0.10.0] — 2026-04-24

- Took ownership of the seven debate personas locally after `ai-consensus-core@0.10.0` stopped shipping them.
- Bumped `ai-consensus-core` dep to `^0.10.0`.
- Renamed the unscoped npm package to `ai-consensus-core` (was `@entropyvortex/ai-consensus-core`).

(Earlier history is in git; this CHANGELOG starts at 0.10.0.)
