// Integration tests for the stateless Streamable HTTP MCP path on Node.
// Spins up a real Node http.Server, connects with the SDK's
// StreamableHTTPClientTransport, and exercises listTools, validation,
// progress notifications, and cancellation.

import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { startNodeHttpServer, type NodeHttpServerHandle } from "../http/node-server.js";
import { BUILT_IN_PRESETS } from "../presets/definitions/index.js";
import { sanitizeClientError } from "../http/handler.js";
import { MCP_HEADERS, eventually, makeConfig, mockProvider, toolCall } from "./http-fixtures.js";

async function connectClient(baseUrl: string): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  const client = new Client({ name: "http-test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}

describe("stateless Streamable HTTP MCP (Node server)", () => {
  let httpServer: NodeHttpServerHandle | undefined;

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
      auth: { apiKey: undefined },
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
    for (const preset of BUILT_IN_PRESETS) {
      expect(names).toContain(preset.toolName);
    }
    expect(names.filter((n) => n.startsWith("consensus_")).length).toBeGreaterThanOrEqual(5);

    await env.close();
  });

  it("returns validation errors for invalid tool input without calling providers", async () => {
    const provider = mockProvider("reply");
    const url = await startTestServer();
    const env = await connectClient(url);
    const result = await env.client.callTool({
      name: "consensus",
      arguments: { prompt: "" },
    });
    expect(result.isError).toBe(true);
    expect(provider.calls()).toBe(0);

    await env.close();
  });

  it("forwards engine progress notifications during a consensus run", async () => {
    const provider = mockProvider("reply");
    const url = await startTestServer();
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
    expect(provider.calls()).toBeGreaterThan(0);

    await env.close();
  });

  it("client cancellation that closes the transport aborts the upstream provider fetches", async () => {
    // Contract: cancelling a call stops spending the operator's provider
    // budget. Asserting only that the client promise rejects (as this test
    // originally did) passes even if the server keeps the upstream calls
    // running — the client SDK rejects locally on abort.
    //
    // Stateless limitation (by design): the SDK client's per-call AbortSignal
    // sends notifications/cancelled on a *new* POST, which in stateless mode
    // reaches a fresh server that cannot see the in-flight call (request ids
    // are client-chosen and collide across callers, so a cross-request
    // registry would let one caller cancel another's work). The connection
    // closing is the cancellation channel; closing the transport delivers it.
    const provider = mockProvider("hang");
    const url = await startTestServer();
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
    await provider.waitForCalls(2);
    expect(provider.aborts()).toBe(0);

    controller.abort();
    await expect(callPromise).rejects.toThrow();
    await env.close();

    await eventually(() => provider.aborts() === 2);
  });

  it("a raw TCP disconnect mid-call aborts the upstream provider fetches", async () => {
    // Contract: the Node adapter maps a dropped connection (no MCP
    // cancellation notification at all) onto upstream aborts.
    const provider = mockProvider("hang");
    const url = new URL(await startTestServer());
    const body = JSON.stringify(toolCall(9, { prompt: "drop me", maxRounds: 1, judge: false }));
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: { ...MCP_HEADERS, "content-length": Buffer.byteLength(body) },
    });
    req.on("error", () => undefined);
    req.end(body);

    await provider.waitForCalls(2);
    expect(provider.aborts()).toBe(0);

    req.destroy();

    await eventually(() => provider.aborts() === 2);
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
