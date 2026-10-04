// Contract tests for the Web Standard handler (`createHttpHandler`) — the
// entry point Cloudflare Workers / Deno / Bun deploys run. These drive real
// MCP traffic through the handler, not just /health: the original PR shipped
// a handler that returned empty 200 bodies for every MCP request because the
// per-request server was closed before its SSE body was consumed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler } from "../http/handler.js";
import {
  INITIALIZE,
  eventually,
  makeConfig,
  mcpRequest,
  mockProvider,
  toolCall,
} from "./http-fixtures.js";

const NO_AUTH = { auth: { apiKey: undefined } } as const;

/** SDK client whose fetch is routed straight into the Web handler. */
async function connectToHandler(handler: (r: Request) => Promise<Response>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (url, init) => handler(new Request(url, init)),
  });
  const client = new Client({ name: "web-handler-test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createHttpHandler — MCP traffic (Workers path)", () => {
  it("answers initialize with a non-empty JSON-RPC result", async () => {
    // Contract: the handshake response body carries the initialize result.
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const res = await handler(mcpRequest(INITIALIZE));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"result"');
    expect(text).toContain('"serverInfo"');
  });

  it("serves tools/list through a real SDK client", async () => {
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const client = await connectToHandler(handler);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("consensus");
    await client.close();
  });

  it("completes a tools/call and returns the full consensus result", async () => {
    // Contract: long-running tool calls are not cut off — the body stays
    // open until the tool's final JSON-RPC response has been written.
    const provider = mockProvider("reply");
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const client = await connectToHandler(handler);
    const result = await client.callTool({
      name: "consensus",
      arguments: { prompt: "Should we adopt event sourcing?", maxRounds: 1, judge: false },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as { type: string; text?: string }[])
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text.length).toBeGreaterThan(0);
    expect(provider.calls()).toBeGreaterThan(0);
    await client.close();
  });

  it("aborts upstream provider calls when the client cancels the response body", async () => {
    // Contract: a disconnecting caller stops spending the operator's
    // provider budget — cancelling the response aborts in-flight fetches.
    const provider = mockProvider("hang");
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const res = await handler(
      mcpRequest(toolCall(7, { prompt: "cancel me", maxRounds: 1, judge: false })),
    );
    expect(res.status).toBe(200);
    await provider.waitForCalls(2);
    expect(provider.aborts()).toBe(0);

    await res.body!.cancel();

    await eventually(() => provider.aborts() === 2);
  });

  it("aborts upstream provider calls when the request signal fires", async () => {
    // Runtimes that surface client disconnects via Request.signal (Node
    // adapter, Workers with request-signal passthrough) get the same contract.
    const provider = mockProvider("hang");
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const controller = new AbortController();
    const base = mcpRequest(toolCall(8, { prompt: "disconnect me", maxRounds: 1, judge: false }));
    const res = await handler(new Request(base, { signal: controller.signal }));
    expect(res.status).toBe(200);
    await provider.waitForCalls(2);
    expect(provider.aborts()).toBe(0);

    controller.abort();

    await eventually(() => provider.aborts() === 2);
  });
});

describe("createHttpHandler — disconnect detection on write-driven runtimes", () => {
  it("emits an SSE keep-alive within 5s of an idle tool call", async () => {
    // Contract: workerd only notices a vanished client when a chunk is
    // written. A keep-alive every ≤5s bounds how long an abandoned call keeps
    // spending before Request.signal / cancel tears it down.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const provider = mockProvider("hang");
      const handler = createHttpHandler(makeConfig(), NO_AUTH);
      const res = await handler(mcpRequest(toolCall(11, { prompt: "idle", judge: false })));
      await provider.waitForCalls(2);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      const pump = (async () => {
        while (!seen.includes(": keepalive")) {
          const { done, value } = await reader.read();
          if (done) break;
          seen += decoder.decode(value);
        }
      })();
      vi.advanceTimersByTime(5_000);
      await pump;
      expect(seen).toContain(": keepalive");
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
