// Readiness-probe contracts: failures never stick, concurrent probes for one
// provider share a single spawn, and startup probes run in parallel.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ModelCallRequest } from "ai-consensus-core";
import { createConsensusCaller } from "../caller.js";
import { CliGate, probeCliProviders, type ReadinessState } from "../cli-backend/index.js";
import type { ResolvedCliProvider } from "../config.js";

type Fake = ChildProcess & { stdout: PassThrough; stderr: PassThrough };

function fake(): Fake {
  const child = new EventEmitter() as Fake;
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
  child.kill = () => true;
  return child;
}

function exitWith(child: Fake, code: number, stdout = ""): void {
  child.stdout.end(stdout);
  child.stderr.end();
  child.emit("close", code, null);
}

function enoent(child: Fake): void {
  const err = Object.assign(new Error("spawn grok ENOENT"), { code: "ENOENT" });
  child.emit("error", err);
}

function provider(id = "grok-sub"): ResolvedCliProvider {
  return {
    id,
    transport: "cli",
    driver: "grok",
    bin: "grok",
    timeoutMs: 5_000,
    authPath: "/auth.json",
  };
}

function request(participantId: string): ModelCallRequest {
  return {
    participantId,
    modelId: "grok-4",
    round: 1,
    phase: "initial-analysis",
    system: "s",
    user: "u",
    temperature: 0.7,
    maxOutputTokens: 100,
  };
}

const ANSWER = JSON.stringify({ structured_output: { answer: "ok", confidence: 66 } });

describe("cli readiness", () => {
  it("re-probes after a failure so a fresh install or login works without restart", async () => {
    // Contract: a failed readiness probe is not cached. After the user
    // installs grok (or runs grok login), the next call probes again.
    const cache = new Map<string, ReadinessState>();
    let installed = false;
    const versionSpawns: number[] = [];
    const spawnImpl = (_bin: string, args: readonly string[]) => {
      const child = fake();
      if (args.includes("--version")) versionSpawns.push(1);
      queueMicrotask(() => {
        if (!installed) enoent(child);
        else exitWith(child, 0, args.includes("--version") ? "1.0.46\n" : ANSWER);
      });
      return child;
    };
    const note = await probeCliProviders({
      providers: { "grok-sub": provider() },
      env: { HOME: "/home/t" },
      cache,
      spawnImpl,
      accessImpl: () => Promise.resolve(),
    });
    expect(note).toContain("was not found");

    installed = true;
    const call = createConsensusCaller({
      providers: { "grok-sub": provider() },
      providerByParticipant: { p1: "grok-sub" },
      cliGate: new CliGate(2),
      readinessCache: cache,
      env: { HOME: "/home/t" },
      spawnImpl,
      accessImpl: () => Promise.resolve(),
      log: () => undefined,
    });
    const res = await call(request("p1"));
    expect(res.content).toContain("CONFIDENCE: 66");
    expect(versionSpawns).toHaveLength(2);
    expect(cache.get("grok-sub")).toEqual({ ok: true });
  });

  it("shares one probe spawn among concurrent first calls", async () => {
    // Contract: N seats that miss the cache at once start one --version.
    const cache = new Map<string, ReadinessState>();
    let versionSpawns = 0;
    const call = createConsensusCaller({
      providers: { "grok-sub": provider() },
      providerByParticipant: { a: "grok-sub", b: "grok-sub", c: "grok-sub" },
      cliGate: new CliGate(3),
      readinessCache: cache,
      env: { HOME: "/home/t" },
      spawnImpl: (_bin, args) => {
        const child = fake();
        const version = args.includes("--version");
        if (version) versionSpawns += 1;
        setTimeout(() => exitWith(child, 0, version ? "1.0.46\n" : ANSWER), 20);
        return child;
      },
      accessImpl: () => Promise.resolve(),
      log: () => undefined,
    });
    const results = await Promise.all([call(request("a")), call(request("b")), call(request("c"))]);
    expect(results).toHaveLength(3);
    expect(versionSpawns).toBe(1);
  });

  it("runs startup probes for several providers in parallel", async () => {
    // Contract: one slow --version does not serialize the others. Each fake
    // exits only once both probes have spawned; a sequential loop times the
    // first one out instead.
    const live: Fake[] = [];
    const note = await probeCliProviders({
      providers: { one: provider("one"), two: provider("two") },
      env: { HOME: "/home/t" },
      cache: new Map(),
      accessImpl: () => Promise.resolve(),
      scheduleTimeout: (ms, fire) => {
        const timer = setTimeout(fire, ms === 15_000 ? 300 : ms);
        return () => clearTimeout(timer);
      },
      spawnImpl: () => {
        const child = fake();
        live.push(child);
        if (live.length === 2) {
          for (const c of live) queueMicrotask(() => exitWith(c, 0, "1.0.46\n"));
        }
        return child;
      },
    });
    expect(note).toContain("provider=one driver=grok ok");
    expect(note).toContain("provider=two driver=grok ok");
    expect(note.indexOf("provider=one")).toBeLessThan(note.indexOf("provider=two"));
  });
});
