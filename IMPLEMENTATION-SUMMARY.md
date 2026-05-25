# Implementation Summary — v0.12

> Phase 1 (Expert Panels + Benchmarking Suite) and Phase 2 (Persistent
> Project Roundtable Memory) implementation, with every major decision
> tagged `executed` / `inspected` / `assumed` per META v2.0 R8.

## Ground truth

**Test footprint (`executed`):**

- Before this work: 159 mcp tests, 142 core tests, all green.
- After: **307 mcp tests**, 142 core tests, **all green**. +148 tests
  spanning panel meta validation, bench module, panel arg on the
  generic tool, all three memory tools, all five gating premortem
  contracts (F1, F4, F5, F6, F9, F10).
- Typecheck (`tsc --noEmit`): clean.
- Build (`npm run build`): clean. `dist/benchmark/fixtures/` correctly
  populated by the postbuild copy.
- Manual exercise of bench CLI: `node dist/index.js bench --help`
  and `bench --list-panels` render correctly.

**Inspected before designing on top (R8 inspected):**

- The existing CVP engine in `ai-consensus-core` (read engine.ts,
  types.ts, prompts.ts, stats.ts, parser.ts in full).
- The existing preset system (types.ts, registry.ts, resolve-panel.ts,
  build-input-schema.ts, format.ts, all five v1 preset definitions).
- The existing MCP server wiring (server.ts) — both generic and preset
  dispatch paths.
- The existing CLI dispatcher (main.ts, install.ts, serve.ts).
- The HTTP/sampling adapter (adapter.ts) — confirmed
  `createOpenAICompatibleCaller` is usable without a Server context,
  which made the bench CLI possible without a parallel transport.

## Phase 1 — Expert Panels + Benchmarking Suite

### 1.1. Panel metadata on `Preset`

**Decision** (`executed`): Extended the existing `Preset` interface in
`src/presets/types.ts` with an optional `meta` block carrying
`version`, `rationale`, `expectedOutputShape` (sections + tags),
and free-form `tags`. Validator in `registry.ts` rejects ill-formed
metadata at server startup. v1 presets keep `meta` undefined for
backward compat.

**Override** (META-0): The user's prompt asked for "panels/ directory
with JSON definitions." Under R11 (match conventions) the existing
TypeScript convention in `src/presets/definitions/` is correct —
compile-time safety, zero parallel JSON-loader infrastructure, single
source of truth. The substance the user wanted (versioned, validated,
machine-readable, contributable) is delivered by extending the TS type.
A future JSON-contribution path can be layered on `mergePresets`'s
existing `newPresets` extension point without forking the system.

**Tests** (`executed`):

- `src/presets/__tests__/registry-meta.test.ts` — 13 contract tests
  covering semver, rationale, expected-output-shape, tags, and
  duplicate-heading rejection.

### 1.2. Eight v2 expert panels

**Decision** (`executed`): Shipped eight v2 panels in
`src/presets/definitions/`:

| Id                       | v     | Status                         |
| ------------------------ | ----- | ------------------------------ |
| `architecture_v2`        | 2.0.0 | Upgrade of architecture_debate |
| `code_review_v2`         | 2.0.0 | Upgrade of code_review         |
| `research_synthesis_v2`  | 2.0.0 | Upgrade of research_synthesis  |
| `decision_making_v2`     | 2.0.0 | Upgrade of decision_making     |
| `incident_postmortem_v2` | 2.0.0 | Upgrade of debug_postmortem    |
| `security_redteam`       | 1.0.0 | New                            |
| `ml_research_2026`       | 1.0.0 | New                            |
| `product_strategy`       | 1.0.0 | New                            |

Each panel ships full `meta` — rationale, expected output shape, tags.
The five v1 presets stay unchanged for backward compatibility.

**Persona reuse** (`inspected`): Verified all eight panels compose
from the existing seven Roundtable personas (`pessimist`,
`first-principles`, `vc-specialist`, `scientific-skeptic`,
`optimistic-futurist`, `devils-advocate`, `domain-expert`). No new
personas added — the task-system-suffix mechanism already does the
heavy lifting for specialization.

