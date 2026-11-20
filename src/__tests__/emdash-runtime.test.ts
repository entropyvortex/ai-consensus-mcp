import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildChildEnv, currentDepth, DEPTH_ENV } from "../cli-backend/env.js";
import { nestedServerRefusal, parseServeArgs, runServe } from "../cli/serve.js";
import { detectInstalledClis, keylessStarterConfig } from "../cli/keyless.js";
import {
  RawConfigSchema,
  loadConfig,
  loadConfigFromJson,
  loadEnvFile,
  missingKeyMessage,
  resolveConfigFromRaw,
  resolveEnvFilePath,
} from "../config.js";
import { runTestCommand } from "../repo/test-command.js";

// Contracts for running inside an agent host such as Emdash: a juror
// cannot start this server again (depth guard); keys can come from an
// owner-only env file; a missing key names the variable, the provider and
// the allowlist cause; the wizard can build a keyless panel from CLIs on
// PATH; the opt-in test command never runs through a shell.

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "acm-runtime-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("depth guard", () => {
  it("increments the depth for every child", () => {
    expect(buildChildEnv({})[DEPTH_ENV]).toBe("1");
    expect(buildChildEnv({ [DEPTH_ENV]: "1" })[DEPTH_ENV]).toBe("2");
    expect(currentDepth({ [DEPTH_ENV]: "junk" })).toBe(0);
  });

  it("refuses to serve when started by a juror", async () => {
    expect(nestedServerRefusal({})).toBeUndefined();
    expect(nestedServerRefusal({ [DEPTH_ENV]: "1" })).toMatch(
      /refusing to start inside a consensus juror/,
    );
    vi.stubEnv(DEPTH_ENV, "1");
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (writes.push(String(c)), true));
    expect(await runServe(["--config", "/nonexistent.json"])).toBe(3);
    expect(writes.join("")).toContain(DEPTH_ENV);
  });
});

describe("serve flags", () => {
  it("parses --allow-test-command and refuses it with --http", async () => {
    const parsed = parseServeArgs(["--allow-test-command", "--config", "x"]);
    expect(parsed).toMatchObject({ allowTestCommand: true });
    expect(parseServeArgs(["--config", "x"])).toMatchObject({ allowTestCommand: false });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await runServe(["--http", "--allow-test-command", "--config", "/nonexistent.json"]),
    ).toBe(2);
  });
});

describe("envFile", () => {
  const file = (name: string, text: string, mode: number) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    chmodSync(p, mode);
    return p;
  };

  it("parses KEY=VALUE lines, comments, export and quotes", async () => {
    const p = file("ok.env", "# keys\nexport A=1\nB = \"two words\"\nC='3'\n\nD=\n", 0o600);
    expect({ ...(await loadEnvFile(p)) }).toEqual({ A: "1", B: "two words", C: "3", D: "" });
  });

  it("refuses group- or world-accessible files and bad lines, without echoing values", async () => {
    const open = file("open.env", "SECRET=hunter2\n", 0o644);
    await expect(loadEnvFile(open)).rejects.toThrow(/mode 644.*chmod 600/);
    const group = file("group.env", "SECRET=hunter2\n", 0o640);
    await expect(loadEnvFile(group)).rejects.toThrow(/mode 640/);
    const bad = file("bad.env", "SECRET hunter2\n", 0o600);
    await expect(loadEnvFile(bad)).rejects.toThrow("line 1 is not KEY=VALUE");
    await expect(loadEnvFile(bad)).rejects.not.toThrow(/hunter2/);
    await expect(loadEnvFile(join(dir, "missing.env"))).rejects.toThrow(/could not be read/);
  });

  it("feeds provider keys at load time; the environment wins over the file", async () => {
    file("keys.env", "ACM_TEST_KEY=from-file\n", 0o600);
    const config = {
      envFile: "keys.env",
      providers: { p: { baseUrl: "https://x.test/v1", apiKeyEnv: "ACM_TEST_KEY" } },
      participants: [
        { id: "a", provider: "p", modelId: "m", personaId: "pessimist" },
        { id: "b", provider: "p", modelId: "m", personaId: "domain-expert" },
      ],
    };
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    const fromFile = await loadConfig(path, { env: {} });
    expect(fromFile.providers["p"]).toMatchObject({ apiKey: "from-file" });
    const fromEnv = await loadConfig(path, { env: { ACM_TEST_KEY: "from-env" } });
    expect(fromEnv.providers["p"]).toMatchObject({ apiKey: "from-env" });
    expect(() => loadConfigFromJson(JSON.stringify(config), "worker", { env: {} })).toThrow(
      /"envFile" is only supported when the config is loaded from a file/,
    );
  });

  it("resolves ~/, absolute and config-relative paths", () => {
    expect(resolveEnvFilePath("/a/b.env", "/c/config.json")).toBe("/a/b.env");
    expect(resolveEnvFilePath("b.env", "/c/config.json")).toBe("/c/b.env");
    expect(resolveEnvFilePath("~/b.env", "/c/config.json")).toMatch(/\/b\.env$/);
  });
});

