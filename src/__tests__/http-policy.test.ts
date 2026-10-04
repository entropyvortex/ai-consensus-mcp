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

describe("DNS-rebinding protection (Host / Origin)", () => {
  it("rejects a Host outside allowedHosts with 403", async () => {
    // Contract: a page on attacker.example that rebinds its DNS to 127.0.0.1
    // sends Host: attacker.example — the request must not reach the tools.
    const handler = createHttpHandler(makeConfig(), {
      ...NO_AUTH,
      allowedHosts: ["localhost", "127.0.0.1"],
    });
    const res = await handler(mcpRequest(INITIALIZE, { headers: { host: "attacker.example" } }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Host/);
  });

  it("accepts an allow-listed Host on any port unless the entry pins one", async () => {
    const handler = createHttpHandler(makeConfig(), {
      ...NO_AUTH,
      allowedHosts: ["localhost", "api.example.com:8443"],
    });
    const ok = await handler(mcpRequest(INITIALIZE, { headers: { host: "LOCALHOST:3000" } }));
    expect(ok.status).toBe(200);
    const pinned = await handler(
      mcpRequest(INITIALIZE, { headers: { host: "api.example.com:8443" } }),
    );
    expect(pinned.status).toBe(200);
    const wrongPort = await handler(
      mcpRequest(INITIALIZE, { headers: { host: "api.example.com:9999" } }),
    );
    expect(wrongPort.status).toBe(403);
  });

  it("checks the request URL authority when no Host header is present", async () => {
    // Contract: a Request built in code (embedding, Deno/Bun, tests) carries
    // no Host header; its URL authority is what a server runtime derives from
    // Host, so allowedHosts applies to it instead of rejecting every call.
    const handler = createHttpHandler(makeConfig(), { ...NO_AUTH, allowedHosts: ["localhost"] });
    const ok = await handler(mcpRequest(INITIALIZE, { url: "http://localhost:3000/mcp" }));
    expect(ok.status).toBe(200);
    const bad = await handler(mcpRequest(INITIALIZE, { url: "http://attacker.example/mcp" }));
    expect(bad.status).toBe(403);
  });

  it("skips Host validation when allowedHosts is unset (public Workers default)", async () => {
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    const res = await handler(mcpRequest(INITIALIZE, { headers: { host: "anything.example" } }));
    expect(res.status).toBe(200);
  });

  it("rejects any Origin by default — browsers are not expected callers", async () => {
    // Contract: a present, non-allow-listed Origin is refused (MCP spec:
    // servers MUST validate Origin). Server-side clients send no Origin.
    const handler = createHttpHandler(makeConfig(), NO_AUTH);
    for (const origin of ["http://attacker.example", "null"]) {
      const res = await handler(mcpRequest(INITIALIZE, { headers: { origin } }));
      expect(res.status).toBe(403);
    }
  });

  it("accepts requests without an Origin header (non-browser clients)", async () => {
    const handler = createHttpHandler(makeConfig(), { ...NO_AUTH, allowedOrigins: [] });
    const res = await handler(mcpRequest(INITIALIZE));
    expect(res.status).toBe(200);
  });

  it("accepts allow-listed Origins, compared after URL normalisation", async () => {
    const handler = createHttpHandler(makeConfig(), {
      ...NO_AUTH,
      allowedOrigins: ["http://localhost:6274/"],
    });
    const ok = await handler(
      mcpRequest(INITIALIZE, { headers: { origin: "http://localhost:6274" } }),
    );
    expect(ok.status).toBe(200);
    const other = await handler(
      mcpRequest(INITIALIZE, { headers: { origin: "http://localhost:9999" } }),
    );
    expect(other.status).toBe(403);
  });

  it("leaves /health reachable regardless of Host (load-balancer probes)", async () => {
    const handler = createHttpHandler(makeConfig(), { ...NO_AUTH, allowedHosts: ["localhost"] });
    const res = await handler(
      new Request("http://localhost/health", { headers: { host: "10.0.0.5:3000" } }),
    );
    expect(res.status).toBe(200);
  });
});
