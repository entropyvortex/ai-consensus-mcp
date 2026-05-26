// ─────────────────────────────────────────────────────────────
// Benchmark types and runtime schemas
// ─────────────────────────────────────────────────────────────
// A bench measures the uplift of full consensus (panel + debate +
// judge synthesis) over a single-model baseline on a set of test
// cases. The shapes here are the contracts that runner, metrics,
// formatter, and JSON case-file loader all share.
//
// Determinism contract: with the same cases, panel, baseline model,
// baseSeed, and ModelCaller, the runner emits an identical
// per-run randomSeed sequence. Round-order shuffling and any other
// deterministic engine behaviour replays. Model outputs themselves
// only replay when the ModelCaller is itself deterministic (mock
// callers for tests; real LLMs are not).

import { z } from "zod";
import type { ConsensusResult, TokenUsage } from "ai-consensus-core";
import type { RubricEvaluation } from "./rubric.js";

// ── BenchCase (input) ────────────────────────────────────────

/**
 * One test case the bench will evaluate. JSON-loadable.
 *
 * `panelId` is optional — when omitted, the bench applies whichever panel
 * is selected at suite level (the CLI `--panel` flag). Cases that name a
 * panel only run when the suite-level filter matches (or when no filter
 * is set), so a single case-file can carry mixed-panel suites.
 */
export const BenchCaseSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "id must be kebab/snake_case ascii"),
    question: z.string().min(1),
    panelId: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    /** Optional topical anchors used by the report to flag "claim coverage". */
    expectedTopics: z.array(z.string().min(1)).optional(),
    /** Free-form notes shown in the per-case report. */
    notes: z.string().optional(),
  })
  .strict();

export type BenchCase = z.infer<typeof BenchCaseSchema>;

/**
 * Schema of a JSON bench case-file (`--cases ./my-cases.json` or built-in
 * `fixtures/*.json`). `version` lets us evolve the schema without breaking
 * older case-files.
 */
export const BenchCaseFileSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal("1.0.0"),
    /** Free-form display name; surfaces in the report header. */
    name: z.string().min(1).optional(),
    cases: z.array(BenchCaseSchema).min(1),
  })
  .strict();

export type BenchCaseFile = z.infer<typeof BenchCaseFileSchema>;

// ── BenchRun (per-run output) ────────────────────────────────

/**
 * One execution of one case: a full consensus run paired with a
 * single-model baseline on the same question. Multiple runs per case
 * (controlled by `--runs`) average out model non-determinism.
 */
export interface BenchRun {
  caseId: string;
  panelId: string;
  runIndex: number;
  /** Seed used for the round-order shuffle. Deterministic from baseSeed. */
  randomSeed: number;
  consensus: ConsensusOutcome;
  baseline: BaselineOutcome;
  /** True if either side threw an unrecoverable error. */
  failed: boolean;
  /** Surfaces the error message when `failed` is true. */
  errorMessage?: string;
}

export interface ConsensusOutcome {
  /** Full result for downstream inspection or memory storage. */
  result: ConsensusResult;
  finalScore: number;
  finalAverageConfidence: number;
  finalStddev: number;
  roundsCompleted: number;
  disagreementCount: number;
  judgeConfidence: number | undefined;
  durationMs: number;
  totalUsage: TokenUsage | undefined;
  /**
   * Held-out rubric evaluation of the consensus synthesis. Populated only
   * when the panel declares a `rubric` AND the bench was invoked with an
   * evaluator model. `undefined` means "not evaluated"; an evaluation with
   * `errorMessage` set means "tried and failed".
   */
  rubric: RubricEvaluation | undefined;
}

export interface BaselineOutcome {
  modelId: string;
  /** Verbatim model response, including the trailing CONFIDENCE marker. */
  content: string;
  /** Parsed self-reported confidence (0-100). Defaults to 50 when absent. */
  confidence: number;
  durationMs: number;
  usage: TokenUsage | undefined;
  errorMessage: string | undefined;
  /** Held-out rubric evaluation; same activation rule as ConsensusOutcome.rubric. */
  rubric: RubricEvaluation | undefined;
}

