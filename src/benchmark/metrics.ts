// ─────────────────────────────────────────────────────────────
// Bench metrics — pure aggregation over runs
// ─────────────────────────────────────────────────────────────
// Every function in this file is a pure reducer on `readonly BenchRun[]`.
// No I/O, no LLM calls, no engine knowledge — that lets the metrics
// be unit-tested against synthetic runs without provider configuration.
//
// Naming follows the user-facing report: `agreementRate`, `convergenceSpeedAvg`,
// `interRaterReliabilityProxy`, etc. — the column headers reviewers see.

import type {
  BenchRun,
  BenchMetrics,
  ConsensusOutcome,
} from "./types.js";

const DEFAULT_AGREEMENT_STDDEV_THRESHOLD = 15;

export interface ComputeMetricsOptions {
  /**
   * Final-round stddev at or below which a run counts as "agreement reached."
   * Lower = stricter. Defaults to 15 — empirically a tight panel.
   */
  agreementStddevThreshold?: number;
}

/**
 * Aggregate a set of runs into the report's metric block. Failed runs are
 * counted in `runsAttempted` but excluded from per-metric averages so a
 * single network error doesn't pull the report toward zero.
 */
export function computeMetrics(
  runs: readonly BenchRun[],
  options: ComputeMetricsOptions = {},
): BenchMetrics {
  const threshold = options.agreementStddevThreshold ?? DEFAULT_AGREEMENT_STDDEV_THRESHOLD;
  const counted = runs.filter((r) => !r.failed);
  const runsAttempted = runs.length;
  const runsCounted = counted.length;

  if (runsCounted === 0) {
    return {
      agreementRate: 0,
      agreementStddevThreshold: threshold,
      convergenceSpeedAvgRounds: 0,
      earlyStopRate: 0,
      judgeConfidenceMean: undefined,
      judgeConfidenceStddev: undefined,
      interRaterReliabilityProxy: 0,
      disagreementCountAvg: 0,
      durationRatioAvg: 0,
      tokenRatioAvg: undefined,
      consensusBeatsBaselineConfidenceRate: 0,
      runsCounted,
      runsAttempted,
    };
  }

  const agreementHits = counted.filter((r) => r.consensus.finalStddev <= threshold).length;
  const agreementRate = agreementHits / runsCounted;

  const earlyStopHits = counted.filter((r) => r.consensus.result.stopReason === "converged").length;
  const earlyStopRate = earlyStopHits / runsCounted;

  const convergenceSpeedAvgRounds = mean(counted.map((r) => r.consensus.roundsCompleted));

  // Judge confidence — only counts runs that actually produced a judge synthesis.
  const judgeConfidences = counted
    .map((r) => r.consensus.judgeConfidence)
    .filter((c): c is number => typeof c === "number");
  const judgeConfidenceMean = judgeConfidences.length > 0 ? mean(judgeConfidences) : undefined;
  const judgeConfidenceStddev =
    judgeConfidences.length > 0 ? stddev(judgeConfidences) : undefined;

  // Inter-rater reliability proxy — average per-round stddev across all runs.
  // We invert and scale to 0..1: `1 - (meanStddev / 100)`. A panel that always
  // splits 0/100 lands near 0; a panel that always agrees lands near 1.
  const allRoundStddevs: number[] = [];
  for (const r of counted) {
    for (const round of r.consensus.result.rounds) {
      allRoundStddevs.push(round.stddev);
    }
  }
  const meanRoundStddev = allRoundStddevs.length > 0 ? mean(allRoundStddevs) : 0;
  const interRaterReliabilityProxy = clamp01(1 - meanRoundStddev / 100);

  const disagreementCountAvg = mean(counted.map((r) => r.consensus.disagreementCount));

  // Duration ratio — skip runs where baseline took <1ms (clock granularity).
  const durationRatios = counted
    .filter((r) => r.baseline.durationMs > 0)
    .map((r) => r.consensus.durationMs / r.baseline.durationMs);
  const durationRatioAvg = durationRatios.length > 0 ? mean(durationRatios) : 0;

  // Token ratio — only runs with usage on both sides contribute.
  const tokenRatios: number[] = [];
  for (const r of counted) {
    const cu = totalTokens(r.consensus);
    const bu = r.baseline.usage?.totalTokens ?? 0;
    if (cu > 0 && bu > 0) tokenRatios.push(cu / bu);
  }
  const tokenRatioAvg = tokenRatios.length > 0 ? mean(tokenRatios) : undefined;

  const beatHits = counted.filter(
    (r) => r.consensus.finalScore > r.baseline.confidence,
  ).length;
  const consensusBeatsBaselineConfidenceRate = beatHits / runsCounted;

  return {
    agreementRate,
    agreementStddevThreshold: threshold,
    convergenceSpeedAvgRounds,
    earlyStopRate,
    judgeConfidenceMean,
    judgeConfidenceStddev,
    interRaterReliabilityProxy,
    disagreementCountAvg,
    durationRatioAvg,
    tokenRatioAvg,
    consensusBeatsBaselineConfidenceRate,
    runsCounted,
    runsAttempted,
  };
}

/**
 * Produce per-run qualitative notes the formatter renders in the report.
 * Each note is one human sentence about a single run — surfaces patterns
 * a reviewer would otherwise have to spot by eye.
 */
export function buildQualitativeNotes(runs: readonly BenchRun[]): string[] {
  const notes: string[] = [];
  for (const r of runs) {
    if (r.failed) {
      notes.push(`✗ case "${r.caseId}" run ${r.runIndex}: failed — ${r.errorMessage ?? "unknown error"}`);
      continue;
    }
    const tags: string[] = [];
    if (r.consensus.result.stopReason === "converged") {
      tags.push(
        `converged at round ${r.consensus.roundsCompleted} (Δ=${r.consensus.result.earlyStop?.delta.toFixed(1) ?? "?"})`,
      );
    } else if (r.consensus.result.stopReason === "max-rounds") {
      tags.push(`ran full ${r.consensus.roundsCompleted} rounds without convergence`);
    } else if (r.consensus.result.stopReason === "aborted") {
      tags.push("aborted mid-run");
    }
    if (r.consensus.finalStddev > 25) {
      tags.push(`high final stddev (σ=${r.consensus.finalStddev.toFixed(1)}) — panel disagreed`);
    }
    if (r.consensus.judgeConfidence !== undefined) {
      tags.push(`judge confidence ${r.consensus.judgeConfidence}`);
    }
    if (r.baseline.errorMessage) {
      tags.push(`baseline errored (${r.baseline.errorMessage})`);
    }
    notes.push(`• ${r.caseId}#${r.runIndex}: ${tags.join("; ")}`);
  }
  return notes;
}

// ── Pure stat helpers (deliberately not pulled from core to keep ────
// ── benchmark/ self-contained and tested independently). ─────────────

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function stddev(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  let v = 0;
  for (const x of xs) {
    const d = x - m;
    v += d * d;
  }
  return Math.sqrt(v / xs.length);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function totalTokens(co: ConsensusOutcome): number {
  return co.totalUsage?.totalTokens ?? 0;
}
