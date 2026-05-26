# Migrating from v0.11 to v0.12

> Zero-breaking-change upgrade. Existing configs work unchanged. New
> features are strictly additive and opt-in where they introduce
> durable state.

## What changed

| Surface                                      | v0.11                                             | v0.12                                                                                                                               | Action                                                                                         |
| -------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| MCP tools advertised                         | 6 (generic + 5 v1 presets)                        | 14 (generic + 5 v1 + 8 v2 expert panels). +3 memory tools when `memory.enabled: true`.                                              | None. Hosts pick up new tools automatically on restart.                                        |
| Generic `consensus` tool                     | `prompt`, `participantIds`, engine knobs.         | All v0.11 args still accepted, **plus** a new optional `panel: string` field. Mutually exclusive with `participantIds`.             | Optional. Add `panel: "architecture_v2"` (etc.) to apply a curated panel via the generic tool. |
| v1 preset tools (`consensus_code_review`, …) | 5 preset tools with their own input schemas.      | Unchanged — same panel, same defaults, same judge prompts, same input shape.                                                        | None.                                                                                          |
| Config schema (`consensus.config.json`)      | `providers`, `participants`, `judge`, `defaults`. | All v0.11 fields still accepted. New optional `memory:` block; absent or `{ "enabled": false }` reproduces v0.11 behaviour exactly. | Optional. Add `memory.enabled: true` to unlock the persistent memory layer.                    |
| CLI subcommands                              | `serve`, `install`, `config`.                     | All v0.11 subcommands unchanged. New `bench` subcommand for measuring panel uplift over a single-model baseline.                    | Optional. `ai-consensus-mcp bench --help` to explore.                                          |
| `installer`'s post-install message           | "should appear with 6 tools."                     | Updated to describe the 14-tool inventory + the conditional memory tools.                                                           | None.                                                                                          |

## Step-by-step upgrade

### 1. Install v0.12

```bash
npm install -g ai-consensus-mcp@0.12.0
```

Or, if your config is pinned by an MCP host pointing at `npx -y ai-consensus-mcp`, the host picks up `0.12.0` on next launch automatically — no action needed.

### 2. Verify it picked up

```bash
ai-consensus-mcp --version
# → 0.12.0

ai-consensus-mcp bench --list-panels
# → 13 panels listed (5 v1 + 8 v2)
```

### 3. (Optional) Try a panel from the host

In Claude Code / Cursor / Windsurf, the new panels appear in tool autocomplete:

```jsonc
{
  "name": "consensus_architecture_v2",
  "arguments": {
    "prompt": "Should we adopt microservices for a 5-person team?",
  },
}
```

Or use the generic tool with the `panel` argument:

```jsonc
{
  "name": "consensus",
  "arguments": {
    "prompt": "Threat-model this webhook endpoint.",
    "panel": "security_redteam",
  },
}
```

### 4. (Optional) Try the bench CLI

The cheapest sanity check:

```bash
ai-consensus-mcp bench --config ./consensus.config.json \
    --panel architecture_v2 --quick
```

For a real uplift measurement with averaging:

```bash
ai-consensus-mcp bench --config ./consensus.config.json \
    --panel code_review_v2 --runs 3 --seed 42 --output report.json
```

See [`docs/expert-panels.md`](./expert-panels.md) for per-panel guidance.

### 5. (Optional) Enable the memory layer

Edit your `consensus.config.json`:

```jsonc
{
  // ... existing fields untouched ...
  "memory": {
    "enabled": true,
    // All other memory fields are optional; defaults shown in docs/memory-layer.md
  },
}
```

After restarting the MCP host, three new tools appear:

- `consensus_recall` — keyword + tag + recency search.
- `consensus_project_memory` — chronological list of past runs in this project.
- `consensus_what_we_decided` — focused recall scoped to decision-support panels.

**Important:** the layer writes plaintext JSON to `~/.consensus/memory/<projectKey>/`. Read [`docs/memory-layer.md`](./memory-layer.md#threat-model-and-the-storage-trade) before enabling — questions you've sent to the panel will be durably stored.

## What you do **not** need to change

- Provider blocks (xAI, Anthropic, OpenAI, etc.) — schema unchanged.
- Participant blocks — schema unchanged. `kind: "host-sample"` participants still work where the host advertises the `sampling` capability (Claude Desktop today).
- Judge config — schema unchanged.
- Existing v1 preset invocations — same input shape, same output shape.
- CI / scripts that call `ai-consensus-mcp serve --config <path>` — same flag, same behaviour.
- The persona registry — same 7 personas. v2 panels reuse them with task-specific suffixes; no new personas added.

## Rollback

If you need to roll back to v0.11.0:

```bash
npm install -g ai-consensus-mcp@0.11.0
```

The memory layer's on-disk format is forward-compatible (entries carry `schemaVersion: 1`), so reverting the package doesn't corrupt or strand stored entries. Re-upgrading to v0.12 picks up the existing memory store seamlessly.

## See also

- [`docs/expert-panels.md`](./expert-panels.md) — full v2 panel catalogue + contribution guide.
- [`docs/memory-layer.md`](./memory-layer.md) — what the memory layer does, threat model, config reference.
- [`CHANGELOG.md`](../CHANGELOG.md) — the per-version log, including the polish-pass notes for v0.12.0.
