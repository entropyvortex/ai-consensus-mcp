// ─────────────────────────────────────────────────────────────
// `serve` subcommand — starts the stdio MCP server
// ─────────────────────────────────────────────────────────────
// Extracted from the 0.10 entry point. Behaviour is identical:
// loads a JSON config, exposes the `consensus` tool plus preset
// tools, forwards engine events as MCP progress notifications.
//
// IMPORTANT: nothing goes to stdout except the MCP JSON-RPC stream.
// All logs and errors go to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { createMcpServer } from "../server.js";
import { SERVER_NAME } from "../version.js";

interface ServeArgs {
  configPath: string | undefined;
  help: boolean;
}

const SERVE_HELP = `
${SERVER_NAME} serve — start the MCP server over stdio

Usage:
  ai-consensus-mcp serve --config <path>
  CONSENSUS_CONFIG=<path> ai-consensus-mcp serve
  ai-consensus-mcp --config <path>             # subcommand inferred

Flags:
  -c, --config <path>    Path to a JSON config file describing providers,
                         participants, and (optionally) a judge.
  -h, --help             Show this help.

Environment:
  CONSENSUS_CONFIG       Fallback config path if --config is omitted.
  <PROVIDER_API_KEY>     Each provider in the config declares an \`apiKeyEnv\`;
                         that env var must be set.

The server speaks JSON-RPC over stdio. Once initialised, a one-line
ready message is written to stderr; stdout is reserved for the MCP
protocol stream.
`;

function parseServeArgs(argv: readonly string[]): ServeArgs | Error {
  const out: ServeArgs = { configPath: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
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

export async function runServe(argv: readonly string[]): Promise<number> {
  const parsed = parseServeArgs(argv);
  if (parsed instanceof Error) {
    process.stderr.write(`${SERVER_NAME}: ${parsed.message}\n${SERVE_HELP}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stderr.write(`${SERVE_HELP}\n`);
    return 0;
  }

  const configPath = parsed.configPath ?? process.env["CONSENSUS_CONFIG"];
  if (!configPath) {
    process.stderr.write(
      `${SERVER_NAME}: a config path is required (--config <path> or CONSENSUS_CONFIG env).\n${SERVE_HELP}\n`,
    );
    return 2;
  }

  const config = await loadConfig(configPath);

  const summary =
    `${SERVER_NAME} ready — ${config.participants.length} participant(s) from ${
      Object.keys(config.providers).length
    } provider(s)` +
    (config.judge ? `, judge=${config.judge.modelId}` : ", no judge") +
    ` (config: ${config.sourcePath})`;
  process.stderr.write(`${summary}\n`);

  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return new Promise<number>((resolve) => {
    const shutdown = (reason: string) => {
      process.stderr.write(`${SERVER_NAME}: shutting down (${reason})\n`);
      server
        .close()
        .catch(() => undefined)
        .finally(() => resolve(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}
