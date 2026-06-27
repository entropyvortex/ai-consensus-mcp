// ─────────────────────────────────────────────────────────────
// Stateless Streamable HTTP handler — Web Standard entry point
// ─────────────────────────────────────────────────────────────
// Exposes the full MCP tool surface (consensus + preset panels) over
// HTTP using WebStandardStreamableHTTPServerTransport. Each request
// gets a fresh transport + server pair (stateless, no session affinity).
//
// Use directly in Cloudflare Workers, Deno, Bun, or any runtime with
// fetch(Request) → Response. For Node's http.Server, see node-server.ts.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { LoadedConfig } from "../config.js";
import { createMcpServer } from "../server.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";
import {
  resolveHttpAuthConfig,
  unauthorizedResponse,
  verifyHttpAuth,
  type HttpAuthConfig,
} from "./auth.js";

export interface HttpHandlerOptions {
  /** MCP endpoint path (default `/mcp`). Requests must match this path exactly. */
  mcpPath?: string;
  /** Expose GET /health and GET {mcpPath}/health for deploy probes (default true). */
  enableHealth?: boolean;
  /**
   * Endpoint authentication. Defaults to `resolveHttpAuthConfig()` (reads
   * `CONSENSUS_HTTP_API_KEY`). When set, MCP requests require Bearer or
   * X-Consensus-Api-Key; health stays open.
   */
  auth?: HttpAuthConfig;
}

export interface HealthInfo {
  status: "ok";
  server: string;
  version: string;
  participants: number;
  providers: number;
  memory: boolean;
  transport: "streamable-http-stateless";
  /** True when CONSENSUS_HTTP_API_KEY (or explicit auth config) protects MCP routes. */
  authRequired: boolean;
}

/**
 * Build a Web Standard fetch handler for stateless Streamable HTTP MCP.
 * Create once at deploy/startup with a loaded config; invoke per request.
 */
export function createHttpHandler(
  config: LoadedConfig,
  options: HttpHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const mcpPath = normalizePath(options.mcpPath ?? "/mcp");
  const enableHealth = options.enableHealth ?? true;
  const auth = options.auth ?? resolveHttpAuthConfig();

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = normalizePath(url.pathname);

    if (enableHealth && request.method === "GET") {
      if (pathname === "/health" || pathname === `${mcpPath}/health`) {
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
        return jsonResponse(200, body);
      }
    }

    if (pathname !== mcpPath) {
      return new Response("Not Found", { status: 404 });
    }

    const authResult = verifyHttpAuth(auth, request.headers);
    if (!authResult.ok) {
      return unauthorizedResponse(authResult.reason ?? "invalid");
    }

    return handleStatelessMcpRequest(config, request);
  };
}

/**
 * Handle a single MCP request in stateless mode. Exported for Node adapters
 * that use StreamableHTTPServerTransport instead of raw Request/Response.
 */
export async function handleStatelessMcpRequest(
  config: LoadedConfig,
  request: Request,
  parsedBody?: unknown,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  const server = createMcpServer(config);

  transport.onerror = (err: Error) => {
    logHttpError(`transport: ${err.message}`);
  };

  try {
    await server.connect(transport);
    return await transport.handleRequest(
      request,
      parsedBody !== undefined ? { parsedBody } : undefined,
    );
  } catch (err) {
    logHttpErrorFrom(err, "request");
    return jsonResponse(500, {
      jsonrpc: "2.0",
      error: { code: -32603, message: sanitizeClientError() },
      id: null,
    });
  } finally {
    await server.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

/** Strip trailing slashes without regex (avoids ReDoS on attacker-controlled paths). */
export function normalizePath(path: string): string {
  if (path === "/") return "/";
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end) || "/";
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Safe client-facing message — never forwards err.message (CodeQL: stack-trace exposure). */
export function sanitizeClientError(): string {
  return "Internal server error";
}

function logHttpError(message: string): void {
  process.stderr.write(`${SERVER_NAME} http: ${message}\n`);
}

/** Log full error detail to stderr only (never returned to remote clients). */
export function logHttpErrorFrom(err: unknown, context: string): void {
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : typeof err === "string" ? err : String(err);
  logHttpError(`${context}: ${detail}`);
}
