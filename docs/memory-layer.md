# Memory Layer

> Persistent, project-scoped roundtable memory. Optional, opt-in,
> local-first.

## What it does

When enabled, the memory layer durably stores every consensus result
(generic or panel) on local disk, scoped by project. Three new MCP
tools let MCP hosts query that store:

- `consensus_recall` — keyword + tag + recency filtering, returns
  matched fragments and the synthesis preview.
- `consensus_project_summary` — chronological list of past runs
  in the current project, without loading full bodies.
- `consensus_what_we_decided` — scoped to decision-support panels
  (`architecture_*`, `decision_*`, `product_strategy`); returns the
  judge synthesis with the storing-date prominent so callers can
  spot stale decisions.

The layer is **disabled by default** (premortem F10) — adding it
requires explicit config opt-in. See the [config](#config) section.

## Threat model and the storage trade

Before enabling, understand what is durably stored:

- The full `question` text of every consensus run (which may include
  source code, credentials, PII, business secrets — whatever the
  caller pasted in).
- The full judge synthesis and panel-response content.
- Panel id, tags, scoring metadata.

Storage:

- Default location: `~/.consensus/memory/<projectKey>/`
- File permissions: `0o600` (owner read/write only).
- **No encryption at rest.** Files are plaintext JSON.
- **No network sync.** If your home dir is on a synced volume
  (Dropbox, iCloud Drive, OneDrive), the memory dir syncs with it
  unless you exclude it explicitly.

Recommended hygiene:

- `.gitignore` your memory dir if it lives inside a repo.
- For homes on synced drives, exclude `~/.consensus/memory/` from
  the sync rules.
- Treat anything you paste into a consensus run as durably stored
  (when memory is on) and act accordingly. The layer does not
  do post-hoc scrubbing in Phase 2.1.

The full risk assessment lives in
[`PREMORTEM-memory-layer.md`](../PREMORTEM-memory-layer.md).

## Config

Add a `memory` block to your `consensus.config.json`:

```jsonc
{
  // ... providers, participants, judge ...
  "memory": {
    "enabled": true,
    // Optional: override the storage root. Defaults to ~/.consensus/memory
    // The project-key subdirectory is appended automatically.
    "storagePath": "/abs/path/to/memory-root",
    // Optional: override the project path. Defaults to the server's cwd
    // at startup. Set this when the server is a long-lived background
    // process (systemd / launchd) whose cwd isn't the actual project.
    "projectPath": "/abs/path/to/project",
    // Optional retention policy.
    "retention": {
      "maxResults": 1000,   // default 1000
      "maxAgeDays": 365     // default 365
    }
  }
}
```

When the server starts, it derives the project key by hashing the
canonical (symlinks resolved) project path. That key namespaces the
storage so two users on the same machine, both working in
`~/work/billing`, never collide (premortem F4).

## Scoping rules

Recall is **scoped to the current project by default**. The recall
tool's `acrossProjects: true` flag opts into cross-project search —
useful when you want to consult a debate you ran in a different repo.

The project key for a run is captured at store-time, so renaming
or moving a project after the fact severs the link to its history.
Run `consensus_recall acrossProjects:true query:"<topic>"` from the
new location to find the orphaned history.

## How storage works (atomic + lock-protected)

Every store operation:

1. Writes the full `StoredEntry` JSON to `results/<id>.tmp`.
2. `fs.rename(2)` to `results/<id>.json` (atomic on POSIX).
3. Acquires an exclusive sentinel lock on `index.jsonl.lock`.
4. Appends one summary line to `index.jsonl` (the slim index).
5. Releases the lock.
6. Best-effort retention pass (prunes expired / over-cap entries).

The result file is committed *before* the index entry, so a crash
between steps 2 and 4 leaves a result file with no index entry —
recoverable via `MemoryStore.rebuildIndex()`. The reverse —
index entry pointing at a missing file — never happens. Recall
gracefully skips orphans either way and never crashes (premortem F1).

## Schema versioning

Every stored entry declares `schemaVersion: 1`. The reader's zod
schema treats the `result` body as a generic record so future
fields added to `ConsensusResult` don't break v0.12 readers
(premortem F5). Migrations are explicit when needed.

## Recall scoring (Phase 2.1: keyword + metadata)

The current ranker is keyword-based:

- Whole-token, case-insensitive matching against the question
  preview. **`auth` does not match `author`** (premortem F9).
- Each query token contributes `1 / total-tokens` to the score
  when it appears in the preview; tag matches contribute half.
- Score is clamped to `[0, 1]`. Recall returns the matched fragment
  for each hit so callers can sanity-check why a result ranked.

Limitations (deliberately, per premortem):

- No fuzzy matching, no stemming, no synonym expansion.
- No embedding similarity — Phase 2.2 will layer this in as an
  opt-in feature when a user has an embedding provider
  configured, without adding dependency weight to the base package.
- No LLM-on-demand ranking yet. The shape of the recall result
  preserves the matched fragments specifically so a downstream
  model in the MCP host can re-rank with its own context.

## Tools, in detail

### `consensus_recall`

```jsonc
{
  "name": "consensus_recall",
  "arguments": {
    "query": "auth flow JWT rotation",  // optional, free-form
    "panelId": "architecture_v2",       // optional, restrict by panel
    "anyTag": ["security"],             // optional, OR-match tags
    "allTags": ["v2", "security"],      // optional, AND-match tags
    "sinceDays": 90,                    // optional, recency window
    "limit": 20,                        // default 20, max 200
    "acrossProjects": false             // default false (premortem F4)
  }
}
```

Returns markdown listing each hit with its score, ageDays, matched
fragments, and a synthesis preview. The full result body is not
loaded into the response — call `get(id)` on the store directly
(or use `consensus_project_summary` followed by a targeted lookup)
when you need the raw debate.

### `consensus_project_summary`

```jsonc
{
  "name": "consensus_project_summary",
  "arguments": {
    "panelId": "code_review_v2",   // optional
    "limit": 100                    // default 100, max 500
  }
}
```

Returns a markdown table — When / Panel / Score / Judge / Question
— sorted by recency. Use this to get oriented before recalling a
specific decision.

### `consensus_what_we_decided`

```jsonc
{
  "name": "consensus_what_we_decided",
  "arguments": {
    "topic": "database choice",   // required
    "sinceDays": 180,             // optional
    "limit": 10                   // default 10, max 50
  }
}
```

Searches across decision-support panels only — `architecture_debate`,
`architecture_v2`, `decision_making`, `decision_making_v2`,
`product_strategy`. Returns the date prominently in each result so
a caller can spot a stale decision (premortem F7).

## Disabling / wiping

To turn the layer off:

```jsonc
{
  "memory": { "enabled": false }
}
```

The memory tools immediately disappear from `ListTools`. The
storage directory is left untouched — wipe it manually if desired.

Programmatic wipe is available through the `MemoryStore.wipe()`
API for tools that integrate with the store directly.

## Failure handling

If a memory write fails (disk full, permission error, lock
contention exhausted), the consensus run **still succeeds** — the
failure is logged to stderr in the form
`ai-consensus-mcp: memory store failed (non-fatal): <message>`,
and the tool result is returned normally. The trade-off: a flaky
store can result in missed entries; never a missed consensus run.

## What's deferred to Phase 2.2+

The premortem
([`PREMORTEM-memory-layer.md`](../PREMORTEM-memory-layer.md))
documents these explicitly:

- **Optional embedding ranker** — when the user has an embedding
  provider configured, recall does a vector first-pass.
- **Cross-machine sync** — out of scope; multi-machine users
  manually sync the storage dir.
- **Encryption at rest** — out of scope; file permissions are the
  only protection today.
- **Secret-prefix scrubbing on intake** — partial mitigation
  flagged for ratchet.
- **CLI inspection commands** (`memory list`, `memory show <id>`,
  `memory wipe`) — useful but not gating; defer.

## See also

- [`PREMORTEM-memory-layer.md`](../PREMORTEM-memory-layer.md) —
  the full risk assessment with F1–F10 failure scenarios.
- [`docs/expert-panels.md`](./expert-panels.md) — the panels whose
  output the memory layer stores.
- [`src/memory/`](../src/memory) — the implementation.
