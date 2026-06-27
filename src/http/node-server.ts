// ─────────────────────────────────────────────────────────────
// Node.js HTTP server — Streamable HTTP MCP over http.Server
// ─────────────────────────────────────────────────────────────
// Thin wrapper around the stateless per-request pattern using
// StreamableHTTPServerTransport (Node IncomingMessage/ServerResponse).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { LoadedConfig } from "../config.js";
import { createMcpServer } from "../server.js";
import {
  logHttpErrorFrom,
  normalizePath,
  sanitizeClientError,
  type HealthInfo,
} from "./handler.js";
import {
  resolveHttpAuthConfig,
  verifyHttpAuth,
  writeUnauthorized,
  type HttpAuthConfig,
} from "./auth.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

export interface NodeHttpServerOptions {
  config: LoadedConfig;
  host?: string;
  port?: number;
  /** MCP endpoint path (default `/mcp`). */
  path?: string;
  /** Endpoint auth (default: CONSENSUS_HTTP_API_KEY env). */
  auth?: HttpAuthConfig;
}

export interface NodeHttpServerHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

/**
 * Start a Node http.Server exposing stateless Streamable HTTP MCP.
 * Returns the listening server and a convenience `close()` helper.
 */
export async function startNodeHttpServer(
  options: NodeHttpServerOptions,
): Promise<NodeHttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const mcpPath = options.path ?? "/mcp";
  const auth = options.auth ?? resolveHttpAuthConfig();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (tryServeHealth(req, res, options.config, mcpPath, auth)) return;
        if (req.url && !matchesMcpPath(req.url, mcpPath)) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        const authResult = verifyHttpAuth(auth, nodeHeaders(req));
        if (!authResult.ok) {
          writeUnauthorized(res, authResult.reason ?? "invalid");
          return;
        }

        await handleNodeMcpRequest(options.config, req, res);
      } catch (err) {
        logHttpErrorFrom(err, "handler");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: sanitizeClientError() },
              id: null,
            }),
          );
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const bound = server.address();
  const boundPort = bound && typeof bound !== "string" ? bound.port : port;
  const boundHost = bound && typeof bound !== "string" && bound.address ? bound.address : host;
  const displayHost = boundHost === "0.0.0.0" || boundHost === "::" ? "127.0.0.1" : boundHost;
  const url = `http://${displayHost}:${boundPort}${mcpPath}`;
  const authNote = auth.apiKey ? ", auth=required (CONSENSUS_HTTP_API_KEY)" : ", auth=disabled";
  process.stderr.write(
    `${SERVER_NAME} http ready — ${options.config.participants.length} participant(s), ` +
      `${Object.keys(options.config.providers).length} provider(s) at ${url}${authNote}\n`,
  );
  if (!auth.apiKey && (host === "0.0.0.0" || host === "::")) {
    process.stderr.write(
      `${SERVER_NAME} http: WARNING — listening on ${host} without ${"CONSENSUS_HTTP_API_KEY"}. ` +
        `Anyone who discovers this URL can spend your provider API keys. Set the env var before exposing publicly.\n`,
    );
  }

  return {
    server,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleNodeMcpRequest(
  config: LoadedConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createMcpServer(config);

  transport.onerror = (err: Error) => {
    process.stderr.write(`${SERVER_NAME} http transport: ${err.message}\n`);
  };

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    await server.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function nodeHeaders(req: IncomingMessage): { get(name: string): string | null } {
  return {
    get(name: string) {
      const v = req.headers[name.toLowerCase()];
      if (v === undefined) return null;
      return Array.isArray(v) ? (v[0] ?? null) : v;
    },
  };
}

function tryServeHealth(
  req: IncomingMessage,
  res: ServerResponse,
  config: LoadedConfig,
  mcpPath: string,
  auth: HttpAuthConfig,
): boolean {
  if (req.method !== "GET" || !req.url) return false;
  const pathname = normalizePath(new URL(req.url, "http://localhost").pathname);
  if (pathname !== "/health" && pathname !== `${mcpPath}/health`) return false;

  const body: HealthInfo = {
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    participants: config.participants.length,
    providers: Object.keys(config.providers).length,
    memory: config.memory.enabled,
    transport: "streamable-http-stateless",
    authRequired: Boolean(auth.apiKey),
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
  return true;
}

function matchesMcpPath(url: string, mcpPath: string): boolean {
  const pathname = normalizePath(new URL(url, "http://localhost").pathname);
  return pathname === normalizePath(mcpPath);
}