describe("missing key message", () => {
  it("names the variable, the provider and the allowlist cause, and suggests envFile", () => {
    const m = missingKeyMessage("openai", "OPENAI_API_KEY");
    expect(m).toContain('provider "openai" requires env var OPENAI_API_KEY but it is not set.');
    expect(m).toContain("allowlisted environment (generalaction/emdash#3103)");
    expect(m).toContain('"envFile"');
    expect(missingKeyMessage("openai", "K", "~/.keys")).toContain('envFile "~/.keys"');
  });

  it("is what resolve throws", () => {
    const raw = RawConfigSchema.parse({
      providers: { p: { baseUrl: "https://x.test/v1", apiKeyEnv: "ACM_ABSENT" } },
      participants: [
        { id: "a", provider: "p", modelId: "m", personaId: "pessimist" },
        { id: "b", provider: "p", modelId: "m", personaId: "domain-expert" },
      ],
    });
    expect(() => resolveConfigFromRaw(raw, "t", { env: {} })).toThrow(
      missingKeyMessage("p", "ACM_ABSENT"),
    );
  });
});

describe("keyless panel", () => {
  it("detects claude, grok and codex executables on PATH without running them", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["codex", "claude", "notes.txt"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 99\n");
      chmodSync(join(bin, name), name === "notes.txt" ? 0o644 : 0o755);
    }
    const found = await detectInstalledClis({ PATH: `/nonexistent:${bin}` });
    expect(found).toEqual([
      { driver: "claude", path: join(bin, "claude") },
      { driver: "codex", path: join(bin, "codex") },
    ]);
    expect(await detectInstalledClis({ PATH: "" })).toEqual([]);
  });

  it("builds a valid keyless config that resolves with no API keys", () => {
    for (const drivers of [["claude"], ["claude", "grok"], ["grok", "claude", "codex"]] as const) {
      const raw = RawConfigSchema.parse(keylessStarterConfig(drivers));
      const cfg = resolveConfigFromRaw(raw, "keyless", { env: {} });
      expect(cfg.participants.length).toBeGreaterThanOrEqual(3);
      expect(Object.values(cfg.providers).every((p) => p.transport === "cli")).toBe(true);
      expect(cfg.judge?.providerId).toBe(`${drivers[0]}-cli`);
    }
    expect(keylessStarterConfig(["codex"]).participants[0]!.modelId).toBe("default");
    expect(keylessStarterConfig(["grok"]).participants[0]!.modelId).toBe("default");
    expect(keylessStarterConfig(["claude"]).participants[0]!.modelId).toBe("opus");
    expect(() => keylessStarterConfig([])).toThrow();
  });
});

describe("runTestCommand — EXECUTES REPOSITORY CODE, opt-in only", () => {
  const node = process.execPath;

  it("maps exit 0 to passed and other exits to failed, with an output tail", async () => {
    expect(
      await runTestCommand({
        argv: [node, "-e", "console.log('ok')"],
        cwd: dir,
        timeoutMs: 20_000,
      }),
    ).toEqual({
      name: "testCommand",
      status: "passed",
      output: "exit 0\nok",
    });
    const failed = await runTestCommand({
      argv: [node, "-e", "console.error('2 failing');process.exit(2)"],
      cwd: dir,
      timeoutMs: 20_000,
    });
    expect(failed).toMatchObject({ status: "failed", output: "exit 2\n2 failing" });
  });

  it("reports a timeout or a missing program as unknown", async () => {
    const slow = await runTestCommand({
      argv: [node, "-e", "setTimeout(() => {}, 30000)"],
      cwd: dir,
      timeoutMs: 300,
    });
    expect(slow.status).toBe("unknown");
    expect(slow.output).toMatch(/^timed out after 300 ms/);
    const missing = await runTestCommand({
      argv: [join(dir, "no-such-program")],
      cwd: dir,
      timeoutMs: 1000,
    });
    expect(missing).toMatchObject({ status: "unknown" });
    expect(missing.output).toMatch(/could not start/);
  });

  it("runs without a shell and sets the depth guard for anything it spawns", async () => {
    const out = await runTestCommand({
      argv: [
        node,
        "-e",
        "console.log(process.env.AI_CONSENSUS_MCP_DEPTH, process.argv[1])",
        "$(echo injected)",
      ],
      cwd: dir,
      timeoutMs: 20_000,
      env: { PATH: process.env["PATH"] },
    });
    expect(out.output).toBe("exit 0\n1 $(echo injected)");
  });
});
