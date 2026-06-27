/**
 * Cloudflare Worker entry — stateless Streamable HTTP MCP for Grok custom connectors.
 *
 * Build the package first (`npm run build` in repo root), then deploy from repo root:
 *   npm run deploy:cloudflare
 *
 * Required secrets:
 *   CONSENSUS_CONFIG_JSON  — full consensus.config.json contents as a string
 *   CONSENSUS_HTTP_API_KEY — shared secret callers must send as Bearer / X-Consensus-Api-Key
 *   <PROVIDER_API_KEY>     — each provider's apiKeyEnv from the config (e.g. GROK_API_KEY)
 *
 * Optional bindings:
 *   MCP_PATH — endpoint path (default /mcp)
 *
 * Memory layer is disabled on Workers (no persistent filesystem). Omit `"memory"` from config.
 */

import { createHttpHandler, loadConfigFromJson, type HttpAuthConfig } from "../../dist/http/index.js";
import type { LoadedConfig } from "../../dist/config.js";

interface Env {
  CONSENSUS_CONFIG_JSON: string;
  CONSENSUS_HTTP_API_KEY?: string;
  MCP_PATH?: string;
  GROK_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  [key: string]: string | undefined;
}

let cachedConfig: LoadedConfig | undefined;

function getConfig(env: Env): LoadedConfig {
  if (!env.CONSENSUS_CONFIG_JSON) {
    throw new Error(
      "CONSENSUS_CONFIG_JSON is not set. Add it as a Worker secret with your consensus.config.json contents.",
    );
  }
  if (!cachedConfig) {
    cachedConfig = loadConfigFromJson(env.CONSENSUS_CONFIG_JSON, "worker:CONSENSUS_CONFIG_JSON");
  }
  return cachedConfig;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const config = getConfig(env);
      const mcpPath = env.MCP_PATH?.startsWith("/") ? env.MCP_PATH : `/${env.MCP_PATH ?? "mcp"}`;
      const auth: HttpAuthConfig = {
        apiKey: env.CONSENSUS_HTTP_API_KEY?.trim() || undefined,
      };
      if (!auth.apiKey) {
        throw new Error(
          "CONSENSUS_HTTP_API_KEY is required for public Workers deploys. Set it as a Worker secret.",
        );
      }
      const handler = createHttpHandler(config, { mcpPath, enableHealth: true, auth });
      return await handler(request);
    } catch (err) {
      console.error("ai-consensus-mcp worker error:", err);
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
} satisfies ExportedHandler<Env>;