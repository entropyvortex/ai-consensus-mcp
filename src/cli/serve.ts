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
import { parseList } from "../http/host.js";
import { startNodeHttpServer } from "../http/node-server.js";
import { createMcpServer } from "../server.js";
import { SERVER_NAME } from "../version.js";

export interface ServeArgs {
  configPath: string | undefined;
  help: boolean;
  http: boolean;
  host: string;
  port: number;
  path: string;
  allowedHosts: string[] | undefined;
  allowedOrigins: string[] | undefined;
  allowUnauthenticated: boolean;
  maxConcurrentToolCalls: number | undefined;
  maxPromptChars: number | undefined;
  maxOutputTokens: number | undefined;
}

const SERVE_HELP = `
${SERVER_NAME} serve — start the MCP server

Usage (stdio — default):
  ai-consensus-mcp serve --config <path>
  CONSENSUS_CONFIG=<path> ai-consensus-mcp serve
  ai-consensus-mcp --config <path>             # subcommand inferred

Usage (remote Streamable HTTP):
  ai-consensus-mcp serve --http --config <path>
  CONSENSUS_HTTP_API_KEY=<secret> ai-consensus-mcp serve --http --config <path> \
      --host 0.0.0.0 --port 3000
  CONSENSUS_HTTP=1 ai-consensus-mcp serve --config <path>

Flags:
  -c, --config <path>    Path to a JSON config file describing providers,
                         participants, and (optionally) a judge.
      --http             Serve over stateless Streamable HTTP instead of stdio.
      --host <addr>      Bind address for HTTP mode (default: 127.0.0.1).
      --port <n>         Listen port for HTTP mode (default: 3000).
      --path <path>      MCP endpoint path for HTTP mode (default: /mcp).
      --allow-unauthenticated
                         Permit a non-loopback --host without
                         CONSENSUS_HTTP_API_KEY. Without this flag the server
                         refuses to start in that configuration.
      --allowed-hosts <list>
                         Comma-separated Host header values to accept (DNS-
                         rebinding defence). On a loopback bind, localhost,
                         127.0.0.1 and [::1] are always accepted; add the
                         public name your reverse proxy forwards. On other
                         binds, Host is only checked when this is set.
      --allowed-origins <list>
                         Comma-separated browser Origins to accept. Requests
                         carrying any other Origin header get 403; clients
                         that send no Origin (server-side) are unaffected.
      --max-concurrent-tool-calls <n>
                         Concurrent tool calls served at once (default 4).
                         Further calls get HTTP 429 until a slot frees.
      --max-prompt-chars <n>
                         Longest prompt argument accepted (default 100000).
      --max-output-tokens <n>
                         Highest maxOutputTokens a caller may request
                         (default 8192).
  -h, --help             Show this help.

Environment:
  CONSENSUS_CONFIG       Fallback config path if --config is omitted.
  CONSENSUS_HTTP         If set to 1/true, enables HTTP mode (same as --http).
  CONSENSUS_HTTP_API_KEY Endpoint secret. Clients must send
                         Authorization: Bearer <key> or X-Consensus-Api-Key.
                         Required for any non-loopback --host (the server
                         refuses to start otherwise). Optional on loopback.
  <PROVIDER_API_KEY>     Each provider in the config declares an \`apiKeyEnv\`;
                         that env var must be set.

Stdio mode speaks JSON-RPC over stdout. Once initialised, a one-line ready
message is written to stderr; stdout is reserved for the MCP protocol stream.

HTTP mode exposes the same tools at http://<host>:<port><path> using the MCP
Streamable HTTP transport (stateless — no session affinity). Provider API keys
must be set in the server environment before launch.
`;

type ValueFlag = (out: ServeArgs, value: string, flag: string) => Error | undefined;

const VALUE_FLAGS: Record<string, ValueFlag> = {
  "--config": (out, v) => {
    out.configPath = v;
    return undefined;
  },
  "--host": (out, v) => {
    out.host = v;
    return undefined;
  },
  "--port": (out, v, flag) => {
    const port = Number.parseInt(v, 10);
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
      return new Error(`Invalid ${flag} value: ${v}`);
    }
    out.port = port;
    return undefined;
  },
  "--path": (out, v) => {
    out.path = v.startsWith("/") ? v : `/${v}`;
    return undefined;
  },
  "--allowed-hosts": (out, v) => {
    out.allowedHosts = parseList(v);
    return undefined;
  },
  "--allowed-origins": (out, v) => {
    out.allowedOrigins = parseList(v);
    return undefined;
  },
  "--max-concurrent-tool-calls": (out, v, flag) => {
    const n = parseStrictInt(v, 1, 10_000);
    if (n === undefined) return new Error(`Invalid ${flag} value: ${v} (expected 1-10000)`);
    out.maxConcurrentToolCalls = n;
    return undefined;
  },
  "--max-prompt-chars": (out, v, flag) => {
    const n = parseStrictInt(v, 1, 10_000_000);
    if (n === undefined) return new Error(`Invalid ${flag} value: ${v}`);
    out.maxPromptChars = n;
    return undefined;
  },
  "--max-output-tokens": (out, v, flag) => {
    const n = parseStrictInt(v, 1, 10_000_000);
    if (n === undefined) return new Error(`Invalid ${flag} value: ${v}`);
    out.maxOutputTokens = n;
    return undefined;
  },
};

/** Decimal digits only (no "3000abc", "1e3", " 7", "-1"), within [min, max]. */
export function parseStrictInt(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

export function parseServeArgs(argv: readonly string[]): ServeArgs | Error {
  const out: ServeArgs = {
    configPath: undefined,
    help: false,
    http: process.env["CONSENSUS_HTTP"] === "1" || process.env["CONSENSUS_HTTP"] === "true",
    host: "127.0.0.1",
    port: 3000,
    path: "/mcp",
    allowedHosts: undefined,
    allowedOrigins: undefined,
    allowUnauthenticated: false,
    maxConcurrentToolCalls: undefined,
    maxPromptChars: undefined,
    maxOutputTokens: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--http") {
      out.http = true;
      continue;
    }
    if (arg === "--allow-unauthenticated") {
      out.allowUnauthenticated = true;
      continue;
    }
    const inline = arg.startsWith("--") && arg.includes("=");
    const name = inline ? arg.slice(0, arg.indexOf("=")) : arg === "-c" ? "--config" : arg;
    const apply = VALUE_FLAGS[name];
    if (!apply) return new Error(`Unknown argument: ${arg}`);
    let value: string | undefined;
    if (inline) {
      value = arg.slice(arg.indexOf("=") + 1);
    } else {
      value = argv[i + 1];
      if (!value) return new Error(`Missing value for ${arg}`);
      i++;
    }
    const err = apply(out, value, name);
    if (err) return err;
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
    ...(args.allowedHosts ? { allowedHosts: args.allowedHosts } : {}),
    ...(args.allowedOrigins ? { allowedOrigins: args.allowedOrigins } : {}),
    allowUnauthenticated: args.allowUnauthenticated,
    ...(args.maxConcurrentToolCalls !== undefined
      ? { maxConcurrentToolCalls: args.maxConcurrentToolCalls }
      : {}),
    ...(args.maxPromptChars !== undefined ? { maxPromptChars: args.maxPromptChars } : {}),
    ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
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
