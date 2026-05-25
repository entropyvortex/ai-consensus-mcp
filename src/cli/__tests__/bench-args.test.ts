// Contract tests for the bench CLI argument parser. We test the parser in
// isolation (no I/O, no provider calls) — the full bench command is
// exercised separately via dispatch tests.

import { describe, expect, it } from "vitest";
import { parseBenchArgs, type BenchArgs } from "../bench.js";

function ok(r: BenchArgs | Error): BenchArgs {
  if (r instanceof Error) throw r;
  return r;
}

describe("parseBenchArgs — basic flags", () => {
  it("returns default values for empty argv", () => {
    const a = ok(parseBenchArgs([]));
    expect(a.help).toBe(false);
    expect(a.configPath).toBeUndefined();
    expect(a.panelId).toBeUndefined();
    expect(a.runs).toBe(1);
    expect(a.baseSeed).toBeUndefined();
    expect(a.includeFullResults).toBe(false);
    expect(a.quiet).toBe(false);
  });

  it("parses --help / -h", () => {
    expect(ok(parseBenchArgs(["--help"])).help).toBe(true);
    expect(ok(parseBenchArgs(["-h"])).help).toBe(true);
  });

  it("parses --list-panels", () => {
    expect(ok(parseBenchArgs(["--list-panels"])).listPanels).toBe(true);
  });

  it("parses --quiet / -q", () => {
    expect(ok(parseBenchArgs(["--quiet"])).quiet).toBe(true);
    expect(ok(parseBenchArgs(["-q"])).quiet).toBe(true);
  });

  it("parses --include-full-results", () => {
    expect(ok(parseBenchArgs(["--include-full-results"])).includeFullResults).toBe(true);
  });
});

describe("parseBenchArgs — value-bearing flags", () => {
  it("parses --config and --config=", () => {
    expect(ok(parseBenchArgs(["--config", "/p"])).configPath).toBe("/p");
    expect(ok(parseBenchArgs(["-c", "/p2"])).configPath).toBe("/p2");
    expect(ok(parseBenchArgs(["--config=/p3"])).configPath).toBe("/p3");
  });

  it("parses --panel and --panel=", () => {
    expect(ok(parseBenchArgs(["--panel", "architecture_v2"])).panelId).toBe("architecture_v2");
    expect(ok(parseBenchArgs(["-p", "code_review_v2"])).panelId).toBe("code_review_v2");
    expect(ok(parseBenchArgs(["--panel=security_redteam"])).panelId).toBe("security_redteam");
  });

  it("parses --runs and --runs=", () => {
    expect(ok(parseBenchArgs(["--runs", "5"])).runs).toBe(5);
    expect(ok(parseBenchArgs(["-n", "3"])).runs).toBe(3);
  });

  it("parses --seed", () => {
    expect(ok(parseBenchArgs(["--seed", "42"])).baseSeed).toBe(42);
    expect(ok(parseBenchArgs(["--seed", "0"])).baseSeed).toBe(0);
  });

  it("parses --baseline-model and --baseline-provider", () => {
    const a = ok(
      parseBenchArgs(["--baseline-model", "gpt-5", "--baseline-provider", "openai"]),
    );
    expect(a.baselineModelId).toBe("gpt-5");
    expect(a.baselineProviderId).toBe("openai");
  });

  it("parses --filter-tag", () => {
    expect(ok(parseBenchArgs(["--filter-tag", "security"])).filterTag).toBe("security");
  });

  it("parses --output / --output=", () => {
    expect(ok(parseBenchArgs(["--output", "/o.json"])).outputPath).toBe("/o.json");
    expect(ok(parseBenchArgs(["--output=/o2.json"])).outputPath).toBe("/o2.json");
  });

  it("parses --cases / --cases=", () => {
    expect(ok(parseBenchArgs(["--cases", "/cases.json"])).casesPath).toBe("/cases.json");
    expect(ok(parseBenchArgs(["--cases=/cases2.json"])).casesPath).toBe("/cases2.json");
  });
});

describe("parseBenchArgs — failures", () => {
  it("rejects unknown flags", () => {
    expect(parseBenchArgs(["--nonsense"])).toBeInstanceOf(Error);
  });

  it("rejects a flag with no value", () => {
    expect(parseBenchArgs(["--config"])).toBeInstanceOf(Error);
    expect(parseBenchArgs(["--panel"])).toBeInstanceOf(Error);
    expect(parseBenchArgs(["--runs"])).toBeInstanceOf(Error);
  });

  it("rejects --runs with non-integer or non-positive value", () => {
    expect(parseBenchArgs(["--runs", "abc"])).toBeInstanceOf(Error);
    expect(parseBenchArgs(["--runs", "0"])).toBeInstanceOf(Error);
    expect(parseBenchArgs(["--runs", "-3"])).toBeInstanceOf(Error);
  });

  it("rejects --seed with non-integer or negative value", () => {
    expect(parseBenchArgs(["--seed", "abc"])).toBeInstanceOf(Error);
    expect(parseBenchArgs(["--seed", "-1"])).toBeInstanceOf(Error);
  });
});
