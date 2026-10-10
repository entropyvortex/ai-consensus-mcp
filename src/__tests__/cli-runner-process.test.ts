// Real child-process contracts for the CLI runner.
// The fakes in cli-backend.test.ts cannot see pipe chunking, signal
// handling, or stdio inheritance, so every contract here spawns a real
// executable written to a temp dir. Unix only: the runner refuses win32.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCallRequest } from "ai-consensus-core";
import { createConsensusCaller } from "../caller.js";
import { CliGate, type ReadinessState } from "../cli-backend/index.js";
import { killLiveCliChildren, runOracle, spawnCaptured } from "../cli-backend/runner.js";
import type { ResolvedCliProvider } from "../config.js";

let dir = "";
const spawnedPids = new Set<number>();

function isAlive(pid: number): boolean {
  const stat = `/proc/${pid}/stat`;
  if (existsSync("/proc/self/stat")) {
    if (!existsSync(stat)) return false;
    try {
      // The state follows the parenthesised command; a zombie is already dead.
      const state = readFileSync(stat, "utf8").split(") ")[1]?.charAt(0);
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

function notes(): string[] {
  const file = join(dir, "notes");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
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

function caller(bin: string, opts: { timeoutMs: number; gate?: CliGate; killGraceMs?: number }) {
  const cache = new Map<string, ReadinessState>([["grok-sub", { ok: true }]]);
  return createConsensusCaller({
    providers: { "grok-sub": provider(bin, opts.timeoutMs) },
    providerByParticipant: { p1: "grok-sub", p2: "grok-sub" },
    cliGate: opts.gate ?? new CliGate(2),
    readinessCache: cache,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir },
    log: () => undefined,
    ...(opts.killGraceMs !== undefined ? { killGraceMs: opts.killGraceMs } : {}),
  });
}

// Ignores SIGTERM, notes it, and notes any earlier fake that is still alive.
const STUBBORN = `
  process.on("SIGTERM", () => note("term " + process.pid));
  for (const line of fs.readFileSync(DIR + "/pids", "utf8").trim().split("\\n")) {
    const pid = Number(line);
    if (pid === process.pid) continue;
    try { process.kill(pid, 0); note("overlap " + pid); } catch {}
  }
  note("ready " + process.pid);
  setInterval(() => {}, 1000);
`;

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

  it("kills a SIGTERM-ignoring child before the gate admits the next one", async () => {
    // Contract: the in-flight cap bounds live processes, not pending
    // promises. With CliGate(1), a child that ignores SIGTERM is SIGKILLed
    // after the grace period and reaped before the second seat spawns.
    const bin = fakeBin("stubborn", STUBBORN);
    const call = caller(bin, { timeoutMs: 300, gate: new CliGate(1), killGraceMs: 100 });
    const started = Date.now();
    const results = await Promise.allSettled([call(request("p1")), call(request("p2"))]);
    const elapsed = Date.now() - started;
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "ETIMEDOUT" });
    }
    const seen = notes();
    expect(seen.filter((line) => line.startsWith("ready"))).toHaveLength(2);
    expect(seen.filter((line) => line.startsWith("term"))).toHaveLength(2);
    expect(seen.filter((line) => line.startsWith("overlap"))).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(2 * (300 + 100));
    for (const pid of pids()) expect(isAlive(pid)).toBe(false);
  });

  it("rejects an abort only after the SIGTERM-ignoring child is dead", async () => {
    // Contract: AbortError is delivered once the child has exited, so the
    // caller's gate release and scratch-dir removal never race a live child.
    const bin = fakeBin("stubborn-abort", STUBBORN);
    const ac = new AbortController();
    const call = caller(bin, { timeoutMs: 5_000, killGraceMs: 150 });
    const pending = call({ ...request("p1"), signal: ac.signal });
    await waitFor(() => notes().some((line) => line.startsWith("ready")));
    ac.abort();
    let aliveAtReject: boolean | undefined;
    await pending.catch((err: unknown) => {
      aliveAtReject = pids().some(isAlive);
      expect(err).toMatchObject({ name: "AbortError" });
    });
    expect(aliveAtReject).toBe(false);
    expect(notes().some((line) => line.startsWith("term"))).toBe(true);
  });

  it("returns the answer when a grandchild keeps stdout open after exit", async () => {
    // Contract: the seat settles on the child's exit plus a short stream
    // grace, so a leftover helper that inherited stdout cannot turn a valid
    // exit-0 answer into ETIMEDOUT. The leftover is killed with the group.
    const bin = fakeBin(
      "grandchild",
      `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: ["ignore", "inherit", "inherit"] });
      fs.writeFileSync(DIR + "/grandchild", String(g.pid));
      process.stdout.write(JSON.stringify({ structured_output: { answer: "held open", confidence: 81 } }));
      process.exit(0);
      `,
    );
    const started = Date.now();
    const res = await caller(bin, { timeoutMs: 2_000 })(request("p1"));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(res.content).toContain("held open");
    expect(res.content).toContain("CONFIDENCE: 81");
    const grandchild = Number(readFileSync(join(dir, "grandchild"), "utf8"));
    spawnedPids.add(grandchild);
    await waitFor(() => !isAlive(grandchild));
  });

  it("kills live CLI process groups on server shutdown and unhooks after", async () => {
    // Contract: while a CLI child runs, the runner holds exit, SIGINT and
    // SIGTERM hooks that SIGKILL every live group, so a server shutdown
    // never orphans a grok run. The hooks are removed once no child is live.
    const hooks = () => ["exit", "SIGINT", "SIGTERM"].map((event) => process.listenerCount(event));
    const baseline = hooks();
    const bin = fakeBin("long", `note("ready " + process.pid); setInterval(() => {}, 1000);`);
    const pending = caller(bin, { timeoutMs: 10_000 })(request("p1"));
    await waitFor(() => notes().some((line) => line.startsWith("ready")));
    expect(hooks()).toEqual(baseline.map((n) => n + 1));
    killLiveCliChildren();
    await expect(pending).rejects.toThrow(/signal SIGKILL/);
    for (const pid of pids()) expect(isAlive(pid)).toBe(false);
    expect(hooks()).toEqual(baseline);
  });
});

