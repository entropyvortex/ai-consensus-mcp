// Contracts for `serve` flag parsing (HTTP mode options).

import { describe, expect, it } from "vitest";
import { parseServeArgs, type ServeArgs } from "../serve.js";

function parse(argv: string[]): ServeArgs {
  const out = parseServeArgs(argv);
  if (out instanceof Error) throw out;
  return out;
}

describe("parseServeArgs — HTTP flags", () => {
  it("parses comma-separated --allowed-hosts / --allowed-origins in both flag forms", () => {
    const a = parse([
      "--http",
      "--allowed-hosts",
      "a.example, b.example:8443,",
      "--allowed-origins=http://localhost:6274",
    ]);
    expect(a.allowedHosts).toEqual(["a.example", "b.example:8443"]);
    expect(a.allowedOrigins).toEqual(["http://localhost:6274"]);
  });

  it("leaves allow-lists undefined when the flags are absent", () => {
    const a = parse(["--http"]);
    expect(a.allowedHosts).toBeUndefined();
    expect(a.allowedOrigins).toBeUndefined();
  });

  it("supports -c and --config= and normalises --path without a leading slash", () => {
    expect(parse(["-c", "x.json"]).configPath).toBe("x.json");
    expect(parse(["--config=y.json"]).configPath).toBe("y.json");
    expect(parse(["--path", "rpc"]).path).toBe("/rpc");
  });

  it("rejects unknown flags and missing values", () => {
    expect(parseServeArgs(["--nope"])).toBeInstanceOf(Error);
    expect(parseServeArgs(["--allowed-hosts"])).toBeInstanceOf(Error);
  });
});

describe("parseServeArgs — --allow-unauthenticated", () => {
  it("defaults to false and is set by the flag", () => {
    expect(parse(["--http"]).allowUnauthenticated).toBe(false);
    expect(parse(["--http", "--allow-unauthenticated"]).allowUnauthenticated).toBe(true);
  });
});

describe("parseServeArgs — spend limits", () => {
  it("parses --max-concurrent-tool-calls / --max-prompt-chars / --max-output-tokens", () => {
    const a = parse([
      "--max-concurrent-tool-calls",
      "2",
      "--max-prompt-chars=5000",
      "--max-output-tokens",
      "2048",
    ]);
    expect(a.maxConcurrentToolCalls).toBe(2);
    expect(a.maxPromptChars).toBe(5000);
    expect(a.maxOutputTokens).toBe(2048);
  });

  it.each(["0", "-1", "1.5", "4abc", ""])("rejects --max-concurrent-tool-calls %j", (v) => {
    expect(parseServeArgs([`--max-concurrent-tool-calls=${v}`])).toBeInstanceOf(Error);
  });
});

describe("parseServeArgs — --port", () => {
  it("accepts plain decimal ports in range", () => {
    expect(parse(["--port", "0"]).port).toBe(0);
    expect(parse(["--port=65535"]).port).toBe(65535);
  });

  it.each(["3000abc", "1e3", "-1", "65536", "0x50", " 80"])("rejects --port %j", (v) => {
    // Contract: a typo never silently binds a different port.
    expect(parseServeArgs(["--port", v])).toBeInstanceOf(Error);
  });
});
