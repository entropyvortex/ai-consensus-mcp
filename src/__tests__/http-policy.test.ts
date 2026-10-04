// Request-policy contracts for the HTTP transport (Web handler; the Node
// server is a thin adapter over the same handler).

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpHandler } from "../http/handler.js";
import { INITIALIZE, makeConfig, mcpRequest } from "./http-fixtures.js";

const NO_AUTH = { auth: { apiKey: undefined } } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stateless method handling", () => {
  it.each(["GET", "DELETE", "PUT", "OPTIONS"])(
    "%s on the MCP path returns 405 with Allow: POST",
    async (method) => {
      // Contract: a stateless server offers no standalone SSE stream and no
      // session to delete — a GET must not pin a server + open stream.
      const handler = createHttpHandler(makeConfig(), NO_AUTH);
      const res = await handler(
        mcpRequest(undefined, { method, headers: { accept: "text/event-stream" } }),
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32000);
    },
  );
});

describe("/health", () => {
  it("returns only a liveness status — no auth posture or panel shape", async () => {
    // Contract: unauthenticated probes learn nothing an attacker could use to
    // find open instances (authRequired) or size the panel.
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const res = await handler(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("matches {mcpPath}/health when mcpPath has a trailing slash", async () => {
    const handler = createHttpHandler(makeConfig(), { ...NO_AUTH, mcpPath: "/mcp/" });
    const res = await handler(new Request("http://localhost/mcp/health"));
    expect(res.status).toBe(200);
    const mcp = await handler(mcpRequest(INITIALIZE, { url: "http://localhost/mcp" }));
    expect(mcp.status).toBe(200);
  });
});
