// Real child-process contracts for the CLI runner.
// The fakes in cli-backend.test.ts cannot see pipe chunking, signal
// handling, or stdio inheritance, so every contract here spawns a real
// executable written to a temp dir. Unix only: the runner refuses win32.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelCallRequest } from "ai-consensus-core";
import { createConsensusCaller } from "../caller.js";
import { CliGate, type ReadinessState } from "../cli-backend/index.js";
import { runOracle } from "../cli-backend/runner.js";
import type { ResolvedCliProvider } from "../config.js";

let dir = "";
const spawnedPids = new Set<number>();

/** Writes `<dir>/<name>` that execs node on `source`. Fake writes pids to `<dir>/pids`. */
function fakeBin(name: string, source: string): string {
  const js = join(dir, `${name}.cjs`);
  const prelude = [
    `const fs = require("node:fs");`,
    `const DIR = ${JSON.stringify(dir)};`,
    `fs.appendFileSync(DIR + "/pids", process.pid + "\\n");`,
    `function note(line) { fs.appendFileSync(DIR + "/notes", line + "\\n"); }`,
    `if (process.argv.includes("--version")) { process.stdout.write("1.0.46\\n"); process.exit(0); }`,
  ].join("\n");
  writeFileSync(js, `${prelude}\n${source}\n`);
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function pids(): number[] {
  const file = join(dir, "pids");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => Number(line))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function provider(bin: string, timeoutMs: number): ResolvedCliProvider {
  return { id: "grok-sub", transport: "cli", driver: "grok", bin, timeoutMs, authPath: undefined };
}

function request(participantId: string): ModelCallRequest {
  return {
    participantId,
    modelId: "grok-4",
    round: 1,
    phase: "initial-analysis",
    system: "Be precise.",
    user: "Should we ship?",
    temperature: 0.7,
    maxOutputTokens: 100,
  };
}

function caller(bin: string, opts: { timeoutMs: number; gate?: CliGate }) {
  const cache = new Map<string, ReadinessState>([["grok-sub", { ok: true }]]);
  return createConsensusCaller({
    providers: { "grok-sub": provider(bin, opts.timeoutMs) },
    providerByParticipant: { p1: "grok-sub", p2: "grok-sub" },
    cliGate: opts.gate ?? new CliGate(2),
    readinessCache: cache,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir },
    log: () => undefined,
  });
}

describe.skipIf(process.platform === "win32")("cli runner with real child processes", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-runner-test-"));
  });

  afterEach(() => {
    for (const pid of [...pids(), ...spawnedPids]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    spawnedPids.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  it("decodes a multibyte character split across two stdout chunks", async () => {
    // Contract: output bytes are decoded as one UTF-8 stream, so a character
    // whose bytes straddle a pipe read boundary is not replaced by U+FFFD.
    const bin = fakeBin(
      "split",
      `
      const body = Buffer.from(JSON.stringify({ structured_output: { answer: "price \\u20ac42 ok", confidence: 70 } }), "utf8");
      const cut = body.indexOf(Buffer.from("\\u20ac", "utf8")) + 1;
      process.stdout.write(body.subarray(0, cut));
      setTimeout(() => { process.stdout.write(body.subarray(cut)); }, 80);
      `,
    );
    const res = await caller(bin, { timeoutMs: 5_000 })(request("p1"));
    expect(res.content).not.toContain("�");
    expect(res.content).toContain("price €42 ok");
  });

  it("survives EPIPE when the child exits without reading an 8 MB stdin", async () => {
    // Contract: a stdin write error (EPIPE) is never an uncaught exception
    // that takes the server down; the seat rejects with the exit status.
    const run = runOracle({
      driver: "pipe-test",
      bin: process.execPath,
      providerId: "pipe-sub",
      participantId: "p1",
      round: 1,
      system: "s",
      user: "u",
      timeoutMs: 5_000,
      parentEnv: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      deps: { log: () => undefined },
      installUrl: "https://example.invalid",
      loginCommand: "login",
      stdin: "pipe",
      stdinText: "x".repeat(8_000_000),
      disableGrokAutoupdater: false,
      ownedFiles: [],
      buildArgv: () => ["-e", "process.exit(3)"],
    });
    await expect(run).rejects.toThrow(/exited 3/);
  });
});
