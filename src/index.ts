#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// ai-consensus-mcp — CLI entry point
// ─────────────────────────────────────────────────────────────
// Stdio MCP server. Loads a JSON config, exposes one `consensus`
// tool, forwards engine events as MCP progress notifications.
//
// IMPORTANT: nothing goes to stdout except the MCP JSON-RPC
// stream. All logs and errors go to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

interface CliArgs {
  configPath: string | undefined;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs | Error {
  const out: CliArgs = { configPath: undefined, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--version" || arg === "-v") {
      out.version = true;
    } else if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (!next) return new Error(`Missing value for ${arg}`);
      out.configPath = next;
      i++;
    } else if (arg.startsWith("--config=")) {
      out.configPath = arg.slice("--config=".length);
    } else {
      return new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

const HELP_TEXT = `
${SERVER_NAME} v${SERVER_VERSION}

Usage:
  ai-consensus-mcp --config <path>
  CONSENSUS_CONFIG=<path> ai-consensus-mcp

Flags:
  -c, --config <path>   Path to a JSON config file describing providers,
                        participants, and (optionally) a judge.
  -v, --version         Print version and exit.
  -h, --help            Show this help and exit.

Environment:
  CONSENSUS_CONFIG      Fallback config path if --config is omitted.
  <PROVIDER_API_KEY>    Each provider in the config declares an
                        \`apiKeyEnv\`; that env var must be set.

See packages/ai-consensus-mcp/README.md for host integration examples
(Claude Desktop, Claude Code, etc.) and consensus.config.example.json
for a complete config template.
`;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed instanceof Error) {
    process.stderr.write(`ai-consensus-mcp: ${parsed.message}\n${HELP_TEXT}\n`);
    process.exit(2);
  }
  if (parsed.help) {
    process.stderr.write(`${HELP_TEXT}\n`);
    process.exit(0);
  }
  if (parsed.version) {
    process.stderr.write(`${SERVER_VERSION}\n`);
    process.exit(0);
  }

  const configPath = parsed.configPath ?? process.env["CONSENSUS_CONFIG"];
  if (!configPath) {
    process.stderr.write(
      `ai-consensus-mcp: a config path is required (--config <path> or CONSENSUS_CONFIG env).\n${HELP_TEXT}\n`,
    );
    process.exit(2);
  }

  const config = await loadConfig(configPath);

  const summary =
    `ai-consensus-mcp ready — ${config.participants.length} participant(s) from ${Object.keys(config.providers).length} provider(s)` +
    (config.judge ? `, judge=${config.judge.modelId}` : ", no judge") +
    ` (config: ${config.sourcePath})`;
  process.stderr.write(`${summary}\n`);

  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (reason: string) => {
    process.stderr.write(`ai-consensus-mcp: shutting down (${reason})\n`);
    server
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ai-consensus-mcp: fatal: ${msg}\n`);
  process.exit(1);
});