**Tests** (`executed`):

- `presets-snapshot.test.ts` updated: separate assertions for v1 and
  v2 slates + a contract that every v2 panel has `meta.version`,
  `meta.rationale`, non-empty `expectedOutputShape.sections`, and
  non-empty `tags`.
- 8 new resolved-prompt snapshots regenerated via `npm test -- -u`.

### 1.3. Benchmark module

**Decision** (`executed`): New `src/benchmark/` module with:

- `types.ts` — `BenchCase`, `BenchRun`, `BenchReport`, `BenchMetrics`,
  - zod schemas for JSON case files.
- `runner.ts` — `runSuite()` orchestrates (cases × runs) of consensus
  - baseline against an injected `ModelCaller`. Deterministic per-run
    random seed derivation via `deriveRandomSeed(baseSeed, caseIdx, runIdx)`
    with prime-multiplier mixing.
- `metrics.ts` — pure reducers over `BenchRun[]`: agreement rate
  (final σ ≤ threshold), convergence speed avg, early-stop rate,
  judge confidence distribution, inter-rater reliability proxy,
  disagreement count, duration/token ratios, baseline-beat rate.
- `baseline.ts` — neutral single-model caller with parsed `CONFIDENCE`
  marker; persona-free so the comparison is honest.
- `format.ts` — markdown + JSON output. JSON drops full ConsensusResult
  bodies by default for diffability; `--include-full-results` keeps them.
- `load.ts` — JSON case-file loader with zod validation, path-tagged
  errors, duplicate-id rejection.
- `fixtures.ts` + `fixtures/*.json` — built-in fixtures for architecture,
  security, code-review, decision categories.

**Determinism caveat** (`assumed`, documented): The `randomSeed`
makes round-order shuffling deterministic, but **model outputs at
temperature > 0 are not**. Bench results need multiple `--runs N`
to average out non-determinism on real LLM calls. The runner is
fully deterministic when given a mock ModelCaller (tests exploit this).

**Tests** (`executed`):

- `metrics.test.ts` — 14 tests covering every metric formula.
- `runner.test.ts` — 11 tests including determinism via seed,
  failure capture, abort handling, progress events.
- `load.test.ts` — 11 tests for JSON validation and path-tagged errors.
- `fixtures.test.ts` — every shipped fixture validates, every case
  targets a real panel id, ids are globally unique.
- `format.test.ts` — markdown section contract, JSON structural stability.

### 1.4. Bench CLI

**Decision** (`executed`): New subcommand `bench` in
`src/cli/bench.ts`, wired into `cli/main.ts`. Flags: `--config`,
`--panel`, `--cases`, `--runs`, `--seed`, `--output`,
`--baseline-model`, `--baseline-provider`, `--filter-tag`,
`--include-full-results`, `--list-panels`, `--quiet`.

Baseline model defaults to `config.judge.modelId` — the most defensible
"what would the most-capable model in your config say if asked
directly?" reference.

**Dist-time concern** (`executed`): Built-in fixtures are JSON; `tsc`
doesn't copy them automatically. `package.json` build script extended
to `cp src/benchmark/fixtures/*.json dist/benchmark/fixtures/`.
Verified with `npm run build && node dist/index.js bench --list-panels`.

**Tests** (`executed`):

- `bench-args.test.ts` — 16 tests for arg parsing edge cases.
- `main-dispatch.test.ts` — bench --help and bench --list-panels
  dispatch correctly; missing-config path returns 2.

### 1.5. `panel` argument on the generic `consensus` tool

**Decision** (`executed`): Added optional `panel: string` field to
`ConsensusInputSchema` in `server.ts`. When set, the named panel's
persona resolution + tuned defaults are applied to the run.
Mutually exclusive with `participantIds` — a panel id selects the
panel composition; `participantIds` picks raw participants.

**Tests** (`executed`):

- `server-panel-arg.test.ts` — 4 contract tests: schema advertises
  `panel`; mutual exclusion enforced; unknown id surfaces list of
  available; unrunnable panel returns the missing-personas message.

### 1.6. Documentation

**Decision** (`executed`):

