// Node-server policy: bind-address safety and loopback Host validation.

import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoopbackHost } from "../http/host.js";
import { startNodeHttpServer, type NodeHttpServerHandle } from "../http/node-server.js";
import { INITIALIZE, MCP_HEADERS, makeConfig } from "./http-fixtures.js";

let handle: NodeHttpServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

function post(port: number, headers: Record<string, string>): Promise<number> {
  const body = JSON.stringify(INITIALIZE);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { ...MCP_HEADERS, "content-length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function boundPort(h: NodeHttpServerHandle): number {
  const addr = h.server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

describe("isLoopbackHost", () => {
  it.each([
    "127.0.0.1",
    "127.8.9.10",
    "localhost",
    "LOCALHOST",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "::",
    "192.168.1.5",
    "203.0.113.7",
    "example.com",
    "localhost.evil.com",
    "128.0.0.1",
    "127.0.0.256",
    "",
  ])("%s is not loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("loopback Host validation (DNS rebinding)", () => {
  it("rejects a foreign Host by default on a loopback bind", async () => {
    handle = await startNodeHttpServer({
      config: makeConfig(),
      port: 0,
      auth: { apiKey: undefined },
    });
    const port = boundPort(handle);
    expect(await post(port, { host: "attacker.example" })).toBe(403);
    expect(await post(port, { host: `127.0.0.1:${port}` })).toBe(200);
    expect(await post(port, { host: `localhost:${port}` })).toBe(200);
  });

  it("adds operator-supplied allowedHosts to the loopback defaults", async () => {
    handle = await startNodeHttpServer({
      config: makeConfig(),
      port: 0,
      auth: { apiKey: undefined },
      allowedHosts: ["consensus.example.com"],
    });
    const port = boundPort(handle);
    expect(await post(port, { host: "consensus.example.com" })).toBe(200);
    expect(await post(port, { host: `localhost:${port}` })).toBe(200);
    expect(await post(port, { host: "attacker.example" })).toBe(403);
  });

  it("rejects a browser Origin unless allow-listed", async () => {
    handle = await startNodeHttpServer({
      config: makeConfig(),
      port: 0,
      auth: { apiKey: undefined },
      allowedOrigins: ["http://localhost:6274"],
    });
    const port = boundPort(handle);
    expect(await post(port, { origin: "http://attacker.example" })).toBe(403);
    expect(await post(port, { origin: "http://localhost:6274" })).toBe(200);
  });
});

describe("bind-address safety (no open public endpoint by default)", () => {
  it.each(["0.0.0.0", "::", "192.0.2.10", "consensus.example.com"])(
    "refuses to start on non-loopback %s without CONSENSUS_HTTP_API_KEY",
    async (host) => {
      // Contract: a non-loopback bind without an endpoint key never listens —
      // otherwise anyone who finds the URL spends the operator's provider keys.
      await expect(
        startNodeHttpServer({ config: makeConfig(), host, port: 0, auth: { apiKey: undefined } }),
      ).rejects.toThrow(/CONSENSUS_HTTP_API_KEY[\s\S]*--allow-unauthenticated/);
    },
  );

  it("starts on a non-loopback bind when an endpoint key is set", async () => {
    handle = await startNodeHttpServer({
      config: makeConfig(),
      host: "0.0.0.0",
      port: 0,
      auth: { apiKey: "k".repeat(32) },
    });
    expect(handle.server.listening).toBe(true);
  });

  it("starts open on a non-loopback bind only with allowUnauthenticated, and warns loudly", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      handle = await startNodeHttpServer({
        config: makeConfig(),
        host: "0.0.0.0",
        port: 0,
        auth: { apiKey: undefined },
        allowUnauthenticated: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(handle.server.listening).toBe(true);
    expect(writes.join("")).toMatch(/WARNING[\s\S]*without CONSENSUS_HTTP_API_KEY/);
  });
});
