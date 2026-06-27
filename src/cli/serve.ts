// ─────────────────────────────────────────────────────────────
// `serve` subcommand — starts the MCP server (stdio or HTTP)
// ─────────────────────────────────────────────────────────────
// Extracted from the 0.10 entry point. Stdio behaviour is identical:
// loads a JSON config, exposes the `consensus` tool plus preset
// tools, forwards engine events as MCP progress notifications.
//
// IMPORTANT (stdio): nothing goes to stdout except the MCP JSON-RPC
// stream. All logs and errors go to stderr.
//
// HTTP mode (`--http`): stateless Streamable HTTP for remote MCP
// clients (Grok custom connectors, etc.). See docs and examples/.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { startNodeHttpServer } from "../http/node-server.js";
import { createMcpServer } from "../server.js";
import { SERVER_NAME } from "../version.js";

interface ServeArgs {
  configPath: string | undefined;
  help: boolean;
  http: boolean;
  host: string;
  port: number;
  path: string;
}

const SERVE_HELP = `
${SERVER_NAME} serve — start the MCP server

Usage (stdio — default):
  ai-consensus-mcp serve --config <path>
  CONSENSUS_CONFIG=<path> ai-consensus-mcp serve
  ai-consensus-mcp --config <path>             # subcommand inferred

Usage (remote Streamable HTTP):
  ai-consensus-mcp serve --http --config <path>
  ai-consensus-mcp serve --http --config <path> --port 3000 --host 0.0.0.0
  CONSENSUS_HTTP=1 ai-consensus-mcp serve --config <path>

Flags:
  -c, --config <path>    Path to a JSON config file describing providers,
                         participants, and (optionally) a judge.
      --http             Serve over stateless Streamable HTTP instead of stdio.
      --host <addr>      Bind address for HTTP mode (default: 127.0.0.1).
      --port <n>         Listen port for HTTP mode (default: 3000).
      --path <path>      MCP endpoint path for HTTP mode (default: /mcp).
  -h, --help             Show this help.

Environment:
  CONSENSUS_CONFIG       Fallback config path if --config is omitted.
  CONSENSUS_HTTP         If set to 1/true, enables HTTP mode (same as --http).
  CONSENSUS_HTTP_API_KEY REQUIRED for public HTTP deploys. Clients must send
                         Authorization: Bearer <key> or X-Consensus-Api-Key.
                         When unset, the endpoint is open (local dev only).
  <PROVIDER_API_KEY>     Each provider in the config declares an \`apiKeyEnv\`;
                         that env var must be set.

Stdio mode speaks JSON-RPC over stdout. Once initialised, a one-line ready
message is written to stderr; stdout is reserved for the MCP protocol stream.

HTTP mode exposes the same tools at http://<host>:<port><path> using the MCP
Streamable HTTP transport (stateless — no session affinity). Provider API keys
must be set in the server environment before launch. Always set
CONSENSUS_HTTP_API_KEY before binding to 0.0.0.0 or deploying a public URL.
`;

function parseServeArgs(argv: readonly string[]): ServeArgs | Error {
  const out: ServeArgs = {
    configPath: undefined,
    help: false,
    http: process.env["CONSENSUS_HTTP"] === "1" || process.env["CONSENSUS_HTTP"] === "true",
    host: "127.0.0.1",
    port: 3000,
    path: "/mcp",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--http") {
      out.http = true;
    } else if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (!next) return new Error(`Missing value for ${arg}`);
      out.configPath = next;
      i++;
    } else if (arg.startsWith("--config=")) {
      out.configPath = arg.slice("--config=".length);
    } else if (arg === "--host") {
      const next = argv[i + 1];
      if (!next) return new Error("Missing value for --host");
      out.host = next;
      i++;
    } else if (arg.startsWith("--host=")) {
      out.host = arg.slice("--host=".length);
    } else if (arg === "--port") {
      const next = argv[i + 1];
      if (!next) return new Error("Missing value for --port");
      const port = Number.parseInt(next, 10);
      if (!Number.isFinite(port) || port < 0 || port > 65535) {
        return new Error(`Invalid --port value: ${next}`);
      }
      out.port = port;
      i++;
    } else if (arg.startsWith("--port=")) {
      const port = Number.parseInt(arg.slice("--port=".length), 10);
      if (!Number.isFinite(port) || port < 0 || port > 65535) {
        return new Error(`Invalid --port value: ${arg}`);
      }
      out.port = port;
    } else if (arg === "--path") {
      const next = argv[i + 1];
      if (!next) return new Error("Missing value for --path");
      out.path = next.startsWith("/") ? next : `/${next}`;
      i++;
    } else if (arg.startsWith("--path=")) {
      const p = arg.slice("--path=".length);
      out.path = p.startsWith("/") ? p : `/${p}`;
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

  if (parsed.http) {
    return runServeHttp(config, parsed);
  }

  return runServeStdio(config);
}

async function runServeStdio(config: Awaited<ReturnType<typeof loadConfig>>): Promise<number> {
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

async function runServeHttp(
  config: Awaited<ReturnType<typeof loadConfig>>,
  args: ServeArgs,
): Promise<number> {
  const handle = await startNodeHttpServer({
    config,
    host: args.host,
    port: args.port,
    path: args.path,
  });

  return new Promise<number>((resolve) => {
    const shutdown = (reason: string) => {
      process.stderr.write(`${SERVER_NAME}: shutting down (${reason})\n`);
      handle
        .close()
        .catch(() => undefined)
        .finally(() => resolve(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}
