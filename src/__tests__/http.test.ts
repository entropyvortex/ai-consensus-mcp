// Integration tests for the stateless Streamable HTTP MCP path.
// Spins up a real Node http.Server, connects with the SDK's
// StreamableHTTPClientTransport, and exercises listTools, validation,
// progress notifications, and cancellation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LoadedConfig } from "../config.js";
import { startNodeHttpServer, type NodeHttpServerHandle } from "../http/node-server.js";
import { PERSONAS } from "../personas.js";
import { BUILT_IN_PRESETS } from "../presets/definitions/index.js";
import { createHttpHandler, sanitizeClientError } from "../http/handler.js";

function makeConfig(overrides: Partial<LoadedConfig> = {}): LoadedConfig {
  const base: LoadedConfig = {
    sourcePath: "/fake/http-test",
    providers: {
      test: {
        id: "test",
        baseUrl: "https://api.test.local",
        apiKey: "k",
        extraHeaders: {},
      },
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
  return { ...base, ...overrides };
}

function makeSSEResponse(payloads: object[]): Response {
  const encoder = new TextEncoder();
  const text = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("") + "data: [DONE]\n\n";
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(text));
      c.close();
    },
  });
  return new Response(stream, { status: 200, statusText: "OK" });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function connectClient(baseUrl: string): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
  close: () => Promise<void>;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  const client = new Client({ name: "http-test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}

describe("stateless Streamable HTTP MCP", () => {
  let httpServer: NodeHttpServerHandle | undefined;
  const originalFetch = globalThis.fetch.bind(globalThis);
  let providerFetchCount = 0;

  beforeEach(() => {
    providerFetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url.includes("api.test.local")) {
        providerFetchCount += 1;
        return makeSSEResponse([
          { choices: [{ delta: { content: "Analysis.\n\nCONFIDENCE: 72" } }] },
        ]);
      }
      return originalFetch(input, init);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (httpServer) {
      await httpServer.close();
      httpServer = undefined;
    }
  });

  async function startTestServer(config = makeConfig()): Promise<string> {
    httpServer = await startNodeHttpServer({
      config,
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
    });
    const addr = httpServer.server.address();
    if (!addr || typeof addr === "string") throw new Error("expected bound port");
    return `http://127.0.0.1:${addr.port}/mcp`;
  }

  it("lists consensus plus all preset panel tools over HTTP", async () => {
    const url = await startTestServer();
    const env = await connectClient(url);
    const tools = await env.client.listTools();
    const names = tools.tools.map((t) => t.name);

    expect(names).toContain("consensus");
    const presetNames = BUILT_IN_PRESETS.map((p) => p.toolName);
    for (const name of presetNames) {
      expect(names).toContain(name);
    }
    expect(names.filter((n) => n.startsWith("consensus_")).length).toBeGreaterThanOrEqual(5);

    await env.close();
  });

  it("returns validation errors for invalid tool input without calling providers", async () => {
    const url = await startTestServer();
    const env = await connectClient(url);
    const result = await env.client.callTool({
      name: "consensus",
      arguments: { prompt: "" },
    });
    expect(result.isError).toBe(true);
    expect(providerFetchCount).toBe(0);

    await env.close();
  });

  it("forwards engine progress notifications during a consensus run", async () => {
    const url = await startTestServer(
      makeConfig({
        defaults: {
          maxRounds: 1,
          earlyStop: false,
          convergenceDelta: 3,
          disagreementThreshold: 20,
          blindFirstRound: true,
          randomizeOrder: false,
          participantTemperature: 0.7,
          maxOutputTokens: 1500,
          useJudge: false,
        },
      }),
    );

    const env = await connectClient(url);
    const progressMessages: string[] = [];

    env.client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      if (notification.params.message) progressMessages.push(notification.params.message);
    });

    const result = await env.client.callTool(
      {
        name: "consensus",
        arguments: { prompt: "Should we adopt event sourcing?", maxRounds: 1, judge: false },
      },
      undefined,
      {
        timeout: 30_000,
        resetTimeoutOnProgress: true,
        onprogress: (p) => {
          if (p.message) progressMessages.push(p.message);
        },
      },
    );

    expect(result.isError).not.toBe(true);
    expect(progressMessages.some((m) => m.includes("Round 1"))).toBe(true);
    expect(progressMessages.some((m) => m.includes("thinking"))).toBe(true);
    expect(providerFetchCount).toBeGreaterThan(0);

    await env.close();
  });

  it("honors AbortSignal cancellation from the client", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url.includes("api.test.local")) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return originalFetch(input, init);
    });

    const url = await startTestServer(
      makeConfig({
        defaults: {
          maxRounds: 2,
          earlyStop: false,
          convergenceDelta: 3,
          disagreementThreshold: 20,
          blindFirstRound: true,
          randomizeOrder: false,
          participantTemperature: 0.7,
          maxOutputTokens: 1500,
          useJudge: false,
        },
      }),
    );

    const env = await connectClient(url);
    const controller = new AbortController();

    const callPromise = env.client.callTool(
      {
        name: "consensus",
        arguments: { prompt: "cancel me", maxRounds: 2, judge: false },
      },
      undefined,
      { signal: controller.signal, timeout: 30_000 },
    );

    controller.abort();

    await expect(callPromise).rejects.toThrow();

    await env.close();
  });

  it("exposes a health endpoint for deploy probes", async () => {
    const handler = createHttpHandler(makeConfig());
    const response = await handler(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      server: string;
      authRequired: boolean;
    };
    expect(body.status).toBe("ok");
    expect(body.server).toBe("ai-consensus-mcp");
    expect(body.authRequired).toBe(false);
  });
});

describe("sanitizeClientError", () => {
  it("returns a generic message that never leaks error details", () => {
    const msg = sanitizeClientError();
    expect(msg).toBe("Internal server error");
    expect(msg).not.toContain("sk-secret");
    expect(msg).not.toContain("Bearer");
  });
});
