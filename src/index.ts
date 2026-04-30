#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// ai-consensus-mcp — CLI entry point
// ─────────────────────────────────────────────────────────────
// Thin shell that hands off to the subcommand dispatcher. Subcommands:
//   serve        start the stdio MCP server (default)
//   install      register the server with installed MCP hosts
//
// Backward compat: invocations without a subcommand
// (`ai-consensus-mcp --config X` or `CONSENSUS_CONFIG=... ai-consensus-mcp`)
// implicitly route to `serve`.
//
// IMPORTANT: nothing goes to stdout except the MCP JSON-RPC stream.
// All logs and errors go to stderr.

import { runMain } from "./cli/main.js";

runMain(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ai-consensus-mcp: fatal: ${msg}\n`);
    process.exit(1);
  });
