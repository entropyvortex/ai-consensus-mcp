# Premortem — Persistent Project Roundtable Memory

**Status:** Required by META v2.0 R10 (Reversibility-Weighted Verification)
before implementation begins. This document imagines the memory layer
already exists, has shipped, and has failed — then works backward to the
specific failure mode, the cause, and the design mitigation that would
have prevented it. Mitigations marked **[gating]** must hold before Phase 2.1
ships; **[ratchet]** mitigations are improvements we'll layer in later.

## Why this is high blast-radius

Unlike the rest of `ai-consensus-mcp`, which is stateless, the memory
layer:

- **Holds long-lived data on disk.** Corruption, unintended retention,
  and migration breakage are durable failure modes.
- **Touches user privacy.** A `ConsensusResult` contains the question
  the user asked plus the panel's reasoning. Questions can contain
  source code, credentials, PII, business secrets. Storing them
  unencrypted on disk is a deliberate trade — surfaced explicitly here.
- **Cross-cuts the protocol.** Recall surfaces past results into new
  consensus runs. A bad recall poisons the next decision.
- **Crosses project boundaries.** A naïve implementation will mix
  results from `/repos/billing` with `/repos/cms` because the working
  directory changes between sessions.

Reversibility cost: recovering from a corrupt or poisoned memory store
requires either manual JSON repair or a full wipe. Wiping forfeits
months of accumulated context.

## Failure scenarios

### F1. The store silently corrupts the index, recall returns garbage

**Imagined outcome:** Six months in, `consensus_recall` returns results
from the wrong panel for the wrong question. The user has been
quietly making decisions informed by mismatched context.

**Root cause hypothesis:** The index (`index.jsonl`) and result files
(`results/<id>.json`) drifted because the index was updated before
the result file was fully written, then the process was killed mid-
operation. Subsequent recalls hit the index but find missing or
mismatched files.

**Mitigation [gating]:**

1. Write the result file to a `<id>.tmp` sibling, then `fs.rename(2)`
   into place atomically.
2. Append to the index only **after** the result file rename returns.
3. On every recall, validate that each indexed id has a corresponding
   readable file. If not, skip the entry and log a one-line warning;
   never crash.
4. Provide a `consensus_memory_repair` admin function (not an MCP tool;
   CLI only) that rebuilds the index by scanning `results/`.

### F2. A run with embedded secrets is stored unencrypted

**Imagined outcome:** A user pastes a private key into a debate
("here's the token we use, why is it leaking"). The full key is
durably stored on disk; later it shows up in a `consensus_recall`
answer surfaced to a colleague who pair-codes via Claude Desktop with
a different account.

**Root cause hypothesis:** No secret-scanning on intake; no scoping
of recall results to the storing identity.

**Mitigation [gating]:**

1. **Memory is off by default.** Opt-in via explicit config flag
   `memory.enabled: true` _and_ a per-call `consensus_store: true`
   flag on the consensus tool. No silent retention.
2. **Project-scope by default.** Recall is filtered to the current
   project (resolved from `cwd`). Cross-project recall is a separate,
   explicit operation.
3. **Storage path is user-owned.** Default
   `~/.consensus/memory/<sha256(projectAbsPath)[0:12]>/` — under the
   user's home dir, file permissions `0o600`, no network sync.
4. **Document the threat model explicitly.** `docs/memory-layer.md`
   names what is durably stored and recommends the user `.gitignore`
   the storage dir if their home is in a synced location (Dropbox,
   iCloud Drive). No surprises.

**Mitigation [ratchet]:**

5. Add an `--exclude-patterns` config that runs cheap regex-based
   scrubbing on the `question` before storing (well-known token
   prefixes: `sk-`, `xoxb-`, `ghp_`, AWS access key shape, etc.).
   Imperfect; explicitly not a security boundary.

### F3. Recall queries are slow at scale (10k+ results)

**Imagined outcome:** After a year of use, `consensus_recall "what
did we decide about auth"` takes 4 seconds. The user disables memory.

**Root cause hypothesis:** Naïve full-scan of result JSON files for
every recall, no index over question text, no cap on stored results.

**Mitigation [gating]:**

1. **Two-tier index.** `index.jsonl` (one line per result, ~200
   bytes) carries summary fields — id, storedAt, panelId, question,
   tags. Recall scans the index, not the full results, for the
   first-pass filter.
