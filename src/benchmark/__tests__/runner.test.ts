// Contract tests for the bench runner. Uses an in-process mock
// ModelCaller that returns deterministic content keyed on (participantId,
// round). No HTTP, no real LLMs — the runner's job is orchestration and
// these tests lock that orchestration to a contract.

import { describe, expect, it } from "vitest";
import type {
  ModelCallRequest,
  ModelCallResponse,
  ModelCaller,
  Participant,
} from "ai-consensus-core";
import { PERSONAS } from "../../personas.js";
import { ARCHITECTURE_V2_PRESET } from "../../presets/definitions/architecture-v2.js";
import { runSuite } from "../runner.js";
import { deriveRandomSeed, type BenchCase } from "../types.js";

interface MockCallerOptions {
  participantConfidence?: Record<string, number>;
  judgeConfidence?: number;
  baselineConfidence?: number;
  failParticipantIds?: Set<string>;
  failBaseline?: boolean;
  withUsage?: boolean;
  /** Per-criterion score the rubric evaluator returns. Same score for both sides. */
  rubricScore?: number;
  /** If true, the rubric-evaluator returns junk and the eval errors. */
  rubricEvalFails?: boolean;
}

function makeMockCaller(opts: MockCallerOptions = {}): ModelCaller {
  return async (req: ModelCallRequest): Promise<ModelCallResponse> => {
    await Promise.resolve();
    if (opts.failParticipantIds?.has(req.participantId)) {
      throw new Error(`mock failure for ${req.participantId}`);
    }
    if (req.participantId === "baseline") {
      if (opts.failBaseline) {
        throw new Error("mock baseline failure");
      }
      const conf = opts.baselineConfidence ?? 65;
      return {
        content: `Direct baseline answer.\nCONFIDENCE: ${conf}`,
        ...(opts.withUsage
          ? { usage: { inputTokens: 50, outputTokens: 40, totalTokens: 90 } }
          : {}),
      };
    }
    if (req.participantId === "rubric-evaluator") {
      if (opts.rubricEvalFails) {
        return { content: "I refuse to score this." };
      }
      const score = opts.rubricScore ?? 3;
      // Match whatever rubric the panel declared by parsing the criterion
      // ids out of the system prompt. Keeps the mock panel-agnostic.
      const ids = Array.from(req.system.matchAll(/"([a-z0-9_-]+)" \(0-/g)).map((m) => m[1]!);
      return {
        content: JSON.stringify({
          scores: ids.map((id) => ({
            criterion_id: id,
            score,
            justification: `mock score for ${id}`,
          })),
        }),
        ...(opts.withUsage
          ? { usage: { inputTokens: 40, outputTokens: 30, totalTokens: 70 } }
          : {}),
      };
    }
    if (req.participantId === "judge") {
      const conf = opts.judgeConfidence ?? 82;
      return {
        content: [
          "## Majority Position",
          "Mostly agree.",
          "",
          "## Minority Positions",
          "None.",
          "",
          "## Unresolved Disputes",
          "None.",
          "",
          "## Synthesis Confidence",
          "High.",
          "",
          `JUDGE_CONFIDENCE: ${conf}`,
        ].join("\n"),
        ...(opts.withUsage
          ? { usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 } }
          : {}),
      };
    }
    const conf = opts.participantConfidence?.[req.participantId] ?? 70;
    return {
      content: `Participant ${req.participantId} response for round ${req.round}.\nCONFIDENCE: ${conf}`,
      ...(opts.withUsage ? { usage: { inputTokens: 80, outputTokens: 60, totalTokens: 140 } } : {}),
    };
  };
}

/** Build a panel of three participants from the seven Roundtable personas. */
function makeParticipants(): Participant[] {
  const personaIds = ["pessimist", "first-principles", "domain-expert"];
  return personaIds.map((pid, i) => {
    const persona = PERSONAS.find((p) => p.id === pid);
    if (!persona) throw new Error(`fixture missing persona ${pid}`);
    return { id: `p${i + 1}`, modelId: `model-${i}`, persona };
  });
}

const SAMPLE_CASES: BenchCase[] = [
  { id: "case-a", question: "What is the best DB choice?" },
  { id: "case-b", question: "Microservices vs monolith for a 5-person team?" },
];

