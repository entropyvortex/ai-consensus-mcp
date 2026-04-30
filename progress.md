# ai-consensus-mcp — implementation progress

**Status:** Phases 0, 1, 4 PR open. Phase 2 PR open. Phase 3 blocked. Phase 5 pending.
**Last update:** 2026-04-30
**Working branch:** `feat/presets-and-installer` (PR open against `main`)

## PRs awaiting review

- **Wrapper (this repo):** https://github.com/entropyvortex/ai-consensus-mcp/pull/1 — presets + installer + CLI subcommands
- **Upstream (ai-consensus-core):** https://github.com/entropyvortex/ai-consensus-core/pull/3 — tool-calling primitives (0.11.0)

This file tracks the multi-phase implementation of presets, tool-calling, and IDE onboarding. Updated at every meaningful step.

---

## Decisions log

- **2026-04-30** — Plan approved. Five open questions answered (Q1 ✅, Q2 ✅, Q3 ✅, Q4 ✅, Q5 ✅).
- **2026-04-30** — Premise: **no Claude Code / AI attribution** in commits, PR bodies, footers, or co-author trailers.
- **Architectural call:** Path B (upstream PR for tool primitives) chosen over Path A (wrapper-only loop).
- **Phase 0:** introduced ESLint + Prettier; vitest 2.1.8 → 4.1.5; coverage gates anchored at baseline.
- **Phase 1:** deferred config-side preset overrides; one shared `formatPresetResult` (no per-preset format files in v1); preset tools deliberately don't expose `participantIds`.
- **Phase 1.7 ratchet:** coverage thresholds raised to 55/47/57/55 globally; `src/presets/**` gated at 90/75/95/90.
- **Phase 2 sequencing:** Phase 3 is blocked on upstream merge + npm publish. Phase 4 (onboarding) doesn't depend on tool-calling, so we proceeded there in parallel and will circle back to Phase 3 once 0.11.0 ships.
- **Phase 4:** deferred `docs/install.html`, `--verify`, `--init-config`, CI installer matrix, publish-time `server.json` validation, separate troubleshooting/tools docs. The CLI installer + `docs/install.md` cover the headline use cases.
- **Wrapper version not bumped yet** — leaving `package.json.version` at `0.10.0` so the human can choose between cutting a 0.11.0 with presets+installer (and 0.12.0 once tool-calling lands) vs. one combined release.

---

## Phase 0 — Foundations ✅ COMPLETE

- [x] ESLint + Prettier (eslint v10, typescript-eslint v8, prettier v3.8)
- [x] vitest upgraded to 4.1.5 — audit clean (0 vulns)
- [x] Coverage thresholds in `vitest.config.ts`
- [x] `npm run check` aggregator: typecheck + lint + format:check + test:coverage
- [x] `scripts/smoke-stdio.mjs` — handshake smoke test (no API keys needed)
- [x] CI workflow: `npm install` → `npm run check` → `npm run build` → `npm run test:smoke`

---

## Phase 1 — Presets v1 (no upstream dep) ✅ COMPLETE

- [x] `src/presets/types.ts`, `registry.ts`, `resolve-panel.ts`, `build-input-schema.ts`, `format.ts`
- [x] Five preset definitions
- [x] 4 test files, ~50 cases, 6 inline snapshots locked
- [x] `src/server.ts` refactored: registers `consensus` + 5 preset tools, dispatches by name, runnability check + clear errors
- [x] `src/adapter.ts` refactored: takes provider map per-call (not the whole LoadedConfig)
- [x] `src/__tests__/server.test.ts` updated to cover preset listing + runnability + dispatch errors
- [x] `README.md` — Presets section
- [x] Coverage thresholds ratcheted: globals 55+, `src/presets/**` 90+
- [x] Smoke test green: 6 tools advertised end-to-end

---

## Phase 2 — Upstream PR: `ai-consensus-core@0.11.0` 🟡 PR OPEN — AWAITING MERGE

