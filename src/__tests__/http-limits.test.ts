// Cost-amplification contracts: one HTTP request must not fan out into
// unbounded provider spend, and concurrent spend is capped per handler.

import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.restoreAllMocks();
});

interface RpcError {
  id: unknown;
  error: { code: number; message: string };
}

describe("JSON-RPC batches", () => {
  it("rejects a batch containing tools/call without calling any provider", async () => {
    // Contract: one POST cannot start N consensus runs (SDK allows 100/batch).
    const provider = mockProvider("reply");
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const res = await handler(
      mcpRequest([toolCall(1, { prompt: "a" }), toolCall(2, { prompt: "b" })], {
        headers: { "mcp-protocol-version": "2025-03-26" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as RpcError;
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toMatch(/batch/i);
    expect(provider.calls()).toBe(0);
  });

  it("still accepts batches without tools/call (2025-03-26 compatibility)", async () => {
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const res = await handler(
      mcpRequest(
        [
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { jsonrpc: "2.0", id: 2, method: "ping" },
        ],
        { headers: { "mcp-protocol-version": "2025-03-26" } },
      ),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"tools"');
  });
});

describe("tool-argument ceilings", () => {
  it("rejects a prompt longer than maxPromptChars before any provider call", async () => {
    // Contract: prompt size (input tokens × participants × rounds) is bounded.
    const provider = mockProvider("reply");
    const handler = createHttpHandler(makeConfig(), { ...NO_AUTH, maxPromptChars: 100 });
    const res = await handler(mcpRequest(toolCall(5, { prompt: "x".repeat(101) })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as RpcError;
    expect(body.id).toBe(5);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/prompt.*100/);
    expect(provider.calls()).toBe(0);
  });

  it("rejects maxOutputTokens above the ceiling before any provider call", async () => {
    const provider = mockProvider("reply");
    const handler = createHttpHandler(makeConfig(), { ...NO_AUTH, maxOutputTokens: 4096 });
    const res = await handler(
      mcpRequest(
        toolCall(6, { prompt: "ok", maxOutputTokens: 100_000_000 }, "consensus_code_review"),
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as RpcError;
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/maxOutputTokens.*4096/);
    expect(provider.calls()).toBe(0);
  });

  it("accepts arguments within the ceilings", async () => {
    mockProvider("reply");
    const handler = createHttpHandler(makeConfig(), {
      ...NO_AUTH,
      maxPromptChars: 100,
      maxOutputTokens: 4096,
    });
    const res = await handler(
      mcpRequest(toolCall(7, { prompt: "x".repeat(100), maxOutputTokens: 4096, judge: false })),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"result"');
  });
});

describe("in-flight tool-call cap", () => {
  it("returns 429 over the cap and frees the slot when a call ends", async () => {
    // Contract: concurrent tool calls per handler never exceed the cap; a
    // cancelled call releases its slot.
    const provider = mockProvider("hang");
    const handler = createHttpHandler(makeConfig(), { ...NO_AUTH, maxConcurrentToolCalls: 1 });

    const first = await handler(mcpRequest(toolCall(1, { prompt: "slow", judge: false })));
    expect(first.status).toBe(200);
    await provider.waitForCalls(2);

    const second = await handler(mcpRequest(toolCall(2, { prompt: "rejected", judge: false })));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();
    const body = (await second.json()) as RpcError;
    expect(body.id).toBe(2);
    expect(body.error.message).toMatch(/concurrent/i);
    expect(provider.calls()).toBe(2);

    // Non-tool traffic is never throttled by the cap.
    const init = await handler(mcpRequest(INITIALIZE));
    expect(init.status).toBe(200);

    await first.body!.cancel();
    await eventually(() => provider.aborts() === 2);

    const third = await handler(mcpRequest(toolCall(3, { prompt: "admitted", judge: false })));
    expect(third.status).toBe(200);
    await third.body!.cancel();
  });

  it("releases the slot after a call completes normally", async () => {
    mockProvider("reply");
    const handler = createHttpHandler(makeConfig(), { ...NO_AUTH, maxConcurrentToolCalls: 1 });
    for (let i = 0; i < 3; i++) {
      const res = await handler(mcpRequest(toolCall(i, { prompt: `run ${i}`, judge: false })));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('"result"');
    }
  });

  it("releases the slot when the tool call fails validation", async () => {
    const handler = createHttpHandler(makeConfig(), { ...NO_AUTH, maxConcurrentToolCalls: 1 });
    for (let i = 0; i < 3; i++) {
      const res = await handler(mcpRequest(toolCall(i, { prompt: "" })));
      expect(res.status).toBe(200);
      await res.text();
    }
  });
});

describe("request body", () => {
  it("rejects bodies over the size cap with 413", async () => {
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const res = await handler(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { pad: "x".repeat(5_000_000) },
      }),
    );
    expect(res.status).toBe(413);
  });

  it("returns a JSON-RPC parse error for invalid JSON", async () => {
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const res = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as RpcError;
    expect(body.error.code).toBe(-32700);
  });
});
