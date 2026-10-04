// Packaging contracts: what consumers can import, which SDK the HTTP
// transport needs, and that contributors don't install a deploy toolchain.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, unknown>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

function floor(range: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) throw new Error(`unparseable range ${range}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe("package.json", () => {
  it("lets tooling resolve ai-consensus-mcp/package.json through the exports map", () => {
    // Self-reference resolution goes through `exports`, exactly like a consumer.
    expect(require.resolve("ai-consensus-mcp/package.json")).toMatch(/package\.json$/);
  });

  it("declares an MCP SDK floor no older than the version the HTTP transport is tested on", () => {
    // WebStandardStreamableHTTPServerTransport does not exist before 1.25,
    // so the old ^1.13.0 floor admitted SDKs that cannot load src/http. The
    // HTTP path is exercised against 1.32; the floor tracks that.
    const [major, minor] = floor(pkg.dependencies["@modelcontextprotocol/sdk"]!);
    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(32);
  });

  it("does not install wrangler for every contributor; deploy scripts fetch it on demand", () => {
    expect(pkg.devDependencies["wrangler"]).toBeUndefined();
    expect(pkg.scripts["deploy:cloudflare"]).toMatch(
      /^node scripts\/assert-wrangler-free-tier\.mjs && npx -y wrangler@4 deploy$/,
    );
    expect(pkg.scripts["preview:cloudflare"]).toMatch(/npx -y wrangler@4 dev/);
  });
});

describe("wrangler.toml", () => {
  it("enables request-signal passthrough so client disconnects abort provider calls", () => {
    // Without enable_request_signal, workerd never tells the Worker that the
    // caller left, and an abandoned consensus run bills to completion.
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    const flags = /^compatibility_flags\s*=\s*\[(.*)\]/m.exec(toml)?.[1] ?? "";
    expect(flags).toContain('"enable_request_signal"');
    expect(flags).toContain('"nodejs_compat"');
  });
});