2. **Cap by default.** `memory.retention.maxResults: 1000` and
   `memory.retention.maxAgeDays: 365`. Older entries pruned on the
   next store. User-configurable; the CLI tool surfaces what's
   about to be pruned before doing it.
3. **Lazy result loading.** Only load full `ConsensusResult` JSON
   for entries the first-pass filter returned.

**Mitigation [ratchet]:**

4. Optional embedding index (Phase 2.2+) — when the user has an
   embedding provider configured, store a vector per question and
   use cosine similarity in the first pass. Off by default; needs
   explicit opt-in to avoid the dependency.

### F4. Project-path collisions mix tenants

**Imagined outcome:** Two users on the same machine working in
`~/work/project-a` and `~/work/project-a` (different home dirs but
same suffix) get each other's results.

**Root cause hypothesis:** Project key was derived from `basename(cwd)`,
not the absolute canonical path.

**Mitigation [gating]:**

1. Project key = `sha256(realpath(cwd))[0:12]`. The full absolute
   resolved path goes into the key derivation. Users with different
   home dirs cannot collide.
2. Store the canonical project path in each result's metadata, not
   just the key. Recall validates the stored path equals the current
   realpath before returning — defense in depth.
3. Symlinks resolved at store-time, not at recall-time, so the key
   is stable across symlink topology changes.

### F5. `ConsensusResult` shape evolves and old data becomes unreadable

**Imagined outcome:** v0.13 adds a new field to `RoundResult`. Stored
results from v0.12 fail to deserialize. The user's accumulated
history is silently lost.

**Root cause hypothesis:** No schema version on stored entries; no
forward-compat reader.

**Mitigation [gating]:**

1. **Versioned storage envelope.** Every stored entry wraps the
   `ConsensusResult` in a `StoredEntry` shape with `schemaVersion: 1`.
2. **Reader tolerates unknown fields.** Use zod's `.passthrough()`
   instead of `.strict()` on stored shapes — adding fields is
   non-breaking.
3. **Migrations are explicit.** A `migrateStoredEntry(entry, fromVersion)`
   function exists and is exercised in tests. Refusing to migrate is a
   user-visible warning, not a silent drop.

### F6. Concurrent writes from two MCP server instances corrupt the index

**Imagined outcome:** User runs Claude Code in two windows on the
same project; both servers append to `index.jsonl` simultaneously;
one line ends up half-written.

**Root cause hypothesis:** Append-only file with no locking; assumed
single-writer.

**Mitigation [gating]:**

1. **Advisory lock on writes.** Acquire an exclusive `flock` on
   `index.jsonl.lock` for the brief window of the append. Use a
   POSIX file lock (`proper-lockfile` or stdlib equivalent — needs
   research; if it adds dependency weight, prefer stdlib `open()`
   with `O_EXLOCK` where available, otherwise a sentinel file).
2. **Each append writes a complete line atomically.** The kernel
   guarantees writes ≤ PIPE_BUF (typically 4 KiB on Linux, 512 on
   POSIX minimum) are atomic. Index lines are designed to be small
   enough that the atomicity guarantee holds even without the lock —
   but we still take the lock for the corner-cases.

**Mitigation [ratchet]:**

3. **Self-healing reader.** When parsing `index.jsonl`, a malformed
   line is logged and skipped rather than aborting the recall.

### F7. Recall poisons a new run by re-injecting stale context

**Imagined outcome:** The user changed their architecture decision
in March. In May, `consensus_recall` surfaces the March decision
into a new debate, and the panel anchors on it. Stale guidance
quietly propagates.

**Root cause hypothesis:** Recall returns raw content without
freshness signal; new debate's prompt template doesn't communicate
that the recalled material is historical context, not current truth.

**Mitigation [gating]:**

1. **Recall returns metadata, not raw context.** The MCP tool
   surfaces a structured list — `{ id, storedAt, panelId, question,
summary, finalScore }` — and the _caller_ (the model in the
   MCP host) decides whether to use it. Recall does not inject
   into prompts automatically.
2. **Every recalled item is tagged with age.** "Stored 76 days ago,"
   not just a timestamp — surfaces relative recency at a glance.
3. **`consensus_what_we_decided` returns the decision + the date
   of the decision + the conditions named as tripwires** (which v2
   panels emit). A caller using this tool sees both the conclusion
   and the conditions that would invalidate it.

### F8. The memory layer becomes a hidden coupling that breaks tests

**Imagined outcome:** Test suites that exercise the consensus engine
start reading from `~/.consensus/memory/` and pulling in real prior
runs. CI is non-deterministic.

