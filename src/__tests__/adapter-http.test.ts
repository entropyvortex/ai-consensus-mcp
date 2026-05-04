// Focused unit tests for the OpenAI-compatible HTTP ModelCaller — the
// non-sampling branch of the adapter. Mocks `globalThis.fetch` and
// constructs SSE-formatted ReadableStreams to exercise the streaming
// parser without hitting a real provider.
//
// Sampling-path tests live in adapter-sampling.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCallRequest } from "ai-consensus-core";
import { createOpenAICompatibleCaller } from "../adapter.js";
import type { ResolvedProvider } from "../config.js";

function buildProvider(over: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: "test",
    baseUrl: "https://api.test.local",
    apiKey: "k_secret",
    extraHeaders: {},
    ...over,
  };
}

function buildRequest(over: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    participantId: "p1",
    modelId: "model-x",
    round: 1,
    phase: "initial-analysis",
    system: "system prompt",
    user: "user prompt",
    temperature: 0.7,
    maxOutputTokens: 1000,
    ...over,
  };
}

/** Build a fake SSE Response: each payload becomes one `data: …\n\n` line, terminated by `data: [DONE]`. */
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

describe("createOpenAICompatibleCaller", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("assembles streamed deltas into content and surfaces usage when present", async () => {
    fetchSpy.mockResolvedValue(
      makeSSEResponse([
        { choices: [{ delta: { content: "hello " } }] },
        { choices: [{ delta: { content: "world" } }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]),
    );
    const tokens: string[] = [];
    const caller = createOpenAICompatibleCaller({
      providers: { test: buildProvider() },
      providerByParticipant: { p1: "test" },
    });
    const res = await caller(buildRequest({ onToken: (t) => tokens.push(t) }));
    expect(res.content).toBe("hello world");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(tokens).toEqual(["hello ", "world"]);
  });

  it("forwards bearer auth, extra headers, model, and chat messages on the fetch call", async () => {
    fetchSpy.mockResolvedValue(makeSSEResponse([{ choices: [{ delta: { content: "ok" } }] }]));
    const caller = createOpenAICompatibleCaller({
      providers: {
        test: buildProvider({ extraHeaders: { "x-org": "acme" } }),
      },
      providerByParticipant: { p1: "test" },
    });
    await caller(buildRequest());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.test.local/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k_secret");
    expect(headers["x-org"]).toBe("acme");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.model).toBe("model-x");
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(1000);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" },
    ]);
  });

  it("computes total_tokens from prompt+completion when the provider omits it", async () => {
    fetchSpy.mockResolvedValue(
      makeSSEResponse([
        { choices: [{ delta: { content: "x" } }] },
        { usage: { prompt_tokens: 7, completion_tokens: 3 } },
      ]),
    );
    const caller = createOpenAICompatibleCaller({
      providers: { test: buildProvider() },
      providerByParticipant: { p1: "test" },
    });
    const res = await caller(buildRequest());
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it("reassembles a JSON line that arrives split across two fetch chunks", async () => {
    const encoder = new TextEncoder();
    const fullLine = `data: ${JSON.stringify({ choices: [{ delta: { content: "split" } }] })}\n\n`;
    const half = Math.floor(fullLine.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(fullLine.slice(0, half)));
        c.enqueue(encoder.encode(fullLine.slice(half) + "data: [DONE]\n\n"));
        c.close();
      },
    });
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }));
    const caller = createOpenAICompatibleCaller({
      providers: { test: buildProvider() },
      providerByParticipant: { p1: "test" },
    });
    const res = await caller(buildRequest());
    expect(res.content).toBe("split");
  });

  it("silently skips data: lines whose payload fails to JSON.parse", async () => {
    const encoder = new TextEncoder();
    const text =
      `data: not-json\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n` +
      `data: [DONE]\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(text));
        c.close();
      },
    });
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }));
    const caller = createOpenAICompatibleCaller({
      providers: { test: buildProvider() },
      providerByParticipant: { p1: "test" },
    });
    const res = await caller(buildRequest());
    expect(res.content).toBe("ok");
  });

  it("throws with status, statusText, and a truncated body on a non-OK HTTP response", async () => {
    fetchSpy.mockResolvedValue(
      new Response("oops something went wrong here", {
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    const caller = createOpenAICompatibleCaller({
      providers: { test: buildProvider() },
      providerByParticipant: { p1: "test" },
    });
    let caught: unknown;
    try {
      await caller(buildRequest());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/HTTP 401 Unauthorized/);
    expect(msg).toMatch(/oops something went wrong/);
    expect(msg).toContain("test:"); // provider id prefix
  });

  it("throws an empty-response error when the stream finishes without any content delta", async () => {
    fetchSpy.mockResolvedValue(
      makeSSEResponse([{ usage: { prompt_tokens: 1, completion_tokens: 0 } }]),
    );
    const caller = createOpenAICompatibleCaller({
      providers: { test: buildProvider() },
      providerByParticipant: { p1: "test" },
    });
    await expect(caller(buildRequest())).rejects.toThrow(/empty response/);
  });

  it("throws when the participant has no provider mapping in providerByParticipant", async () => {
    const caller = createOpenAICompatibleCaller({
      providers: { test: buildProvider() },
      providerByParticipant: {},
    });
    await expect(caller(buildRequest())).rejects.toThrow(/no provider mapping/);
  });

  it("throws when the participant's mapped provider id wasn't loaded into providers", async () => {
    const caller = createOpenAICompatibleCaller({
      providers: { test: buildProvider() },
      providerByParticipant: { p1: "ghost" },
    });
    await expect(caller(buildRequest())).rejects.toThrow(/was not loaded/);
  });
});
