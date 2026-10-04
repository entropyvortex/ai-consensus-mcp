// Contract: `serve --http --allow-cli` routes every per-request MCP server's
// CLI seats through the one process-wide CliGate the caller passes in, so the
// in-flight cap holds across concurrent HTTP requests.

import { describe, expect, it } from "vitest";
import type { LoadedConfig } from "../config.js";
import { CliGate, type ReadinessState } from "../cli-backend/index.js";
import { createHttpHandler } from "../http/handler.js";
import { makeConfig, mcpRequest, toolCall } from "./http-fixtures.js";

class CountingGate extends CliGate {
  acquired = 0;
  override async acquire(signal?: AbortSignal): Promise<void> {
    this.acquired += 1;
    return super.acquire(signal);
  }
}

function cliConfig(): LoadedConfig {
  return makeConfig({
    providers: {
      "grok-sub": {
        id: "grok-sub",
        transport: "cli",
        driver: "grok",
        bin: "grok",
        timeoutMs: 5_000,
        authPath: undefined,
      },
    },
    providerByParticipant: { p1: "grok-sub", p2: "grok-sub" },
  });
}

describe("HTTP handler and the process CLI gate", () => {
  it("passes mcpServerDeps to every per-request server so CLI seats take the shared gate", async () => {
    const gate = new CountingGate(2);
    // A cached success skips the readiness probe; the blocked spawn makes each
    // seat fail right after it has taken (and released) the gate.
    const readinessCache = new Map<string, ReadinessState>([["grok-sub", { ok: true }]]);
    const handler = createHttpHandler(cliConfig(), {
      auth: { apiKey: undefined },
      mcpServerDeps: {
        cliGate: gate,
        readinessCache,
        spawnImpl: () => {
          throw new Error("spawn blocked in test");
        },
        log: () => undefined,
      },
    });

    for (const id of [1, 2]) {
      const res = await handler(mcpRequest(toolCall(id, { prompt: "gate check" })));
      expect(res.status).toBe(200);
      await res.text();
    }
    // Two seats per request, two requests, one gate.
    expect(gate.acquired).toBe(4);
  });
});