**Root cause hypothesis:** Memory module reads from a globally-
configured path with no override hook for tests.

**Mitigation [gating]:**

1. **Memory module takes the storage root as a constructor argument.**
   No reads from `$HOME` inside the module — the CLI / server is
   responsible for resolving the path and passing it in.
2. **Tests get a per-test `tmpdir`-based root.** Vitest helper:
   `withTempMemoryRoot(callback)`.
3. **No global singletons.** Each `createMemoryStore(args)` call
   produces an independent store; calling it in tests with `/tmp/X`
   never touches the user's real memory.

### F9. The recall tool returns false positives that look authoritative

**Imagined outcome:** A keyword-based recall matches "auth" in
"author" and surfaces an unrelated debate about authoring tooling
as if it were an authentication decision.

**Root cause hypothesis:** Naïve substring or stemming with no
explainability — recall returns matches without showing why.

**Mitigation [gating]:**

1. **Recall shows the matched fragment.** The result envelope
   includes the snippet of the stored question/answer that matched,
   so the caller can sanity-check the relevance.
2. **Score every match.** Even with a simple keyword index, return
   a score; let the caller filter low-score matches.
3. **No fuzzy matching across word boundaries by default.** Match
   whole tokens. Add a `--fuzzy` flag for explicit opt-in later.

### F10. Memory-layer becomes load-bearing for first-time users with no data

**Imagined outcome:** A new user installs v0.12.5, runs a panel,
and gets a recall response that's empty/confusing. They think the
panel is broken.

**Root cause hypothesis:** Recall is exposed as a tool by default,
new users see it in autocomplete but it has nothing to return.

**Mitigation [gating]:**

1. **`memory.enabled: true` is required** in config for any
   memory tool (`consensus_recall`, `consensus_project_summary`,
   `consensus_what_we_decided`) to appear in `ListTools`. Off by
   default.
2. **Tool descriptions are honest.** When enabled but empty, the
   tool description says "no stored results yet — runs are stored
   when invoked with `consensus_store: true`."

## Out-of-scope (deliberately)

The following risks are **not** mitigated in Phase 2.1 and are
documented here so reviewers know they were considered:

- **Cross-machine sync.** Users with multiple machines won't share
  memory unless they sync their `~/.consensus/memory/` themselves.
  Adding sync introduces conflict-resolution, encryption-in-transit,
  and identity questions that are a separate project. Defer.
- **True semantic search via embeddings.** Adding an embedding
  provider crosses the dependency-light line. Phase 2.2 can layer
  it in as an opt-in feature when a user has a provider configured;
  Phase 2.1 ships keyword + metadata + LLM-on-demand ranking.
- **Encryption at rest.** Files are `chmod 0600` and live under the
  user's home dir. Adding cipher (with key management — passphrase
  prompts, key files, OS keychains) is a major surface. Out of
  scope; documented as a known limitation.
- **Audit log of who read what.** Single-user assumption. A
  multi-user scenario would need it; today the calling MCP host is
  the same identity as the storing process.

## Pre-implementation checklist

Before any code lands in Phase 2.1:

- [x] This premortem document exists and was reviewed against the
      charter (R10 satisfied).
- [ ] Storage envelope shape locked: `{ schemaVersion, id, storedAt,
projectKey, projectPath, panelId, question, tags, result }`.
- [ ] CLI command added for inspection (`ai-consensus-mcp memory list`
      / `memory show <id>` / `memory wipe` — _admin-only_, never an MCP tool).
- [ ] `memory.enabled: false` is the default in the config schema.
- [ ] Recall tool description includes the freshness disclaimer.
- [ ] Test plan covers F1–F10 contracts (each failure-mode has
      at least one named test).

Mitigations marked [gating] above are the acceptance criteria for
Phase 2.1; [ratchet] items can land in Phase 2.2 or later without
blocking the initial ship.

## Verdict

The memory layer is shippable in Phase 2.1 with the gating
mitigations in place. The dominant residual risk is
**unencrypted storage of potentially-sensitive prompts**, mitigated
by opt-in defaults and explicit documentation. The dominant
deferred risk is **recall ranking quality** — keyword + LLM-on-
demand is a known-imperfect first cut, but it ships value
immediately and the embedding upgrade path is open.

If the gating mitigations slip — particularly atomic writes (F1)
and opt-in defaults (F2, F10) — the layer is **not** ready.
