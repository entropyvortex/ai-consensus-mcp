// Unit tests for wireEngineProgress — the engine-event → MCP progress
// notification bridge. The real ConsensusEngine is heavyweight; we use
// a duck-typed mock with the same on/off surface and emit events
// directly to drive each handler.

import { describe, expect, it, vi } from "vitest";
import type { ConsensusEngine } from "ai-consensus-core";
import { wireEngineProgress, type SendNotification } from "../progress.js";

interface MockEngine {
  handlers: Map<string, ((...args: unknown[]) => void)[]>;
  on: (name: string, fn: (...args: unknown[]) => void) => MockEngine;
  off: (name: string, fn: (...args: unknown[]) => void) => MockEngine;
  emit: (name: string, payload: unknown) => void;
}

function createMockEngine(): MockEngine {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const engine: MockEngine = {
    handlers,
    on(name, fn) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
      return engine;
    },
    off(name, fn) {
      const list = handlers.get(name) ?? [];
      handlers.set(
        name,
        list.filter((h) => h !== fn),
      );
      return engine;
    },
    emit(name, payload) {
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
  };
  return engine;
}

interface SentNotification {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}

function setup(maxRounds = 4, judgeEnabled = true) {
  const engine = createMockEngine();
  const sent: SentNotification[] = [];
  const sendNotification: SendNotification = vi.fn((n) => {
    sent.push(n as SentNotification);
    return Promise.resolve();
  });
  const detach = wireEngineProgress({
    engine: engine as unknown as ConsensusEngine,
    sendNotification,
    progressToken: "tok-1",
    maxRounds,
    judgeEnabled,
  });
  return { engine, sent, detach, sendNotification };
}

describe("wireEngineProgress", () => {
  it("counts the judge slot in `total` when judgeEnabled=true", () => {
    const { engine, sent } = setup(3, true);
    engine.emit("roundStart", { round: 1, label: "Initial Analysis", blind: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params.progressToken).toBe("tok-1");
    expect(sent[0]!.params.total).toBe(4); // 3 rounds + 1 judge
    expect(sent[0]!.params.message).toContain("Round 1/3");
    expect(sent[0]!.params.message).toContain("Initial Analysis");
    expect(sent[0]!.params.message).toContain("blind, parallel");
  });

  it("excludes the judge slot from `total` when judgeEnabled=false; sequential rounds render as such", () => {
    const { engine, sent } = setup(2, false);
    engine.emit("roundStart", { round: 1, label: "Counterarguments", blind: false });
    expect(sent[0]!.params.total).toBe(2);
    expect(sent[0]!.params.message).toContain("sequential");
  });

  it("increments progress on roundComplete and synthesisComplete; other events leave it flat", () => {
    const { engine, sent } = setup(2, true);
    engine.emit("participantStart", { participantId: "p1", modelId: "m1" });
    engine.emit("roundComplete", {
      round: 1,
      score: 80,
      averageConfidence: 75,
      stddev: 5,
      disagreements: [],
    });
    engine.emit("synthesisComplete", { synthesis: { judgeConfidence: 90 } });
    const progresses = sent.map((s) => s.params.progress);
    expect(progresses).toEqual([0, 1, 2]);
  });

  it("renders participant lifecycle events with id, modelId, and confidence/error tags", () => {
    const { engine, sent } = setup(2, false);
    engine.emit("participantStart", { participantId: "p1", modelId: "m1" });
    engine.emit("participantComplete", {
      response: { participantId: "p1", confidence: 85, durationMs: 1234, error: undefined },
    });
    engine.emit("participantComplete", {
      response: { participantId: "p2", confidence: 0, durationMs: 500, error: "timeout" },
    });
    expect(sent[0]!.params.message).toContain("p1 (m1) thinking");
    expect(sent[1]!.params.message).toContain("p1 done");
    expect(sent[1]!.params.message).toContain("confidence=85");
    expect(sent[1]!.params.message).toContain("(1234ms)");
    expect(sent[2]!.params.message).toContain("ERROR: timeout");
  });

  it("renders confidence updates, disagreements, early stop, synthesis start, final result, and engine errors", () => {
    const { engine, sent } = setup(4, true);
    engine.emit("confidenceUpdate", {
      round: 1,
      runningAverage: 72.5,
      participantId: "p1",
      confidence: 80,
    });
    engine.emit("disagreementDetected", {
      disagreement: { label: "p1 vs p2", severity: 25 },
    });
    engine.emit("earlyStop", { round: 2, reason: "converged" });
    engine.emit("synthesisStart", { modelId: "judge-m" });
    engine.emit("finalResult", {
      result: { finalScore: 88, roundsCompleted: 2, stopReason: "converged" },
    });
    engine.emit("error", new Error("kaboom"));
    expect(sent[0]!.params.message).toMatch(/running avg round 1: 72\.5/);
    expect(sent[0]!.params.message).toContain("p1=80");
    expect(sent[1]!.params.message).toContain("disagreement: p1 vs p2");
    expect(sent[1]!.params.message).toContain("Δ=25");
    expect(sent[2]!.params.message).toContain("Early stop at round 2: converged");
    expect(sent[3]!.params.message).toContain("Judge synthesis starting (judge-m)");
    expect(sent[4]!.params.message).toContain("finalScore=88");
    expect(sent[4]!.params.message).toContain("rounds=2");
    expect(sent[4]!.params.message).toContain("stopReason=converged");
    expect(sent[5]!.params.message).toContain("engine error: kaboom");
  });

  it("detach() removes every registered listener so post-detach emits are no-ops", () => {
    const { engine, sent, detach } = setup(2, false);
    detach();
    engine.emit("roundStart", { round: 1, label: "x", blind: false });
    engine.emit("roundComplete", {
      round: 1,
      score: 50,
      averageConfidence: 50,
      stddev: 0,
      disagreements: [],
    });
    expect(sent).toHaveLength(0);
    for (const handlers of engine.handlers.values()) {
      expect(handlers).toHaveLength(0);
    }
  });

  it("swallows sendNotification rejections so a disconnected client doesn't crash the run", async () => {
    const engine = createMockEngine();
    const failing: SendNotification = vi.fn(() => Promise.reject(new Error("client gone")));
    wireEngineProgress({
      engine: engine as unknown as ConsensusEngine,
      sendNotification: failing,
      progressToken: "tok",
      maxRounds: 1,
      judgeEnabled: false,
    });
    expect(() => engine.emit("roundStart", { round: 1, label: "x", blind: true })).not.toThrow();
    // Flush the rejected promise so the .catch attached inside notify() runs.
    await new Promise<void>((r) => setImmediate(r));
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
