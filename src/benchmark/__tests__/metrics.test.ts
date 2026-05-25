// Contract tests for bench metric computation. Pure — synthetic BenchRun
// inputs, no engine, no LLM, no I/O. Each assertion locks down a formula
// reviewers can verify by inspection.

import { describe, expect, it } from "vitest";
import type { ConsensusResult, RoundResult } from "ai-consensus-core";
import { buildQualitativeNotes, computeMetrics } from "../metrics.js";
import type { BenchRun, ConsensusOutcome, BaselineOutcome } from "../types.js";

function makeConsensusResult(
  rounds: { score: number; avg: number; stddev: number }[],
  stopReason: ConsensusResult["stopReason"] = "max-rounds",
): ConsensusResult {
  const now = Date.now();
  const fullRounds: RoundResult[] = rounds.map((r, i) => ({
    round: i + 1,
    phase: "initial-analysis",
    label: `Round ${i + 1}`,
    blind: i === 0,
    responses: [],
    averageConfidence: r.avg,
    stddev: r.stddev,
    score: r.score,
    disagreements: [],
    startedAt: now,
    completedAt: now + 100,
    durationMs: 100,
  }));
  return {
    question: "Q",
    participants: [],
    rounds: fullRounds,
    roundsCompleted: rounds.length,
    finalScore: rounds[rounds.length - 1]?.score ?? 0,
    finalAverageConfidence: rounds[rounds.length - 1]?.avg ?? 0,
    finalStddev: rounds[rounds.length - 1]?.stddev ?? 0,
    stopReason,
    startedAt: now,
    completedAt: now + rounds.length * 100,
    durationMs: rounds.length * 100,
  };
}

function makeConsensusOutcome(
  rounds: { score: number; avg: number; stddev: number }[],
  options: {
    judgeConfidence?: number;
    disagreementCount?: number;
    durationMs?: number;
    totalTokens?: number;
    stopReason?: ConsensusResult["stopReason"];
  } = {},
): ConsensusOutcome {
  const result = makeConsensusResult(rounds, options.stopReason);
  const last = rounds[rounds.length - 1]!;
  return {
    result,
    finalScore: last.score,
    finalAverageConfidence: last.avg,
    finalStddev: last.stddev,
    roundsCompleted: rounds.length,
    disagreementCount: options.disagreementCount ?? 0,
    judgeConfidence: options.judgeConfidence,
    durationMs: options.durationMs ?? 500,
    totalUsage:
      options.totalTokens !== undefined
        ? {
            inputTokens: Math.floor(options.totalTokens * 0.6),
            outputTokens: Math.floor(options.totalTokens * 0.4),
            totalTokens: options.totalTokens,
          }
        : undefined,
  };
}

function makeBaseline(opts: {
  confidence: number;
  durationMs?: number;
  totalTokens?: number;
  errorMessage?: string;
}): BaselineOutcome {
  return {
    modelId: "judge-model",
    content: `baseline content\nCONFIDENCE: ${opts.confidence}`,
    confidence: opts.confidence,
    durationMs: opts.durationMs ?? 200,
    usage:
      opts.totalTokens !== undefined
        ? {
            inputTokens: Math.floor(opts.totalTokens * 0.5),
            outputTokens: Math.floor(opts.totalTokens * 0.5),
            totalTokens: opts.totalTokens,
          }
        : undefined,
    errorMessage: opts.errorMessage,
  };
}

function makeRun(args: {
  caseId?: string;
  runIndex?: number;
  failed?: boolean;
  consensus: ConsensusOutcome;
  baseline: BaselineOutcome;
  errorMessage?: string;
}): BenchRun {
  return {
    caseId: args.caseId ?? "c1",
    panelId: "panel_x",
    runIndex: args.runIndex ?? 0,
    randomSeed: 42,
    consensus: args.consensus,
    baseline: args.baseline,
    failed: args.failed ?? false,
    ...(args.errorMessage !== undefined ? { errorMessage: args.errorMessage } : {}),
  };
}