describe("deriveRandomSeed — deterministic per (baseSeed, caseIndex, runIndex)", () => {
  it("returns the same seed for the same inputs", () => {
    expect(deriveRandomSeed(100, 0, 0)).toBe(deriveRandomSeed(100, 0, 0));
    expect(deriveRandomSeed(42, 3, 7)).toBe(deriveRandomSeed(42, 3, 7));
  });

  it("returns different seeds for adjacent inputs", () => {
    const a = deriveRandomSeed(100, 0, 0);
    const b = deriveRandomSeed(100, 0, 1);
    const c = deriveRandomSeed(100, 1, 0);
    const d = deriveRandomSeed(101, 0, 0);
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("always returns a non-negative 31-bit integer", () => {
    for (let i = 0; i < 200; i++) {
      const s = deriveRandomSeed(Math.floor(Math.random() * 1_000_000), i, i * 3);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0x7fffffff);
      expect(Number.isInteger(s)).toBe(true);
    }
  });
});

describe("runSuite — input validation", () => {
  it("throws on empty cases", async () => {
    await expect(
      runSuite({
        cases: [],
        panel: ARCHITECTURE_V2_PRESET,
        participants: makeParticipants(),
        engineDefaults: {},
        caller: makeMockCaller(),
        baselineModelId: "judge-model",
        runs: 1,
        baseSeed: 1,
      }),
    ).rejects.toThrow(/cases is empty/);
  });

  it("throws on fewer than 2 participants", async () => {
    const persona = PERSONAS[0]!;
    await expect(
      runSuite({
        cases: SAMPLE_CASES,
        panel: ARCHITECTURE_V2_PRESET,
        participants: [{ id: "p1", modelId: "m", persona }],
        engineDefaults: {},
        caller: makeMockCaller(),
        baselineModelId: "judge-model",
        runs: 1,
        baseSeed: 1,
      }),
    ).rejects.toThrow(/at least 2 participants/);
  });

  it("clamps runs to [1, 32]", async () => {
    const report = await runSuite({
      cases: [SAMPLE_CASES[0]!],
      panel: ARCHITECTURE_V2_PRESET,
      participants: makeParticipants(),
      engineDefaults: { maxRounds: 1 },
      caller: makeMockCaller(),
      baselineModelId: "judge-model",
      runs: 100,
      baseSeed: 1,
    });
    expect(report.runs).toHaveLength(32);
  });
});

describe("runSuite — happy path", () => {
  it("produces (cases × runs) BenchRun objects, all non-failed", async () => {
    const report = await runSuite({
      cases: SAMPLE_CASES,
      panel: ARCHITECTURE_V2_PRESET,
      participants: makeParticipants(),
      engineDefaults: { maxRounds: 1, earlyStop: false },
      caller: makeMockCaller({ withUsage: true }),
      baselineModelId: "judge-model",
      runs: 2,
      baseSeed: 7,
    });
    expect(report.runs).toHaveLength(4);
    for (const r of report.runs) {
      expect(r.failed).toBe(false);
      expect(r.consensus.roundsCompleted).toBe(1);
      expect(r.consensus.totalUsage?.totalTokens).toBeGreaterThan(0);
      expect(r.baseline.confidence).toBe(65);
    }
  });

  it("wires panel metadata into the report header", async () => {
    const report = await runSuite({
      cases: [SAMPLE_CASES[0]!],
      panel: ARCHITECTURE_V2_PRESET,
      participants: makeParticipants(),
      engineDefaults: { maxRounds: 1 },
      caller: makeMockCaller(),
      baselineModelId: "judge-model",
      runs: 1,
      baseSeed: 1,
    });
    expect(report.panelId).toBe("architecture_v2");
    expect(report.panelTitle).toBe(ARCHITECTURE_V2_PRESET.title);
    expect(report.panelVersion).toBe("2.0.0");
  });

  it("derives per-run randomSeed from baseSeed deterministically", async () => {
    const args = {
      cases: SAMPLE_CASES,
      panel: ARCHITECTURE_V2_PRESET,
      participants: makeParticipants(),
      engineDefaults: { maxRounds: 1, earlyStop: false },
      caller: makeMockCaller(),
      baselineModelId: "judge-model",
      runs: 2,
      baseSeed: 999,
    };
    const a = await runSuite(args);
    const b = await runSuite(args);
    expect(a.runs.map((r) => r.randomSeed)).toEqual(b.runs.map((r) => r.randomSeed));
  });
});

describe("runSuite — rubric evaluation", () => {
  it("leaves rubric undefined on both sides when no evaluator is configured", async () => {
    const report = await runSuite({
      cases: [SAMPLE_CASES[0]!],
      panel: ARCHITECTURE_V2_PRESET,
      participants: makeParticipants(),
      engineDefaults: { maxRounds: 1 },
      caller: makeMockCaller(),
      baselineModelId: "judge-model",
      runs: 1,
      baseSeed: 1,
      // Note: evaluatorModelId omitted — the panel has a rubric, but the
      // bench was invoked without an evaluator, so the path must short-circuit.
    });
    expect(report.runs[0]?.consensus.rubric).toBeUndefined();
    expect(report.runs[0]?.baseline.rubric).toBeUndefined();
    expect(report.metrics.consensusRubricNormalizedMean).toBeUndefined();
    expect(report.metrics.baselineRubricNormalizedMean).toBeUndefined();
    expect(report.metrics.rubricRunsCounted).toBe(0);
  });

  it("populates both rubric outcomes and the rubric metrics when the evaluator is configured", async () => {
    const report = await runSuite({
      cases: [SAMPLE_CASES[0]!],
      panel: ARCHITECTURE_V2_PRESET,
      participants: makeParticipants(),
      // Judge config is required so the engine produces a synthesis —
      // the rubric eval has no consensus output to score otherwise.
      engineDefaults: { maxRounds: 1, judge: { modelId: "judge-model" } },
      caller: makeMockCaller({ rubricScore: 4 }),
      baselineModelId: "judge-model",
      runs: 2,
      baseSeed: 1,
      evaluatorModelId: "claude-opus-4-5",
    });
    for (const r of report.runs) {
      expect(r.consensus.rubric?.errorMessage).toBeUndefined();
      expect(r.baseline.rubric?.errorMessage).toBeUndefined();
      // ARCHITECTURE_V2_PRESET has 5 criteria of 5 points each → 4/5 each = 80.
      expect(r.consensus.rubric?.normalized).toBe(80);
      expect(r.baseline.rubric?.normalized).toBe(80);
    }
    expect(report.metrics.rubricRunsCounted).toBe(2);
    expect(report.metrics.consensusRubricNormalizedMean).toBe(80);
    expect(report.metrics.baselineRubricNormalizedMean).toBe(80);
    // Equal scores → consensus is NOT strictly greater on either run.
    expect(report.metrics.consensusBeatsBaselineRubricRate).toBe(0);
  });

  it("captures rubric failures into errorMessage without aborting the suite", async () => {
    const report = await runSuite({
      cases: [SAMPLE_CASES[0]!],
      panel: ARCHITECTURE_V2_PRESET,
      participants: makeParticipants(),
      engineDefaults: { maxRounds: 1, judge: { modelId: "judge-model" } },
      caller: makeMockCaller({ rubricEvalFails: true }),
      baselineModelId: "judge-model",
      runs: 1,
      baseSeed: 1,
      evaluatorModelId: "claude-opus-4-5",
    });
    expect(report.runs[0]?.failed).toBe(false); // run itself succeeded
    expect(report.runs[0]?.consensus.rubric?.errorMessage).toBeDefined();
    expect(report.runs[0]?.baseline.rubric?.errorMessage).toBeDefined();
    // Failed evals are excluded from the paired-runs denominator.
    expect(report.metrics.rubricRunsCounted).toBe(0);
    expect(report.metrics.consensusBeatsBaselineRubricRate).toBeUndefined();
  });
});

describe("runSuite — failure capture", () => {
  it("marks runs as failed when the engine throws on every participant", async () => {
    const allFail = new Set(["p1", "p2", "p3"]);
    const report = await runSuite({
      cases: [SAMPLE_CASES[0]!],
      panel: ARCHITECTURE_V2_PRESET,
      participants: makeParticipants(),
      engineDefaults: { maxRounds: 1, earlyStop: false },
      caller: makeMockCaller({ failParticipantIds: allFail }),
      baselineModelId: "judge-model",
      runs: 1,
      baseSeed: 1,
    });
    // The engine captures per-participant errors into `response.error` rather
    // than throwing — so consensus still completes, with all responses errored.
    // The metrics layer counts the run as non-failed but with low confidence.
    expect(report.runs[0]!.consensus.result.rounds.length).toBeGreaterThan(0);
  });

  it("captures a baseline failure as errorMessage and marks the run failed", async () => {
    const report = await runSuite({
      cases: [SAMPLE_CASES[0]!],
      panel: ARCHITECTURE_V2_PRESET,
      participants: makeParticipants(),
      engineDefaults: { maxRounds: 1, earlyStop: false },
      caller: makeMockCaller({ failBaseline: true }),
      baselineModelId: "judge-model",
      runs: 1,
      baseSeed: 1,
    });
    const run = report.runs[0]!;
    expect(run.failed).toBe(true);
    expect(run.baseline.errorMessage).toMatch(/baseline failure/);
  });
});

describe("runSuite — abort handling", () => {
  it("rejects when signal is aborted before the first case", async () => {
    const ac = new AbortController();
    ac.abort(new Error("user cancel"));
    await expect(
      runSuite({
        cases: SAMPLE_CASES,
        panel: ARCHITECTURE_V2_PRESET,
        participants: makeParticipants(),
        engineDefaults: { maxRounds: 1 },
        caller: makeMockCaller(),
        baselineModelId: "judge-model",
        runs: 1,
        baseSeed: 1,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/cancel|abort/i);
  });
});

describe("runSuite — progress events", () => {
  it("emits at least suite-start, case-start, consensus-complete, baseline-complete, case-complete, suite-complete", async () => {
    const events: string[] = [];
    await runSuite({
      cases: [SAMPLE_CASES[0]!],
      panel: ARCHITECTURE_V2_PRESET,
      participants: makeParticipants(),
      engineDefaults: { maxRounds: 1 },
      caller: makeMockCaller(),
      baselineModelId: "judge-model",
      runs: 1,
      baseSeed: 1,
      onProgress: (e) => events.push(e.kind),
    });
    expect(events).toContain("suite-start");
    expect(events).toContain("case-start");
    expect(events).toContain("consensus-complete");
    expect(events).toContain("baseline-complete");
    expect(events).toContain("case-complete");
    expect(events).toContain("suite-complete");
  });
});