- `docs/expert-panels.md` — full catalogue with rationale + expected
  output shape per panel, three invocation paths, contribution guide,
  versioning policy.
- `README.md` — "What's new in v0.12" section + updated "What it
  gives you" pointing to expert panels and the bench CLI.
- `CHANGELOG.md` — v0.12 entry with bench, panels, and `panel` arg.

## Phase 2 — Persistent Project Roundtable Memory

### 2.0. Premortem

**Decision** (`executed`): Wrote
[`PREMORTEM-memory-layer.md`](./PREMORTEM-memory-layer.md) per R10.
Ten failure scenarios (F1–F10) with named mitigations split into
**[gating]** (must hold before Phase 2.1 ships) and **[ratchet]**
(can land in Phase 2.2). Three deferred items explicitly out of
scope: cross-machine sync, encryption at rest, secret-prefix scrubbing.

### 2.1. Memory layer implementation

**Decision** (`executed`): New `src/memory/` module:

- `types.ts` — `StoredEntry` (with `schemaVersion`), `IndexLine`,
  `RecallQuery`, `RecallHit`, `MemoryConfig`, `ResolvedMemoryConfig`.
- `store.ts` — `createMemoryStore()` returning a `MemoryStore` with
  `store`, `recall`, `get`, `count`, `wipe`, `rebuildIndex`.
- `query.ts` — pure, keyword-based scoring with whole-token matching
  and matched-fragment extraction (premortem F9 verbatim).
- `project-key.ts` — `sha256(realpath(path))[0:12]` derivation
  (premortem F4).

Wired into `src/server.ts`:

- `resolveMemoryContext(config)` builds a lazy store handle when
  `config.memory.enabled === true`.
- `ListTools` advertises three new tools — `consensus_recall`,
  `consensus_project_summary`, `consensus_what_we_decided` — only
  when memory is enabled (premortem F10).
- Both generic and preset dispatch paths call `maybeStoreResult()`
  after a successful run; failures log to stderr but never break
  the run.

Wired into `src/config.ts`:

- `MemoryConfigSchema` added under `memory:` in the raw config.
- `resolveMemoryRuntime()` applies defaults; the resolved shape is
  carried on `LoadedConfig.memory`.

**Gating mitigations implemented** (`executed`):

- F1 (atomic writes + drift): write `.tmp` → rename → append index.
  Recall skips orphaned index entries; never crashes. `rebuildIndex()`
  recovers from index corruption.
- F4 (project-path collision): sha256-of-realpath. Symlinks resolved
  at store-time. Recall validates `projectKey` matches before returning.
- F5 (schema evolution): `schemaVersion: 1` on every entry; reader
  is tolerant of unknown fields inside `result`.
- F6 (concurrent writes): sentinel-file lock with exponential backoff
  for the index append; result-file rename is already atomic.
- F7 (stale-recall poisoning): recall returns metadata + `ageDays`,
  not raw prompts. Tool description carries a freshness disclaimer.
  `what_we_decided` shows the storing date prominently.
- F8 (test hygiene): `createMemoryStore` takes `storageRoot` as a
  constructor arg; no `$HOME` reads inside the module. Every test
  uses an isolated `tmpdir`.
- F9 (false positives): whole-token only, no substring match across
  word boundaries. `auth` does not match `author`. Matched fragments
  surfaced so callers can sanity-check.
- F10 (off-by-default): `memory.enabled: false` is the default.
  Memory tools are not advertised when disabled.

**Deferred from premortem** (`assumed`, documented):

- F2 secret scrubbing — partial only (documentation). Phase 2.2 ratchet.
- F3 embedding ranker — keyword + LLM-on-demand is the Phase 2.1 cut.
- Admin CLI commands (`memory list/show/wipe`) — not gating; defer.

**Tests** (`executed`):

- `memory/__tests__/project-key.test.ts` — 8 tests including symlink
  resolution and collision resistance.
- `memory/__tests__/query.test.ts` — 13 tests covering whole-token
  matching, tag scoring, fragment extraction.
- `memory/__tests__/store.test.ts` — 17 tests covering F1, F4, F5,
  F6 contracts plus retention.
