/**
 * Cloudflare Worker entry — stateless Streamable HTTP MCP for Grok custom connectors.
 *
 * Deploy from the repo root (wrangler bundles this file and the TypeScript
 * sources it imports; no separate build step is required):
 *   npm run deploy:cloudflare
 *
 * Required secrets:
 *   CONSENSUS_CONFIG_JSON  — full consensus.config.json contents as a string
 *   CONSENSUS_HTTP_API_KEY — shared secret callers must send as Bearer / X-Consensus-Api-Key
 *   <PROVIDER_API_KEY>     — each provider's apiKeyEnv from the config (e.g. GROK_API_KEY)
 *
 * Optional vars:
 *   MCP_PATH                          — endpoint path (default /mcp)
 *   CONSENSUS_HTTP_ALLOWED_HOSTS      — comma-separated Host allow-list (default: no Host check)
 *   CONSENSUS_HTTP_ALLOWED_ORIGINS    — comma-separated browser Origins to accept (default: none)
 *   CONSENSUS_HTTP_MAX_CONCURRENT_TOOL_CALLS — per-isolate in-flight cap (default 4)
 *   CONSENSUS_HTTP_MAX_PROMPT_CHARS   — longest prompt accepted (default 100000)
 *   CONSENSUS_HTTP_MAX_OUTPUT_TOKENS  — highest maxOutputTokens a caller may request (default 8192)
 *
 * Memory layer is disabled on Workers (no persistent filesystem). Omit `"memory"` from config.
 */

import {
  createHttpHandler,
  loadConfigFromJson,
  type HttpHandlerOptions,
} from "../../src/http/index.js";
import { parseList } from "../../src/http/host.js";

interface Env {
  CONSENSUS_CONFIG_JSON?: string;
  CONSENSUS_HTTP_API_KEY?: string;
  MCP_PATH?: string;
  CONSENSUS_HTTP_ALLOWED_HOSTS?: string;
  CONSENSUS_HTTP_ALLOWED_ORIGINS?: string;
  CONSENSUS_HTTP_MAX_CONCURRENT_TOOL_CALLS?: string;
  CONSENSUS_HTTP_MAX_PROMPT_CHARS?: string;
  CONSENSUS_HTTP_MAX_OUTPUT_TOKENS?: string;
  [key: string]: string | undefined;
}

type Handler = (request: Request) => Promise<Response>;

// One handler per isolate: the config is parsed once and the in-flight
// tool-call cap is shared by every request this isolate serves.
let cached: { configJson: string; apiKey: string; handler: Handler } | undefined;

function positiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return Number(value);
}

function getHandler(env: Env): Handler {
  if (!env.CONSENSUS_CONFIG_JSON) {
    throw new Error(
      "CONSENSUS_CONFIG_JSON is not set. Add it as a Worker secret with your consensus.config.json contents.",
    );
  }
  const apiKey = env.CONSENSUS_HTTP_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "CONSENSUS_HTTP_API_KEY is required for public Workers deploys. Set it as a Worker secret.",
    );
  }
  if (cached?.configJson === env.CONSENSUS_CONFIG_JSON && cached.apiKey === apiKey) {
    return cached.handler;
  }

  const config = loadConfigFromJson(env.CONSENSUS_CONFIG_JSON, "worker:CONSENSUS_CONFIG_JSON", {
    allowCli: false,
    // Provider keys come from the Worker's bindings, not from whatever
    // nodejs_compat happens to mirror into process.env.
    env,
  });
  const options: HttpHandlerOptions = {
    mcpPath: env.MCP_PATH?.startsWith("/") ? env.MCP_PATH : `/${env.MCP_PATH ?? "mcp"}`,
    enableHealth: true,
    auth: { apiKey },
  };
  const allowedHosts = parseList(env.CONSENSUS_HTTP_ALLOWED_HOSTS);
  if (allowedHosts?.length) options.allowedHosts = allowedHosts;
  const allowedOrigins = parseList(env.CONSENSUS_HTTP_ALLOWED_ORIGINS);
  if (allowedOrigins) options.allowedOrigins = allowedOrigins;
  const limits: Array<[keyof HttpHandlerOptions, string]> = [
    ["maxConcurrentToolCalls", "CONSENSUS_HTTP_MAX_CONCURRENT_TOOL_CALLS"],
    ["maxPromptChars", "CONSENSUS_HTTP_MAX_PROMPT_CHARS"],
    ["maxOutputTokens", "CONSENSUS_HTTP_MAX_OUTPUT_TOKENS"],
  ];
  for (const [option, name] of limits) {
    const n = positiveInt(name, env[name]);
    if (n !== undefined) (options as Record<string, unknown>)[option] = n;
  }

  const handler = createHttpHandler(config, options);
  cached = { configJson: env.CONSENSUS_CONFIG_JSON, apiKey, handler };
  return handler;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await getHandler(env)(request);
    } catch (err) {
      // Log the message only — enough to diagnose a bad secret or config
      // (config errors name env vars and fields, never their values) — and
      // never the stack, the error object, or anything from the request.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`ai-consensus-mcp worker error: ${message}`);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
