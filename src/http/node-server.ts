// ─────────────────────────────────────────────────────────────
// Node.js HTTP server — Streamable HTTP MCP over http.Server
// ─────────────────────────────────────────────────────────────
// Thin IncomingMessage/ServerResponse ⇄ Request/Response adapter around
// `createHttpHandler`, so Node and Web Standard runtimes (Workers) share a
// single code path for routing, auth, and request policy. Client
// disconnects abort the Request's signal and cancel the response body, which
// tears down the per-request MCP server and aborts upstream provider calls.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { LoadedConfig } from "../config.js";
import { SERVER_NAME } from "../version.js";
import { HTTP_API_KEY_ENV, resolveHttpAuthConfig, type HttpAuthConfig } from "./auth.js";
import { createHttpHandler, logHttpErrorFrom, sanitizeClientError } from "./handler.js";
import { isLoopbackHost, LOOPBACK_HOSTNAMES } from "./host.js";

export interface NodeHttpServerOptions {
  config: LoadedConfig;
  host?: string;
  port?: number;
  /** MCP endpoint path (default `/mcp`). */
  path?: string;
  /** Endpoint auth (default: CONSENSUS_HTTP_API_KEY env). */
  auth?: HttpAuthConfig;
  /**
   * Extra Host header values to accept (e.g. the public name a reverse proxy
   * forwards). On a loopback bind these are added to localhost/127.0.0.1/[::1],
   * which are always accepted; on other binds Host is only checked when set.
   */
  allowedHosts?: readonly string[];
  /** Browser Origins to accept. Default: none (requests with Origin get 403). */
  allowedOrigins?: readonly string[];
  /**
   * Permit a non-loopback bind without an endpoint key. Off by default:
   * without it, startup fails rather than exposing an open endpoint that
   * spends the operator's provider keys.
   */
  allowUnauthenticated?: boolean;
  /** See HttpHandlerOptions.maxConcurrentToolCalls (default 4). */
  maxConcurrentToolCalls?: number;
  /** See HttpHandlerOptions.maxPromptChars (default 100 000). */
  maxPromptChars?: number;
  /** See HttpHandlerOptions.maxOutputTokens (default 8192). */
  maxOutputTokens?: number;
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

  const loopback = isLoopbackHost(host);
  if (!auth.apiKey && !loopback && !options.allowUnauthenticated) {
    throw new Error(
      `refusing to listen on non-loopback address ${JSON.stringify(host)} without ${HTTP_API_KEY_ENV}: ` +
        `anyone who can reach it could spend your provider API keys. Set ${HTTP_API_KEY_ENV} ` +
        `(e.g. \`openssl rand -base64 32\`), bind to 127.0.0.1, or pass --allow-unauthenticated ` +
        `if a trusted layer in front enforces access control.`,
    );
  }
  const allowedHosts = loopback
    ? [...LOOPBACK_HOSTNAMES, host, ...(options.allowedHosts ?? [])]
    : options.allowedHosts;

  const handler = createHttpHandler(options.config, {
    mcpPath,
    auth,
    ...(allowedHosts ? { allowedHosts } : {}),
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    ...(options.maxConcurrentToolCalls !== undefined
      ? { maxConcurrentToolCalls: options.maxConcurrentToolCalls }
      : {}),
    ...(options.maxPromptChars !== undefined ? { maxPromptChars: options.maxPromptChars } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
  });

  const server = createServer((req, res) => {
    void serveNodeRequest(handler, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const bound = server.address();
  const boundPort = bound && typeof bound !== "string" ? bound.port : port;
  const boundHost = bound && typeof bound !== "string" && bound.address ? bound.address : host;
  const displayHost = boundHost === "0.0.0.0" || boundHost === "::" ? "127.0.0.1" : boundHost;
  const url = `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${boundPort}${mcpPath}`;
  const authNote = auth.apiKey ? ", auth=required (CONSENSUS_HTTP_API_KEY)" : ", auth=disabled";
  process.stderr.write(
    `${SERVER_NAME} http ready — ${options.config.participants.length} participant(s), ` +
      `${Object.keys(options.config.providers).length} provider(s) at ${url}${authNote}\n`,
  );
  if (!auth.apiKey && !loopback) {
    process.stderr.write(
      `${SERVER_NAME} http: WARNING — --allow-unauthenticated: listening on ${host} without ${HTTP_API_KEY_ENV}. ` +
        `Anyone who can reach this address can spend your provider API keys.\n`,
    );
  }

  return {
    server,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Bridge one Node request through the Web Standard handler. */
export async function serveNodeRequest(
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const disconnect = new AbortController();
  // `close` fires on normal completion too; only a close before the response
  // finished means the client went away.
  res.once("close", () => {
    if (!res.writableFinished) disconnect.abort();
  });

  try {
    const response = await handler(toWebRequest(req, disconnect.signal));
    await writeWebResponse(response, res, disconnect.signal);
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
    } else {
      res.destroy();
    }
  }
}

function toWebRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  // The URL's authority is fixed: routing only needs the path, and Host
  // validation reads the raw header so a hostile Host cannot break parsing.
  const url = new URL(req.url ?? "/", "http://localhost");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    signal,
    ...(hasBody
      ? {
          body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
          duplex: "half",
        }
      : {}),
  });
}

async function writeWebResponse(
  response: Response,
  res: ServerResponse,
  disconnected: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  res.flushHeaders();

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  disconnected.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const settle = () => {
            res.off("drain", settle);
            res.off("close", settle);
            resolve();
          };
          res.once("drain", settle);
          res.once("close", settle);
        });
      }
      if (disconnected.aborted) return;
    }
    res.end();
  } finally {
    disconnected.removeEventListener("abort", cancel);
  }
}