// ── BenchReport (suite-level aggregation) ────────────────────

export interface BenchMetrics {
  /**
   * Fraction of runs where the panel reached low-disagreement consensus
   * (final stddev ≤ `agreementStddevThreshold`). 0..1.
   */
  agreementRate: number;
  /** Threshold used to compute `agreementRate`. Default 15. */
  agreementStddevThreshold: number;
  /** Average rounds completed across all runs (lower = faster convergence). */
  convergenceSpeedAvgRounds: number;
  /** Fraction of runs that stopped early (converged within maxRounds). */
  earlyStopRate: number;
  /** Mean of judge-confidence values across runs that produced a judge. */
  judgeConfidenceMean: number | undefined;
  /** Stddev of judge-confidence values across runs that produced a judge. */
  judgeConfidenceStddev: number | undefined;
  /**
   * Proxy for inter-rater reliability: `1 − (mean panel stddev / 100)`,
   * averaged over all rounds and all runs. Higher = participants agreed.
   * Range 0..1.
   */
  interRaterReliabilityProxy: number;
  /** Average disagreement count per run. */
  disagreementCountAvg: number;
  /** consensus.durationMs / baseline.durationMs, averaged across runs. */
  durationRatioAvg: number;
  /**
   * consensus.tokens / baseline.tokens, averaged across runs that reported
   * usage on both sides. `undefined` when neither side reported usage.
   */
  tokenRatioAvg: number | undefined;
  /**
   * Fraction of runs where the consensus *score* was strictly greater than
   * the baseline's self-reported confidence. A coarse "would the panel have
   * been more justified?" signal — not a quality measure on its own.
   */
  consensusBeatsBaselineConfidenceRate: number;
  /** Total runs included in metrics (excludes failed). */
  runsCounted: number;
  /** Total runs attempted. */
  runsAttempted: number;
  /**
   * Mean of rubric-normalized scores for the consensus side, across runs
   * where the held-out evaluator succeeded. `undefined` when no run had a
   * successful consensus rubric eval (panel has no rubric, or eval was
   * never invoked, or every eval failed).
   */
  consensusRubricNormalizedMean: number | undefined;
  /** Mean of rubric-normalized scores for the baseline side; same contract. */
  baselineRubricNormalizedMean: number | undefined;
  /**
   * Fraction of runs where the consensus rubric score was strictly greater
   * than the baseline rubric score. Independent of self-reported confidence —
   * this is the held-out-judge view of which side answered better. `undefined`
   * when fewer than 1 run had successful evals on BOTH sides.
   */
  consensusBeatsBaselineRubricRate: number | undefined;
  /** Count of runs where both rubric evaluations succeeded — denominator for the rate above. */
  rubricRunsCounted: number;
}

export interface BenchReport {
  /** Suite-level metadata. */
  panelId: string;
  panelTitle: string;
  panelVersion: string | undefined;
  caseFileName: string | undefined;
  baselineModelId: string;
  /** Base seed the runner threaded through per-run derivation. */
  baseSeed: number;
  generatedAt: number;
  cases: BenchCase[];
  runs: BenchRun[];
  metrics: BenchMetrics;
  /** Notes the metrics module emits from inspecting the runs. */
  qualitativeNotes: string[];
}

// ── Internal: build a per-run randomSeed deterministically ──

/**
 * Compose `(baseSeed, caseIndex, runIndex)` into a single 32-bit non-negative
 * integer the engine accepts as `randomSeed`. Uses small odd-prime multipliers
 * so adjacent cases / runs don't end up with correlated seeds.
 */
export function deriveRandomSeed(baseSeed: number, caseIndex: number, runIndex: number): number {
  // Bit-mask down to 31 bits — engine's clampInt expects a number that fits
  // in a non-negative integer. 2^31-1 is plenty of entropy for shuffle seeding.
  const mixed = (Math.trunc(baseSeed) * 2654435761 + caseIndex * 40503 + runIndex * 7919) >>> 0;
  return mixed & 0x7fffffff;
}
