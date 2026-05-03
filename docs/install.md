# Installing `ai-consensus-mcp`

Long-form reference for getting the server registered with each MCP host.
The README's "Install in 30 seconds" handles the common path; this doc
covers the edge cases.

## Prerequisites

- Node.js ≥ 20 (the npm package targets `engines.node: >=20`).
- An OpenAI-compatible API key from at least one provider you care about
  (xAI Grok, Anthropic, OpenAI, Groq, …). The server itself doesn't ship
  any API keys; configs reference env-var names that the operator sets.
- A `consensus.config.json` file. Start from
  [`consensus.config.example.json`](../consensus.config.example.json) and
  edit it for your provider/model/persona panel.

## The CLI installer

```bash
npx -y ai-consensus-mcp install --config /abs/path/to/consensus.config.json
```

What it does:

- Detects which MCP hosts are installed by probing their config-file paths.
- Merges a `consensus` server entry into each detected host's `mcpServers`
  map. Writes are atomic — the file is written to a `.tmp-<pid>-<ts>`
  sibling and then renamed, so a crash mid-write never corrupts the host
  config.
- Refuses to overwrite an existing entry named `consensus` that points
  somewhere else. Pass `--force` to clobber.

### Useful flags

| Flag              | Purpose                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--config <path>` | Path to your `consensus.config.json` (required).                                                                                                                   |
| `--hosts <ids>`   | Comma-separated list (`claude-code,cursor,windsurf`). Defaults to every detected host.                                                                             |
| `--name <id>`     | Server name written under `mcpServers`. Defaults to `consensus`.                                                                                                   |
| `--command <cmd>` | Override the registered command. Default is `npx -y ai-consensus-mcp` for portability; set to `ai-consensus-mcp` for lower startup latency if you have it on PATH. |
| `--force`         | Overwrite an existing entry that points elsewhere.                                                                                                                 |
| `--list-hosts`    | Print which hosts are detected and exit (no writes).                                                                                                               |
| `--help`          | Show the full help.                                                                                                                                                |

### Detection

The installer marks a host as "detected" if either:

- Its config file exists (e.g. `~/.cursor/mcp.json`), **or**
- Its parent directory exists (e.g. `~/.cursor/`) — fresh installs of
  Cursor and Windsurf create the directory before the user has ever
  opened the MCP settings panel.

Claude Code's config (`~/.claude.json`) lives directly under `$HOME`, so
the parent-dir heuristic doesn't apply; instead, the installer also
checks for `~/.claude/` as an "installed" signal.

If detection misses your host (rare), pass `--hosts <id>` explicitly.

## Per-host references

### Claude Code (CLI)

The installer writes to `~/.claude.json` under `mcpServers.consensus`. If
you prefer the official CLI:

```bash
claude mcp add consensus \
  --scope user \
  --transport stdio \
  -- npx -y ai-consensus-mcp serve --config /abs/path/to/consensus.config.json
```

You'll also want to set the relevant `*_API_KEY` env vars; either pass
`--env GROK_API_KEY=…` (repeatable) on the CLI or set them in your
shell profile.

### Cursor

The installer writes to `~/.cursor/mcp.json` (cross-platform). Restart
Cursor after install — the agent picks up the new server on the next
session.

For a one-click install link (e.g. on a docs page), Cursor accepts a
deeplink of the form:

```
cursor://anysphere.cursor-deeplink/mcp/install?name=consensus&config=<base64>
```

where `<base64>` is `JSON.stringify(...)`-then-`base64` of an entry like:

```json
{
  "command": "npx",
  "args": [
    "-y",
    "ai-consensus-mcp",
    "serve",
    "--config",
    "/REPLACE/WITH/ABSOLUTE/PATH/TO/consensus.config.json"
  ]
}
```

The deeplink prompts for confirmation before installing; it's
appropriate for blog/landing pages but not for scripted workflows
(use the CLI installer for those).

### Windsurf

The installer writes to `~/.codeium/windsurf/mcp_config.json`. Restart
Windsurf to pick up the new server. Windsurf has a hard cap of 100
total MCP tools across all servers — if you're running many MCP servers
already, the consensus + 5 presets (6 tools total) shouldn't push you
near the limit, but worth knowing.

## Universal MCP installer

If you're using a host the v0.11 installer doesn't ship with:

```bash
npx add-mcp ai-consensus-mcp
```

Auto-detects ~14 hosts (Codex, Cline, Gemini CLI, Goose, Zed, etc.)
and registers via the appropriate config. This works for any host that
indexes the official MCP registry.

## Manual install (fallback)

For any stdio-capable host: register a server with this entry shape
(adapting the config-file path to your host's schema):

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "ai-consensus-mcp", "serve", "--config", "/abs/path/to/consensus.config.json"],
  "env": {
    "GROK_API_KEY": "xai-...",
    "CONSENSUS_ANTHROPIC_API_KEY": "sk-ant-..."
  }
}
```

## Verifying

After registering, restart your host. You should see `consensus`,
`consensus_code_review`, `consensus_architecture_debate`,
`consensus_research_synthesis`, `consensus_decision_making`, and
`consensus_debug_postmortem` show up as available tools.

Quick smoke check from a terminal (no host required):

```bash
git clone https://github.com/entropyvortex/ai-consensus-mcp.git
cd ai-consensus-mcp
npm install && npm run build
node scripts/smoke-stdio.mjs
# → smoke ok — server=ai-consensus-mcp@…, tools=[consensus, consensus_code_review, …]
```

## Uninstalling

The installer doesn't ship an `uninstall` subcommand yet — for now,
hand-edit your host's config (the same file the installer wrote to)
and remove the `mcpServers.consensus` entry.