describe("computeMetrics — edge cases", () => {
  it("returns zeroed metrics for empty runs", () => {
    const m = computeMetrics([]);
    expect(m.runsAttempted).toBe(0);
    expect(m.runsCounted).toBe(0);
    expect(m.agreementRate).toBe(0);
    expect(m.judgeConfidenceMean).toBeUndefined();
  });

  it("excludes failed runs from per-metric averages but counts them in runsAttempted", () => {
    const goodRun = makeRun({
      consensus: makeConsensusOutcome([{ score: 80, avg: 80, stddev: 5 }]),
      baseline: makeBaseline({ confidence: 60 }),
    });
    const failedRun = makeRun({
      consensus: makeConsensusOutcome([{ score: 0, avg: 0, stddev: 0 }]),
      baseline: makeBaseline({ confidence: 0, errorMessage: "boom" }),
      failed: true,
      errorMessage: "boom",
    });
    const m = computeMetrics([goodRun, failedRun]);
    expect(m.runsAttempted).toBe(2);
    expect(m.runsCounted).toBe(1);
    // The single good run had stddev=5 ≤ threshold 15 → agreement rate 1.0
    expect(m.agreementRate).toBe(1);
  });
});

describe("computeMetrics — agreement rate", () => {
  it("counts a run as agreed when final stddev ≤ threshold (default 15)", () => {
    const runs: BenchRun[] = [
      makeRun({
        consensus: makeConsensusOutcome([{ score: 80, avg: 80, stddev: 10 }]),
        baseline: makeBaseline({ confidence: 60 }),
      }),
      makeRun({
        consensus: makeConsensusOutcome([{ score: 60, avg: 60, stddev: 25 }]),
        baseline: makeBaseline({ confidence: 60 }),
      }),
    ];
    const m = computeMetrics(runs);
    expect(m.agreementRate).toBe(0.5);
    expect(m.agreementStddevThreshold).toBe(15);
  });

  it("honors a custom agreementStddevThreshold", () => {
    const runs: BenchRun[] = [
      makeRun({
        consensus: makeConsensusOutcome([{ score: 70, avg: 70, stddev: 12 }]),
        baseline: makeBaseline({ confidence: 60 }),
      }),
    ];
    const strict = computeMetrics(runs, { agreementStddevThreshold: 5 });
    expect(strict.agreementRate).toBe(0); // 12 > 5
    const lax = computeMetrics(runs, { agreementStddevThreshold: 20 });
    expect(lax.agreementRate).toBe(1); // 12 ≤ 20
  });
});

describe("computeMetrics — convergence + early-stop", () => {
  it("averages roundsCompleted across counted runs", () => {
    const r2 = makeRun({
      consensus: makeConsensusOutcome([
        { score: 50, avg: 50, stddev: 10 },
        { score: 60, avg: 60, stddev: 8 },
      ]),
      baseline: makeBaseline({ confidence: 50 }),
    });
    const r4 = makeRun({
      consensus: makeConsensusOutcome([
        { score: 50, avg: 50, stddev: 10 },
        { score: 55, avg: 55, stddev: 10 },
        { score: 60, avg: 60, stddev: 10 },
        { score: 65, avg: 65, stddev: 10 },
      ]),
      baseline: makeBaseline({ confidence: 50 }),
    });
    const m = computeMetrics([r2, r4]);
    expect(m.convergenceSpeedAvgRounds).toBe(3); // (2 + 4) / 2
  });

  it("computes early-stop rate from stopReason==='converged'", () => {
    const conv = makeRun({
      consensus: makeConsensusOutcome([{ score: 80, avg: 80, stddev: 5 }], {
        stopReason: "converged",
      }),
      baseline: makeBaseline({ confidence: 60 }),
    });
    const max = makeRun({
      consensus: makeConsensusOutcome([{ score: 60, avg: 60, stddev: 15 }], {
        stopReason: "max-rounds",
      }),
      baseline: makeBaseline({ confidence: 60 }),
    });
    const m = computeMetrics([conv, max]);
    expect(m.earlyStopRate).toBe(0.5);
  });
});

