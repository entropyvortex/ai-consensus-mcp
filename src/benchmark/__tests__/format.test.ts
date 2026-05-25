// Contract tests for bench report formatting. Asserts the markdown
// surface contains every section a reviewer relies on, and the JSON
// form is valid + structurally stable.

import { describe, expect, it } from "vitest";
import type { ConsensusResult } from "ai-consensus-core";
import { formatReportJson, formatReportMarkdown } from "../format.js";
import type { BenchReport, BenchRun } from "../types.js";

function makeMinimalReport(overrides: Partial<BenchReport> = {}): BenchReport {
  const now = Date.now();
  const result: ConsensusResult = {
    question: "Q",
    participants: [],
    rounds: [
      {
        round: 1,
        phase: "initial-analysis",
        label: "Round 1",
        blind: true,
        responses: [],
        averageConfidence: 75,
        stddev: 8,
        score: 71,
        disagreements: [],
        startedAt: now,
        completedAt: now + 100,
        durationMs: 100,
      },
    ],
    roundsCompleted: 1,
    finalScore: 71,
    finalAverageConfidence: 75,
    finalStddev: 8,
    stopReason: "max-rounds",
    startedAt: now,
    completedAt: now + 100,
    durationMs: 100,
  };
  const run: BenchRun = {
    caseId: "c1",
    panelId: "panel_x",
    runIndex: 0,
    randomSeed: 42,
    consensus: {
      result,
      finalScore: 71,
      finalAverageConfidence: 75,
      finalStddev: 8,
      roundsCompleted: 1,
      disagreementCount: 0,
      judgeConfidence: 80,
      durationMs: 100,
      totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    },
    baseline: {
      modelId: "judge-model",
      content: "baseline\nCONFIDENCE: 60",
      confidence: 60,
      durationMs: 50,
      usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
      errorMessage: undefined,
    },
    failed: false,
  };
  return {
    panelId: "panel_x",
    panelTitle: "Test Panel",
    panelVersion: "2.0.0",
    caseFileName: "(test)",
    baselineModelId: "judge-model",
    baseSeed: 42,
    generatedAt: now,
    cases: [{ id: "c1", question: "Q" }],
    runs: [run],
    metrics: {
      agreementRate: 1,
      agreementStddevThreshold: 15,
      convergenceSpeedAvgRounds: 1,
      earlyStopRate: 0,
      judgeConfidenceMean: 80,
      judgeConfidenceStddev: 0,
      interRaterReliabilityProxy: 0.92,
      disagreementCountAvg: 0,
      durationRatioAvg: 2,
      tokenRatioAvg: 3,
      consensusBeatsBaselineConfidenceRate: 1,
      runsCounted: 1,
      runsAttempted: 1,
    },
    qualitativeNotes: ["• c1#0: converged at round 1; judge confidence 80"],
    ...overrides,
  };
}

describe("formatReportMarkdown — section contract", () => {
  it("includes every required heading", () => {
    const md = formatReportMarkdown(makeMinimalReport());
    expect(md).toContain("# Bench Report");
    expect(md).toContain("## Metrics");
    expect(md).toContain("## Per-case results");
    expect(md).toContain("## Qualitative notes");
    expect(md).toContain("## Suite metadata");
  });

  it("renders metrics in the expected form", () => {
    const md = formatReportMarkdown(makeMinimalReport());
    expect(md).toMatch(/Agreement rate.*100%/);
    expect(md).toMatch(/Convergence speed.*1\.00 rounds avg/);
    expect(md).toMatch(/Judge confidence.*μ=80\.0/);
    expect(md).toMatch(/Inter-rater reliability proxy.*0\.92/);
    expect(md).toMatch(/Duration ratio.*2\.00×/);
    expect(md).toMatch(/Token ratio.*3\.00×/);
  });

  it("includes the panel version when set", () => {
    const md = formatReportMarkdown(makeMinimalReport());
    expect(md).toContain("v2.0.0");
  });

  it("renders per-case table with score, sigma, rounds, stop, judge conf, baseline conf, delta", () => {
    const md = formatReportMarkdown(makeMinimalReport());
    // The table contains "| 71 |" for score, "| 80 |" for judge conf, "| 60 |" for baseline, "| +11 |" for delta.
    expect(md).toContain("| 71 |");
    expect(md).toContain("| 80 |");
    expect(md).toContain("| 60 |");
    expect(md).toContain("+11");
  });

  it("handles failed runs by rendering a row with FAILED tag", () => {
    const r = makeMinimalReport();
    r.runs[0]!.failed = true;
    r.runs[0]!.errorMessage = "network down";
    const md = formatReportMarkdown(r);
    expect(md).toMatch(/FAILED.*network down/);
  });

  it("falls back gracefully when no judge confidence is available", () => {
    const r = makeMinimalReport();
    r.metrics.judgeConfidenceMean = undefined;
    r.metrics.judgeConfidenceStddev = undefined;
    const md = formatReportMarkdown(r);
    expect(md).toMatch(/no judge synthesis/);
  });
});

describe("formatReportJson", () => {
  it("returns valid JSON", () => {
    const json = formatReportJson(makeMinimalReport());
    expect(() => JSON.parse(json) as unknown).not.toThrow();
  });

  it("drops the ConsensusResult body by default for diffability", () => {
    const json = formatReportJson(makeMinimalReport());
    const parsed = JSON.parse(json) as { runs: { consensus: { result?: unknown } }[] };
    expect(parsed.runs[0]!.consensus.result).toBeUndefined();
  });

  it("includes the full ConsensusResult body when asked", () => {
    const json = formatReportJson(makeMinimalReport(), { includeFullResults: true });
    const parsed = JSON.parse(json) as { runs: { consensus: { result?: ConsensusResult } }[] };
    expect(parsed.runs[0]!.consensus.result).toBeDefined();
    expect(parsed.runs[0]!.consensus.result?.rounds.length).toBe(1);
  });
});
