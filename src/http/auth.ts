// ─────────────────────────────────────────────────────────────
// HTTP endpoint authentication (optional, env-driven)
// ─────────────────────────────────────────────────────────────
// When CONSENSUS_HTTP_API_KEY is set, every MCP request must present
// the same value via Authorization: Bearer <key> or X-Consensus-Api-Key.
// Health probes (/health) stay unauthenticated for deploy checks.

import { createHash, timingSafeEqual } from "node:crypto";

/** Env var name for the shared HTTP endpoint secret. */
export const HTTP_API_KEY_ENV = "CONSENSUS_HTTP_API_KEY";

export interface HttpAuthConfig {
  /** When set, MCP requests must authenticate. Undefined = open (dev only). */
  apiKey: string | undefined;
}

export function resolveHttpAuthConfig(env: NodeJS.ProcessEnv = process.env): HttpAuthConfig {
  const raw = env[HTTP_API_KEY_ENV]?.trim();
  return { apiKey: raw && raw.length > 0 ? raw : undefined };
}

export type HttpAuthFailureReason = "missing" | "invalid";

export interface HttpAuthResult {
  ok: boolean;
  reason?: HttpAuthFailureReason;
}

/** Headers sufficient for Web Request and Node IncomingMessage-style maps. */
export interface HttpAuthHeaders {
  get(name: string): string | null | undefined;
}

/**
 * Verify caller credentials against the configured endpoint secret.
 * Returns `{ ok: true }` when auth is disabled (no apiKey configured).
 */
export function verifyHttpAuth(config: HttpAuthConfig, headers: HttpAuthHeaders): HttpAuthResult {
  if (!config.apiKey) return { ok: true };

  const presented = extractPresentedSecret(headers);
  if (!presented) return { ok: false, reason: "missing" };
  if (!timingSafeSecretEqual(presented, config.apiKey)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}

function extractPresentedSecret(headers: HttpAuthHeaders): string | undefined {
  const bearer = headers.get("authorization") ?? headers.get("Authorization");
  if (bearer) {
    const match = /^Bearer\s+(.+)$/i.exec(bearer);
    if (match?.[1]) return match[1].trim();
  }

  const custom = headers.get("x-consensus-api-key") ?? headers.get("X-Consensus-Api-Key");
  if (custom?.trim()) return custom.trim();

  return undefined;
}

/**
 * Constant-time comparison that leaks neither content nor length: both sides
 * are hashed to fixed-size SHA-256 digests before timingSafeEqual, so the
 * work done is independent of where (or whether) the inputs differ.
 */
function timingSafeSecretEqual(a: string, b: string): boolean {
  const aDigest = createHash("sha256").update(a, "utf8").digest();
  const bDigest = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(aDigest, bDigest);
}

export function unauthorizedResponse(reason: HttpAuthFailureReason): Response {
  const message =
    reason === "missing"
      ? "Unauthorized: missing endpoint credentials. Send Authorization: Bearer <CONSENSUS_HTTP_API_KEY> or X-Consensus-Api-Key."
      : "Unauthorized: invalid endpoint credentials.";
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="ai-consensus-mcp"',
      },
    },
  );
}
