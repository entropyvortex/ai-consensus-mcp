// ─────────────────────────────────────────────────────────────
// CLI top-level dispatcher
// ─────────────────────────────────────────────────────────────
// Subcommands:
//   serve              start the stdio MCP server (default if no
//                      subcommand is supplied — preserves the 0.10
//                      `ai-consensus-mcp --config X` invocation)
//   install            register the server with installed MCP hosts
//                      (Claude Code, Cursor, Windsurf)
//   config / configure interactive TUI for editing the JSON config
//
// Top-level flags:
//   --help / -h        per-subcommand help (or top-level help when no
//                      subcommand is given)
//   --version / -v     print version and exit
//
// Backward compatibility: invocations like
//   ai-consensus-mcp --config /abs/consensus.config.json
//   CONSENSUS_CONFIG=/abs/path ai-consensus-mcp
// behave identically to 0.10 — they implicitly route to `serve`.

import { runServe } from "./serve.js";
import { runInstall } from "./install.js";
import { runConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

const TOP_LEVEL_HELP = `
${SERVER_NAME} v${SERVER_VERSION}

Usage:
  ai-consensus-mcp [serve] --config <path>     Start the MCP server (stdio)
  ai-consensus-mcp install [options]           Register with installed MCP hosts
  ai-consensus-mcp config [--config <path>]    Interactive editor for the JSON config
  ai-consensus-mcp --help                      Show this help
  ai-consensus-mcp --version                   Print version and exit

Run \`ai-consensus-mcp <command> --help\` for command-specific options.

Environment:
  CONSENSUS_CONFIG       Default config path for \`serve\` if --config is omitted.
  <PROVIDER_API_KEY>     Each provider in the config declares an \`apiKeyEnv\`;
                         that env var must be set when serving.
`;

export async function runMain(argv: readonly string[]): Promise<number> {
  // Top-level flags that should win regardless of subcommand position.
  if (argv.length === 0) {
    process.stderr.write(`${TOP_LEVEL_HELP}\n`);
    return 2;
  }

  const first = argv[0];

  if (first === "--version" || first === "-v") {
    process.stderr.write(`${SERVER_VERSION}\n`);
    return 0;
  }

  if (first === "--help" || first === "-h") {
    process.stderr.write(`${TOP_LEVEL_HELP}\n`);
    return 0;
  }

  if (first === "serve") {
    return runServe(argv.slice(1));
  }

  if (first === "install") {
    return runInstall(argv.slice(1));
  }

  if (first === "config" || first === "configure") {
    return runConfig(argv.slice(1));
  }

  // Backward-compatible default: anything that starts with a flag
  // (e.g. `--config X`) implicitly means `serve`.
  if (first?.startsWith("-")) {
    return runServe(argv);
  }

  process.stderr.write(`${SERVER_NAME}: unknown command "${first ?? ""}"\n${TOP_LEVEL_HELP}\n`);
  return 2;
}
