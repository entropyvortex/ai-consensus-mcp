import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCallRequest } from "ai-consensus-core";
import { createOpenAICompatibleCaller } from "../adapter.js";
import { createConsensusCaller } from "../caller.js";
import type { ResolvedCliProvider, ResolvedHttpProvider } from "../config.js";

function httpProvider(): ResolvedHttpProvider {
  return {
    id: "openai",
    transport: "http",
    baseUrl: "https://api.test.local",
    apiKey: "k",
    extraHeaders: {},
  };
}

function cliProvider(driver: ResolvedCliProvider["driver"] = "grok"): ResolvedCliProvider {
  return {
    id: "grok-sub",
    transport: "cli",
    driver,
    bin: driver,
    timeoutMs: 120_000,
    authPath: undefined,
  };
}

function request(participantId: string): ModelCallRequest {
  return {
    participantId,
    modelId: "m",
    round: 1,
    phase: "initial-analysis",
    system: "s",
    user: "u",
    temperature: 0.7,
    maxOutputTokens: 100,
  };
}

function sse(content: string): Response {
  const encoder = new TextEncoder();
  const text = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, statusText: "OK" });
}

describe("createConsensusCaller", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("routes HTTP through the existing adapter", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse("ok"));
    const caller = createConsensusCaller({
      providers: { openai: httpProvider() },
      providerByParticipant: { p1: "openai" },
    });
    const res = await caller(request("p1"));
    expect(res.content).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws a seat error when the CLI driver is not registered", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse("ok"));
    const caller = createConsensusCaller({
      providers: { openai: httpProvider(), "grok-sub": cliProvider("claude") },
      providerByParticipant: { httpSeat: "openai", cliSeat: "grok-sub" },
    });
    let caught: unknown;
    try {
      await caller(request("cliSeat"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).not.toBe("AbortError");
    expect((caught as Error).message).toBe('cli driver "claude" is not registered');
    const res = await caller(request("httpSeat"));
    expect(res.content).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("honors CONSENSUS_DISABLE_CLI=1 before any driver lookup and still runs HTTP", async () => {
    vi.stubEnv("CONSENSUS_DISABLE_CLI", "1");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse("still-http"));
    const caller = createConsensusCaller({
      providers: { openai: httpProvider(), "grok-sub": cliProvider() },
      providerByParticipant: { httpSeat: "openai", cliSeat: "grok-sub" },
    });
    await expect(caller(request("cliSeat"))).rejects.toThrow(
      "CLI transports are disabled by CONSENSUS_DISABLE_CLI",
    );
    const res = await caller(request("httpSeat"));
    expect(res.content).toBe("still-http");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("createOpenAICompatibleCaller rejects a CLI provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse("nope"));
    const caller = createOpenAICompatibleCaller({
      providers: { "grok-sub": cliProvider() },
      providerByParticipant: { p1: "grok-sub" },
    });
    await expect(caller(request("p1"))).rejects.toThrow(
      'provider "grok-sub" is transport cli; use createConsensusCaller',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