describe("computeMetrics — judge confidence distribution", () => {
  it("computes mean and stddev across runs with judge data, ignoring runs without", () => {
    const runs: BenchRun[] = [
      makeRun({
        consensus: makeConsensusOutcome([{ score: 80, avg: 80, stddev: 8 }], {
          judgeConfidence: 90,
        }),
        baseline: makeBaseline({ confidence: 60 }),
      }),
      makeRun({
        consensus: makeConsensusOutcome([{ score: 70, avg: 70, stddev: 8 }], {
          judgeConfidence: 70,
        }),
        baseline: makeBaseline({ confidence: 60 }),
      }),
      // No judge: contributes to runsCounted but not to judge stats.
      makeRun({
        consensus: makeConsensusOutcome([{ score: 60, avg: 60, stddev: 8 }]),
        baseline: makeBaseline({ confidence: 60 }),
      }),
    ];
    const m = computeMetrics(runs);
    expect(m.judgeConfidenceMean).toBe(80); // (90+70)/2
    expect(m.judgeConfidenceStddev).toBe(10); // population stddev of [90,70]
  });
});

describe("computeMetrics — inter-rater reliability proxy", () => {
  it("derives proxy from mean per-round stddev across all rounds of all runs", () => {
    // Two rounds, stddevs [10, 30] → mean 20 → proxy = 1 - 20/100 = 0.80
    const run = makeRun({
      consensus: makeConsensusOutcome([
        { score: 60, avg: 60, stddev: 10 },
        { score: 70, avg: 70, stddev: 30 },
      ]),
      baseline: makeBaseline({ confidence: 60 }),
    });
    const m = computeMetrics([run]);
    expect(m.interRaterReliabilityProxy).toBeCloseTo(0.8, 5);
  });
});

describe("computeMetrics — duration + token ratios", () => {
  it("averages durationMs ratio across counted runs", () => {
    const a = makeRun({
      consensus: makeConsensusOutcome([{ score: 70, avg: 70, stddev: 10 }], {
        durationMs: 1000,
      }),
      baseline: makeBaseline({ confidence: 60, durationMs: 200 }),
    });
    const b = makeRun({
      consensus: makeConsensusOutcome([{ score: 70, avg: 70, stddev: 10 }], {
        durationMs: 4000,
      }),
      baseline: makeBaseline({ confidence: 60, durationMs: 500 }),
    });
    const m = computeMetrics([a, b]);
    // Ratios: 5, 8 → avg 6.5
    expect(m.durationRatioAvg).toBeCloseTo(6.5, 5);
  });

  it("returns undefined tokenRatioAvg when no run has usage on both sides", () => {
    const run = makeRun({
      consensus: makeConsensusOutcome([{ score: 70, avg: 70, stddev: 10 }]),
      baseline: makeBaseline({ confidence: 60 }),
    });
    const m = computeMetrics([run]);
    expect(m.tokenRatioAvg).toBeUndefined();
  });

  it("computes tokenRatioAvg only on runs with usage on both sides", () => {
    const both = makeRun({
      consensus: makeConsensusOutcome([{ score: 70, avg: 70, stddev: 10 }], {
        totalTokens: 1000,
      }),
      baseline: makeBaseline({ confidence: 60, totalTokens: 200 }),
    });
    const oneSide = makeRun({
      consensus: makeConsensusOutcome([{ score: 70, avg: 70, stddev: 10 }], {
        totalTokens: 1500,
      }),
      baseline: makeBaseline({ confidence: 60 }),
    });
    const m = computeMetrics([both, oneSide]);
    expect(m.tokenRatioAvg).toBe(5); // 1000/200 only
  });
});

describe("buildQualitativeNotes", () => {
  it("emits one line per run, tagging failure mode for failed runs", () => {
    const runs = [
      makeRun({
        caseId: "c1",
        runIndex: 0,
        consensus: makeConsensusOutcome([{ score: 80, avg: 80, stddev: 8 }], {
          stopReason: "converged",
          judgeConfidence: 85,
        }),
        baseline: makeBaseline({ confidence: 60 }),
      }),
      makeRun({
        caseId: "c2",
        runIndex: 0,
        consensus: makeConsensusOutcome([{ score: 0, avg: 0, stddev: 0 }]),
        baseline: makeBaseline({ confidence: 0, errorMessage: "network" }),
        failed: true,
        errorMessage: "network down",
      }),
    ];
    const notes = buildQualitativeNotes(runs);
    expect(notes.length).toBe(2);
    expect(notes[0]).toContain("c1#0");
    expect(notes[0]).toContain("converged");
    expect(notes[0]).toContain("judge confidence 85");
    expect(notes[1]).toContain("c2");
    expect(notes[1]).toContain("failed");
  });
});