**PR:** https://github.com/entropyvortex/ai-consensus-core/pull/3
**Branch:** `feat/tool-calling`
**Diff:** 7 files changed, +960 / -25
**Tests:** 130 → 142

### Outstanding (user action)

- [ ] PR review + merge
- [ ] Tag `v0.11.0` GitHub release → triggers npm publish workflow

---

## Phase 3 — Tool-calling integration (this repo) ⏸ BLOCKED

**Blocker:** waiting on `ai-consensus-core@0.11.0` to be published to npm.

When unblocked: tool composition (`src/tools/upstream/*`), built-in tools, executor + redaction + length-cap, config schema for `tools.upstreamServers` + `tools.bindings`, progress wiring for new tool events, end-to-end test with `@modelcontextprotocol/server-filesystem`.

---

## Phase 4 — Onboarding ✅ ESSENTIALS COMPLETE

### Delivered

- [x] **CLI subcommand refactor** — `serve` (default, backward compat) + `install`
- [x] **Per-host installers** — Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`)
- [x] **Atomic merge logic** — `host-utils.mergeMcpServerEntry` (write-to-tmp, rename, never clobbers siblings, idempotent)
- [x] **Host detection** — config-path + parent-dir + extra-dirs heuristics, with fakeHome support for tests
- [x] **`server.json` manifest** at repo root (registry-ready)
- [x] **Tests with fake $HOME** — 23 new test cases across `host-utils.test.ts`, `hosts.test.ts`, `install-args.test.ts`, `main-dispatch.test.ts`
- [x] **`docs/install.md`** — long-form install reference
- [x] **README** — top-of-file "Install in 30 seconds" + universal `npx ai-consensus-mcp install`

### Verified

- `npm run check`: 120/120 tests pass; coverage 65.1% (>= 55% gate)
- `npm run test:smoke`: 6 tools advertised end-to-end
- `node dist/index.js install --list-hosts` correctly reports detection state

### Deferred (follow-ups)

- [ ] `docs/install.html` (GitHub Pages page with one-click Cursor deeplink button)
- [ ] `--verify` flag (run smoke test after registration)
- [ ] `--init-config` (bootstrap a starter `consensus.config.json`)
- [ ] CI installer matrix (validate produced JSON against host JSON schemas)
- [ ] Publish workflow: validate `server.json` against the registry schema on tag push
- [ ] `docs/{tools,troubleshooting}.md`

---

## Phase 5 — Release hardening & 1.0 (pending)

When Phase 3 lands and the wrapper is ready to cut a stable release:

- Security review (subprocess spawn surface, tool argument injection, env-var leakage)
- Perf benchmark (4-participant, 4-round debate with tools — <5% regression budget)
- Opt-in telemetry (`CONSENSUS_TELEMETRY=1`)
- CHANGELOG migration notes for 0.10 → 1.0
- Tag `v1.0.0`

---

## Current activity

- Both PRs are open and awaiting review. Pausing here — Phase 5 (release hardening) is more productive once Phase 3 lands and the wrapper has a final feature surface to harden.

---

## Recent updates

- **2026-04-30** — Phase 4 essentials complete (installer + server.json + docs)
- **2026-04-30** — Phase 2 PR opened: https://github.com/entropyvortex/ai-consensus-core/pull/3
- **2026-04-30** — Phase 1 complete (presets v1 shipped locally, smoke green)
- **2026-04-30** — Phase 0 complete

---

## Open questions / blockers

- **Phase 3 blocker:** awaiting upstream merge of https://github.com/entropyvortex/ai-consensus-core/pull/3 + GitHub release tag `v0.11.0` to trigger npm publish.
- **Wrapper version policy:** leaving `package.json.version` at `0.10.0` for now. Recommend cutting **0.11.0** with the Phase 1 + Phase 4 work (presets + installer) to get those into users' hands now, then **0.12.0** once Phase 3 lands. Open to a single combined release if you'd rather hold for the full feature set.
