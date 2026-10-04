// ─────────────────────────────────────────────────────────────
// Stateless Streamable HTTP handler — Web Standard entry point
// ─────────────────────────────────────────────────────────────
// Exposes the full MCP tool surface (consensus + preset panels) over
// HTTP using WebStandardStreamableHTTPServerTransport. Each request
// gets a fresh transport + server pair (stateless, no session affinity).
//
// Use directly in Cloudflare Workers, Deno, Bun, or any runtime with
// fetch(Request) → Response. node-server.ts adapts Node's http.Server onto
// this same handler, so both runtimes share one policy path.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { LoadedConfig } from "../config.js";
import { createMcpServer } from "../server.js";
import { SERVER_NAME } from "../version.js";
import {
  resolveHttpAuthConfig,
  unauthorizedResponse,
  verifyHttpAuth,
  type HttpAuthConfig,
} from "./auth.js";
import { isHostAllowed, isOriginAllowed } from "./host.js";

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
  /**
   * DNS-rebinding defence: Host header allow-list (`host` matches any port,
   * `host:port` pins one). Undefined skips Host validation — appropriate for
   * a public hostname (Workers); loopback Node binds default to localhost.
   */
  allowedHosts?: readonly string[];
  /**
   * Origin allow-list. A request carrying any other Origin header (browsers
   * always send one cross-origin) is refused with 403; requests without an
   * Origin (server-side MCP clients) are unaffected. Default: none allowed.
   */
  allowedOrigins?: readonly string[];
}

/** Liveness only: no auth posture, panel shape, or version for scanners. */
export interface HealthInfo {
  status: "ok";
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
  const allowedHosts = options.allowedHosts;
  const allowedOrigins = options.allowedOrigins ?? [];

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = normalizePath(url.pathname);

    if (enableHealth && request.method === "GET") {
      if (pathname === "/health" || pathname === `${mcpPath}/health`) {
        const body: HealthInfo = { status: "ok" };
        return jsonResponse(200, body);
      }
    }

    if (pathname !== mcpPath) {
      return new Response("Not Found", { status: 404 });
    }

    if (allowedHosts && !isHostAllowed(request.headers.get("host"), allowedHosts)) {
      logHttpError(
        `rejected Host ${JSON.stringify(request.headers.get("host"))} — add it to allowedHosts (--allowed-hosts) if legitimate`,
      );
      return jsonRpcError(403, -32000, "Forbidden: Host header not allowed", null);
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !isOriginAllowed(origin, allowedOrigins)) {
      logHttpError(
        `rejected Origin ${JSON.stringify(origin)} — add it to allowedOrigins (--allowed-origins) if legitimate`,
      );
      return jsonRpcError(403, -32000, "Forbidden: Origin not allowed", null);
    }

    // Stateless: no standalone GET SSE stream (it could never carry a
    // message, yet would pin a server + connection) and no session to DELETE.
    if (request.method !== "POST") {
      return jsonRpcError(
        405,
        -32000,
        "Method Not Allowed: this stateless endpoint accepts POST only",
        null,
        {
          Allow: "POST",
        },
      );
    }

    const authResult = verifyHttpAuth(auth, request.headers);
    if (!authResult.ok) {
      return unauthorizedResponse(authResult.reason ?? "invalid");
    }

    return handleStatelessMcpRequest(config, request);
  };
}

/**
 * Handle a single MCP request in stateless mode: a fresh server + transport
 * pair whose lifetime is bound to the response body. Applies no routing,
 * auth, or request policy — callers go through `createHttpHandler`.
 */
async function handleStatelessMcpRequest(
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

  // Teardown must wait for the response body: in SSE mode `handleRequest`
  // returns immediately with a stream the tool handler writes into later.
  // Closing the server aborts in-flight handlers (and their upstream LLM
  // fetches), so it runs exactly once — when the body finishes, errors, is
  // cancelled by the client, or the request's own signal aborts.
  let tornDown = false;
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    request.signal.removeEventListener("abort", teardown);
    void server.close().catch(() => undefined);
    void transport.close().catch(() => undefined);
  };
  if (request.signal.aborted) {
    teardown();
    return new Response(null, { status: 499 });
  }
  request.signal.addEventListener("abort", teardown, { once: true });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(
      request,
      parsedBody !== undefined ? { parsedBody } : undefined,
    );
    if (!response.body) {
      teardown();
      return response;
    }
    return new Response(withTeardown(response.body, teardown), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    teardown();
    logHttpErrorFrom(err, "request");
    return jsonResponse(500, {
      jsonrpc: "2.0",
      error: { code: -32603, message: sanitizeClientError() },
      id: null,
    });
  }
}

/**
 * Re-expose `body` so that `onDone` runs once the stream ends, errors, or the
 * consumer cancels it (client disconnect). Pull-based, so backpressure from
 * the consumer propagates to the source.
 */
function withTeardown(
  body: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        onDone();
        controller.error(err);
        return;
      }
      if (chunk.done) {
        controller.close();
        onDone();
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      onDone();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Strip trailing slashes without regex (avoids ReDoS on attacker-controlled paths). */
export function normalizePath(path: string): string {
  if (path === "/") return "/";
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end) || "/";
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  id: string | number | null,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { jsonrpc: "2.0", error: { code, message }, id }, headers);
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