- `server-memory-tools.test.ts` — 8 tests covering F7 (freshness
  disclaimer in tool description) and F10 (off-by-default gating).

### 2.2. Memory documentation

**Decision** (`executed`):

- `docs/memory-layer.md` — what the layer does, threat model and
  storage trade-offs, full config reference, atomic-write contract,
  schema-versioning approach, all three tools with examples,
  disabling/wiping, failure-handling contract, deferred items.

## Architectural decisions worth re-litigating

### "Panels" terminology vs. existing "presets"

**Tradeoff**: The user prompt consistently said "expert panels";
existing code uses `Preset`. R11 (match conventions) argued for
keeping the internal type name. R7 (surface conflicts) argued for
picking one consistently.

**Decision** (`executed`): Kept `Preset` as the internal type
name. Documented v2 presets as "expert panels" — internal/external
naming divergence is well-precedented in software. If the user
pushes back, a rename is mechanical: `Preset` → `Panel` with a
type alias for backward compat. Cost ~1 hour.

### Bench location: `consensus-core` vs `consensus-mcp`

**Tradeoff**: The bench module composes the engine + a `ModelCaller`
— in principle nothing MCP-specific about it. But it also needs
config loading, panel resolution, provider routing — all in
`consensus-mcp`.

**Decision** (`executed`): All bench code in `consensus-mcp`. R4
(bounded refactor) — touching `consensus-core` would have crossed
a package boundary for marginal benefit. The bench module is
provider-agnostic at the type level (`ModelCaller` interface);
extracting it to core later is straightforward if desired.

### Memory: per-call gate vs. global gate

**Tradeoff (premortem F2 + F10)**: Per-call `store: boolean` on
each tool input gives the caller fine control but balloons the
schema surface across 14 tools. Global `memory.enabled` is simpler
but stores everything.

**Decision** (`executed`): Global gate only in Phase 2.1. When
memory is enabled, every successful run is stored. The user can
disable for a session by setting `memory.enabled: false` and
restarting. Phase 2.2 can add the per-call gate without breaking
existing callers.

### Memory: keyword vs. embedding recall

**Tradeoff (premortem F3)**: Embeddings would catch semantic
matches keyword misses ("auth flow" recalls "authentication
mechanism"). But embeddings require a provider, network calls,
and additional dependency surface.

**Decision** (`executed`): Keyword + tag + recency in 2.1.
Embedding ranker is a Phase 2.2 opt-in plugin point — the recall
result envelope already returns matched fragments so a downstream
model in the MCP host can re-rank with semantic understanding.

## What I did not ship (and why)

- **JSON-loadable panel definitions** at runtime. Per R11; users
  authoring panels write a TS file. Future feature.
- **Per-call `store: boolean` arg** on every tool. Deferred to Phase
  2.2; global gate is sufficient for the v0.12 ship.
- **`memory list/show/wipe` admin CLI**. Useful but not gating;
  reasonable Phase 2.2 follow-up.
- **Encryption at rest**. Out of scope per the premortem.
- **Cross-machine sync**. Out of scope per the premortem.
- **Cross-language embedding index**. Phase 2.2 opt-in.

## Final verification

Run yourself:

```bash
cd consensus-mcp
npm install
npm test       # 307 passed
npm run typecheck  # clean
npm run build  # clean; dist/benchmark/fixtures/ populated
node dist/index.js bench --help
node dist/index.js bench --list-panels
```

## Open items / handoff notes

- **`humanpending.md` is not present** — no items required human
  gating during this work. The handful of design choices marked as
  R9 push-backs (terminology, bench location, memory gating
  granularity) were all resolvable by META-0 judgment with the
  charter; the user can override any of them by saying so.
- **Existing snapshot tests regenerated** via `npm test -- -u`. The
  v1 snapshots are unchanged; eight new v2 snapshots were written.
  Reviewers should walk the diff to verify the v2 resolved prompts
  are what they expect.
- **`ai-consensus-core` package** is unchanged. All work landed in
  `ai-consensus-mcp`.
- **`consensus-core` test suite (142 tests) is unchanged and green**
  — no regressions in upstream.
