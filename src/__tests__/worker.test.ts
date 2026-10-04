// Contracts for the Cloudflare Workers example entry (examples/cloudflare/worker.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIALIZE, mcpRequest, mockProvider, toolCall } from "./http-fixtures.js";

const CONFIG_JSON = JSON.stringify({
  providers: {
    test: { baseUrl: "https://api.test.local/v1", apiKeyEnv: "WORKER_TEST_PROVIDER_KEY" },
  },
  participants: [
    { id: "a", provider: "test", modelId: "m1", personaId: "pessimist" },
    { id: "b", provider: "test", modelId: "m2", personaId: "first-principles" },
  ],
  defaults: { maxRounds: 1, earlyStop: false, useJudge: false },
});
const KEY = "worker-test-endpoint-key";
const AUTH = { authorization: `Bearer ${KEY}` };

interface WorkerModule {
  default: {
    fetch: (request: Request, env: Record<string, string | undefined>) => Promise<Response>;
  };
}

// Non-literal specifier: the worker lives outside tsconfig's rootDir (src/),
// so tsc must not pull it into the program; vitest resolves it at runtime.
const WORKER_ENTRY = "../../examples/cloudflare/worker.js";

async function loadWorker(): Promise<WorkerModule["default"]> {
  vi.resetModules();
  const mod = (await import(WORKER_ENTRY)) as WorkerModule;
  return mod.default;
}

beforeEach(() => {
  vi.stubEnv("WORKER_TEST_PROVIDER_KEY", "dummy");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("worker error logging (CodeQL clear-text logging fix)", () => {
  it("logs the error message so a broken secret is diagnosable, never the stack or object", async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const worker = await loadWorker();
    const res = await worker.fetch(mcpRequest(INITIALIZE, { headers: AUTH }), {
      CONSENSUS_CONFIG_JSON: "{ not json",
      CONSENSUS_HTTP_API_KEY: KEY,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { message: "Internal server error" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toHaveLength(1);
    const line = errors[0]![0] as string;
    expect(typeof line).toBe("string");
    expect(line).toMatch(/worker error: .*CONSENSUS_CONFIG_JSON is not valid JSON/);
    expect(line).not.toMatch(/\n\s+at /);
  });

  it("names the missing endpoint key without echoing any secret", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    const worker = await loadWorker();
    const res = await worker.fetch(mcpRequest(INITIALIZE), { CONSENSUS_CONFIG_JSON: CONFIG_JSON });
    expect(res.status).toBe(500);
    expect(errors.join("\n")).toMatch(/CONSENSUS_HTTP_API_KEY is required/);
    expect(errors.join("\n")).not.toContain("dummy");
  });
});

describe("worker request handling", () => {
  it("serves MCP with the endpoint key and refuses without it", async () => {
    const worker = await loadWorker();
    const env = { CONSENSUS_CONFIG_JSON: CONFIG_JSON, CONSENSUS_HTTP_API_KEY: KEY };
    expect((await worker.fetch(mcpRequest(INITIALIZE), env)).status).toBe(401);
    const ok = await worker.fetch(mcpRequest(INITIALIZE, { headers: AUTH }), env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('"result"');
  });

  it("shares one in-flight cap across requests in an isolate", async () => {
    // Contract: the cap is per isolate, not per request — so the handler (and
    // its limiter) must be reused, not rebuilt on every fetch.
    const provider = mockProvider("hang");
    const worker = await loadWorker();
    const env = {
      CONSENSUS_CONFIG_JSON: CONFIG_JSON,
      CONSENSUS_HTTP_API_KEY: KEY,
      CONSENSUS_HTTP_MAX_CONCURRENT_TOOL_CALLS: "1",
    };
    const first = await worker.fetch(
      mcpRequest(toolCall(1, { prompt: "slow" }), { headers: AUTH }),
      env,
    );
    expect(first.status).toBe(200);
    await provider.waitForCalls(2);
    const second = await worker.fetch(
      mcpRequest(toolCall(2, { prompt: "next" }), { headers: AUTH }),
      env,
    );
    expect(second.status).toBe(429);
    await first.body!.cancel();
  });

  it("applies CONSENSUS_HTTP_ALLOWED_ORIGINS / _ALLOWED_HOSTS", async () => {
    const worker = await loadWorker();
    const env = {
      CONSENSUS_CONFIG_JSON: CONFIG_JSON,
      CONSENSUS_HTTP_API_KEY: KEY,
      CONSENSUS_HTTP_ALLOWED_ORIGINS: "https://app.example",
      CONSENSUS_HTTP_ALLOWED_HOSTS: "mcp.example.com",
    };
    const req = (headers: Record<string, string>) =>
      worker.fetch(
        mcpRequest(INITIALIZE, { headers: { ...AUTH, host: "mcp.example.com", ...headers } }),
        env,
      );
    expect((await req({ origin: "https://app.example" })).status).toBe(200);
    expect((await req({ origin: "https://evil.example" })).status).toBe(403);
    expect((await req({ host: "evil.example" })).status).toBe(403);
  });

  it("rejects a malformed limit var with a diagnosable 500", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    const worker = await loadWorker();
    const res = await worker.fetch(mcpRequest(INITIALIZE, { headers: AUTH }), {
      CONSENSUS_CONFIG_JSON: CONFIG_JSON,
      CONSENSUS_HTTP_API_KEY: KEY,
      CONSENSUS_HTTP_MAX_PROMPT_CHARS: "lots",
    });
    expect(res.status).toBe(500);
    expect(errors.join("\n")).toMatch(/CONSENSUS_HTTP_MAX_PROMPT_CHARS must be a positive integer/);
  });
});
