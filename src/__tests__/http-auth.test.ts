import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LoadedConfig } from "../config.js";
import {
  HTTP_API_KEY_ENV,
  resolveHttpAuthConfig,
  unauthorizedResponse,
  verifyHttpAuth,
} from "../http/auth.js";
import { createHttpHandler } from "../http/handler.js";
import { startNodeHttpServer, type NodeHttpServerHandle } from "../http/node-server.js";
import { PERSONAS } from "../personas.js";

const TEST_KEY = "test-endpoint-secret-32chars-min!!";

function makeConfig(): LoadedConfig {
  return {
    sourcePath: "/fake",
    providers: {
      test: { id: "test", baseUrl: "https://api.test.local", apiKey: "k", extraHeaders: {} },
    },
    participants: [
      { id: "p1", modelId: "model-a", persona: PERSONAS[0]! },
      { id: "p2", modelId: "model-b", persona: PERSONAS[1]! },
    ],
    providerByParticipant: { p1: "test", p2: "test" },
    memory: {
      enabled: false,
      storageRoot: "/tmp/test-memory",
      maxResults: 1000,
      maxAgeDays: 365,
      raw: undefined,
    },
    judge: undefined,
    defaults: {
      maxRounds: 4,
      earlyStop: true,
      convergenceDelta: 3,
      disagreementThreshold: 20,
      blindFirstRound: true,
      randomizeOrder: true,
      participantTemperature: 0.7,
      maxOutputTokens: 1500,
      useJudge: false,
    },
  };
}

describe("verifyHttpAuth", () => {
  it("allows all requests when apiKey is unset", () => {
    expect(verifyHttpAuth({ apiKey: undefined }, { get: () => null })).toEqual({ ok: true });
  });

  it("rejects missing credentials when apiKey is set", () => {
    const result = verifyHttpAuth({ apiKey: TEST_KEY }, { get: () => null });
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("accepts Authorization: Bearer", () => {
    const result = verifyHttpAuth(
      { apiKey: TEST_KEY },
      { get: (n) => (n.toLowerCase() === "authorization" ? `Bearer ${TEST_KEY}` : null) },
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts X-Consensus-Api-Key", () => {
    const result = verifyHttpAuth(
      { apiKey: TEST_KEY },
      { get: (n) => (n === "X-Consensus-Api-Key" ? TEST_KEY : null) },
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects wrong secrets without leaking the expected key in 401 body", async () => {
    const result = verifyHttpAuth({ apiKey: TEST_KEY }, { get: () => "Bearer wrong-key" });
    expect(result).toEqual({ ok: false, reason: "invalid" });
    const res = unauthorizedResponse("invalid");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain(TEST_KEY);
    expect(body.error.message).toMatch(/invalid endpoint credentials/i);
  });
});

describe("resolveHttpAuthConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads CONSENSUS_HTTP_API_KEY from env", () => {
    vi.stubEnv(HTTP_API_KEY_ENV, `  ${TEST_KEY}  `);
    expect(resolveHttpAuthConfig()).toEqual({ apiKey: TEST_KEY });
  });
});

describe("HTTP auth integration", () => {
  let httpServer: NodeHttpServerHandle | undefined;

  afterEach(async () => {
    if (httpServer) {
      await httpServer.close();
      httpServer = undefined;
    }
  });

  async function serverUrl(authKey?: string): Promise<string> {
    httpServer = await startNodeHttpServer({
      config: makeConfig(),
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      auth: authKey ? { apiKey: authKey } : { apiKey: undefined },
    });
    const addr = httpServer.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    return `http://127.0.0.1:${addr.port}/mcp`;
  }

  it("returns 401 for MCP without credentials when auth is required", async () => {
    const url = await serverUrl(TEST_KEY);
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await expect(client.connect(transport)).rejects.toThrow();
    await transport.close().catch(() => undefined);
  });

  it("allows MCP when Bearer token matches", async () => {
    const url = await serverUrl(TEST_KEY);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TEST_KEY}` } },
    });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === "consensus")).toBe(true);
    await client.close();
    await transport.close();
  });

  it("health stays reachable without auth when MCP is protected", async () => {
    const handler = createHttpHandler(makeConfig(), {
      auth: { apiKey: TEST_KEY },
    });
    const res = await handler(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authRequired: boolean };
    expect(body.authRequired).toBe(true);
  });
});
