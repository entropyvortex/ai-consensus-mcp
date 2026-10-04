// Shared fixtures for the HTTP transport tests. Not a test file itself
// (vitest only collects *.test.ts); excluded from coverage via __tests__.

import { vi } from "vitest";
import type { LoadedConfig } from "../config.js";
import { PERSONAS } from "../personas.js";

export const PROVIDER_HOST = "api.test.local";

export function makeConfig(overrides: Partial<LoadedConfig> = {}): LoadedConfig {
  const base: LoadedConfig = {
    sourcePath: "/fake/http-test",
    providers: {
      test: {
        id: "test",
        transport: "http",
        baseUrl: `https://${PROVIDER_HOST}`,
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
  };
  return { ...base, ...overrides };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function sseProviderResponse(text: string): Response {
  const encoder = new TextEncoder();
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` + "data: [DONE]\n\n";
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(body));
        c.close();
      },
    }),
    { status: 200 },
  );
}

export interface ProviderMock {
  /** Number of upstream provider requests started. */
  calls: () => number;
  /** Number of upstream provider requests whose AbortSignal fired. */
  aborts: () => number;
  /** Resolves once `n` upstream requests have started. */
  waitForCalls: (n: number) => Promise<void>;
  /** Release every hanging upstream request with a successful reply. */
  releaseAll: () => void;
}

/**
 * Replace global fetch for the fake provider host. `mode: "reply"` answers
 * immediately; `mode: "hang"` holds each request until aborted or released.
 * Requests to any other host fall through to the real fetch (unused here).
 */
export function mockProvider(mode: "reply" | "hang"): ProviderMock {
  const realFetch = globalThis.fetch.bind(globalThis);
  let calls = 0;
  let aborts = 0;
  const pending: (() => void)[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  const notify = () => {
    for (const w of [...waiters]) {
      if (calls >= w.n) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (!requestUrl(input).includes(PROVIDER_HOST)) return realFetch(input, init);
    calls += 1;
    notify();
    if (mode === "reply") return sseProviderResponse("Analysis.\n\nCONFIDENCE: 72");
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        aborts += 1;
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.push(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(sseProviderResponse("Late analysis.\n\nCONFIDENCE: 60"));
      });
    });
  });

  return {
    calls: () => calls,
    aborts: () => aborts,
    waitForCalls: (n) =>
      calls >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve })),
    releaseAll: () => {
      for (const release of pending.splice(0)) release();
    },
  };
}

/** Poll until `predicate` holds (bounded) — avoids fixed sleeps. */
export async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
} as const;

export const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
} as const;

export function toolCall(id: number, args: Record<string, unknown>, name = "consensus") {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

export function mcpRequest(
  body: unknown,
  init: { url?: string; headers?: Record<string, string>; method?: string } = {},
): Request {
  const method = init.method ?? "POST";
  return new Request(init.url ?? "http://localhost/mcp", {
    method,
    headers: { ...MCP_HEADERS, ...init.headers },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
