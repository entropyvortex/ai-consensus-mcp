import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMain } from "../main.js";

interface CapturedStderr {
  output: string[];
  restore: () => void;
}

function captureStderr(): CapturedStderr {
  const output: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  return {
    output,
    restore: () => {
      spy.mockRestore();
      process.stderr.write = original;
    },
  };
}

describe("runMain — top-level flags", () => {
  let captured: CapturedStderr;
  beforeEach(() => {
    captured = captureStderr();
  });
  afterEach(() => {
    captured.restore();
  });

  it("--version prints the version and returns 0", async () => {
    const code = await runMain(["--version"]);
    expect(code).toBe(0);
    expect(captured.output.join("")).toMatch(/\d+\.\d+\.\d+/);
  });

  it("-v is the same as --version", async () => {
    const code = await runMain(["-v"]);
    expect(code).toBe(0);
    expect(captured.output.join("")).toMatch(/\d+\.\d+\.\d+/);
  });

  it("--help prints top-level help and returns 0", async () => {
    const code = await runMain(["--help"]);
    expect(code).toBe(0);
    const out = captured.output.join("");
    expect(out).toContain("ai-consensus-mcp");
    expect(out).toContain("Usage:");
    expect(out).toContain("install");
  });

  it("no args prints help and returns 2 (operator forgot to specify)", async () => {
    const code = await runMain([]);
    expect(code).toBe(2);
    expect(captured.output.join("")).toContain("Usage:");
  });

  it("unknown subcommand returns 2", async () => {
    const code = await runMain(["totally-not-a-command"]);
    expect(code).toBe(2);
    expect(captured.output.join("")).toMatch(/unknown command/);
  });

  it("install --help prints install help and returns 0", async () => {
    const code = await runMain(["install", "--help"]);
    expect(code).toBe(0);
    expect(captured.output.join("")).toContain("ai-consensus-mcp install");
  });

  it("install with no --config returns 2 with a clear error", async () => {
    const code = await runMain(["install"]);
    expect(code).toBe(2);
    expect(captured.output.join("")).toMatch(/install requires --config/);
  });

  it("serve --help prints serve help and returns 0", async () => {
    const code = await runMain(["serve", "--help"]);
    expect(code).toBe(0);
    expect(captured.output.join("")).toContain("ai-consensus-mcp serve");
  });
});

describe("runMain — backward-compat dispatch", () => {
  let captured: CapturedStderr;
  beforeEach(() => {
    captured = captureStderr();
  });
  afterEach(() => {
    captured.restore();
  });

  it("a leading flag (no subcommand) routes to serve and surfaces the missing-config error", async () => {
    // `ai-consensus-mcp --bogus` — no subcommand, starts with a flag, so
    // dispatcher routes to serve, which then complains about the unknown flag.
    const code = await runMain(["--bogus"]);
    expect(code).toBe(2);
    // Either serve's "Unknown argument" or its missing-config path triggers — both
    // confirm dispatch routed to serve, not "unknown command".
    const out = captured.output.join("");
    expect(out).toMatch(/serve|Unknown argument/);
    expect(out).not.toMatch(/^.*unknown command/i);
  });
});