describe("cli runner after a capture failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops accumulating and does not re-kill on later chunks", async () => {
    // Contract: once a call has failed, further output is neither buffered
    // nor answered with another kill. One SIGTERM, one SIGKILL escalation.
    const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
    Object.defineProperty(child, "pid", { value: 515151 });
    child.kill = () => true;
    const kills: string[] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
      kills.push(`${pid}:${String(signal)}`);
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      return true;
    }) as typeof process.kill);
    const pending: (() => void)[] = [];
    const run = spawnCaptured({
      driver: "fake",
      bin: "fake",
      argv: [],
      env: {},
      stdin: "ignore",
      timeoutMs: 60_000,
      maxCaptureChars: 8,
      installUrl: "",
      loginCommand: "",
      spawnImpl: () => child,
      scheduleTimeout: (ms, fire) => {
        if (ms !== 60_000) pending.push(fire);
        return () => undefined;
      },
    });
    const settled = run.catch((err: unknown) => err);
    child.stdout.write("0123456789");
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 20; i += 1) child.stdout.write("more output that must be dropped");
    await new Promise((resolve) => setImmediate(resolve));
    expect(kills).toEqual(["-515151:SIGTERM"]);
    expect(child.stdout.listenerCount("data")).toBe(0);
    pending.shift()?.();
    const err = await settled;
    expect(String(err)).toMatch(/exceeded 8 characters/);
    expect(kills).toEqual(["-515151:SIGTERM", "-515151:SIGKILL"]);
  });
});
