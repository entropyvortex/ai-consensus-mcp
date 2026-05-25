// ─────────────────────────────────────────────────────────────
// Bench runner — orchestrate cases × runs against caller + panel
// ─────────────────────────────────────────────────────────────
// Given a set of bench cases, a resolved panel, and a routed
// ModelCaller, run consensus + baseline for each (case, runIndex)
// pair, collect the outcomes, and emit a BenchReport.
//
// The runner is provider-agnostic: it composes the existing engine and
// baseline pieces and otherwise has no opinion on transport. That keeps
// it unit-testable with a deterministic mock caller.

import {
  ConsensusEngine,
  type ConsensusOptions,
  type ConsensusResult,
  type ModelCaller,
  type Participant,
  type TokenUsage,
} from "ai-consensus-core";
import type { Preset } from "../presets/types.js";
import { runBaseline } from "./baseline.js";
import { computeMetrics, buildQualitativeNotes } from "./metrics.js";
import {
  deriveRandomSeed,
  type BenchCase,
  type BenchReport,
  type BenchRun,
  type ConsensusOutcome,
} from "./types.js";

export interface BenchProgressEvent {
  kind:
    | "suite-start"
    | "case-start"
    | "consensus-complete"
    | "baseline-complete"
    | "case-complete"
    | "suite-complete";
  caseId?: string;
  runIndex?: number;
  caseIndex?: number;
  totalCases: number;
  totalRuns: number;
  /** A short human label, e.g. "running architecture_v2 case 2/5 run 1/3". */
  message: string;
}

export type BenchProgressHandler = (event: BenchProgressEvent) => void;

export interface RunSuiteArgs {
  /** Cases to run. */
  cases: readonly BenchCase[];
  /** Panel to run them against. */
  panel: Preset;
  /** Pre-resolved participant list (already specialised against the panel). */
  participants: Participant[];
  /** Base engine knobs — from the panel's defaults + config overrides. */
  engineDefaults: Omit<ConsensusOptions, "question" | "participants" | "randomSeed">;
  /** Routed caller used by both consensus and baseline runs. */
  caller: ModelCaller;
  /**
   * Baseline model id. Defaults to the judge's model id when set on
   * engineDefaults — the CLI wires this from `config.judge.modelId`.
   */
  baselineModelId: string;
  /** Runs per case. Bounded to [1, 32] by the runner. */
  runs: number;
  /** Deterministic seed root — the runner derives per-run seeds from this. */
  baseSeed: number;
  /** Optional progress events; the CLI pipes these to stderr. */
  onProgress?: BenchProgressHandler;
  /** Optional cancellation. Aborts the in-flight engine run and stops the loop. */
  signal?: AbortSignal;
  /** Optional name for the case-file or suite — appears in the report header. */
  caseFileName?: string;
}

const MAX_RUNS = 32;
const MIN_RUNS = 1;

/**
 * Execute a full bench suite. Returns a `BenchReport` that the formatter
 * can render to markdown/JSON; never throws on per-run failures (they
 * surface as `BenchRun.failed = true`). Throws only on programming errors
 * (no participants, empty cases) or on `signal.aborted`.
 */
export async function runSuite(args: RunSuiteArgs): Promise<BenchReport> {
  const {
    cases,
    panel,
    participants,
    engineDefaults,
    caller,
    baselineModelId,
    runs: requestedRuns,
    baseSeed,
    onProgress,
    signal,
    caseFileName,
  } = args;

  if (cases.length === 0) {
    throw new Error("bench: cases is empty.");
  }
  if (participants.length < 2) {
    throw new Error(`bench: at least 2 participants are required (got ${participants.length}).`);
  }
  const runs = Math.max(MIN_RUNS, Math.min(MAX_RUNS, Math.trunc(requestedRuns)));
  const totalRuns = cases.length * runs;

  const generatedAt = Date.now();
  const collected: BenchRun[] = [];

  onProgress?.({
    kind: "suite-start",
    totalCases: cases.length,
    totalRuns,
    message: `running ${cases.length} case(s) × ${runs} run(s) on panel "${panel.id}"`,
  });

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    throwIfAborted(signal);
    const benchCase = cases[caseIndex]!;
    onProgress?.({
      kind: "case-start",
      caseIndex,
      caseId: benchCase.id,
      totalCases: cases.length,
      totalRuns,
      message: `case ${caseIndex + 1}/${cases.length}: ${benchCase.id}`,
    });

    for (let runIndex = 0; runIndex < runs; runIndex++) {
      throwIfAborted(signal);
      const randomSeed = deriveRandomSeed(baseSeed, caseIndex, runIndex);

      const run = await executeOneRun({
        benchCase,
        panel,
        participants,
        engineDefaults,
        caller,
        baselineModelId,
        randomSeed,
        runIndex,
        signal,
        onProgress,
        caseIndex,
        totalCases: cases.length,
        totalRuns,
      });
      collected.push(run);
    }

    onProgress?.({
      kind: "case-complete",
      caseIndex,
      caseId: benchCase.id,
      totalCases: cases.length,
      totalRuns,
      message: `case ${benchCase.id} complete`,
    });
  }

  const metrics = computeMetrics(collected);
  const qualitativeNotes = buildQualitativeNotes(collected);

  const report: BenchReport = {
    panelId: panel.id,
    panelTitle: panel.title,
    panelVersion: panel.meta?.version,
    caseFileName: caseFileName,
    baselineModelId,
    baseSeed,
    generatedAt,
    cases: cases.slice(),
    runs: collected,
    metrics,
    qualitativeNotes,
  };

  onProgress?.({
    kind: "suite-complete",
    totalCases: cases.length,
    totalRuns,
    message: `suite complete — ${metrics.runsCounted}/${metrics.runsAttempted} runs counted`,
  });

  return report;
}

// ── Single-run orchestration ─────────────────────────────────

interface ExecuteOneRunArgs {
  benchCase: BenchCase;
  panel: Preset;
  participants: Participant[];
  engineDefaults: Omit<ConsensusOptions, "question" | "participants" | "randomSeed">;
  caller: ModelCaller;
  baselineModelId: string;
  randomSeed: number;
  runIndex: number;
  signal: AbortSignal | undefined;
  onProgress: BenchProgressHandler | undefined;
  caseIndex: number;
  totalCases: number;
  totalRuns: number;
}

async function executeOneRun(args: ExecuteOneRunArgs): Promise<BenchRun> {
  const {
    benchCase,
    panel,
    participants,
    engineDefaults,
    caller,
    baselineModelId,
    randomSeed,
    runIndex,
    signal,
    onProgress,
    caseIndex,
    totalCases,
    totalRuns,
  } = args;

  let consensus: ConsensusOutcome | undefined;
  let consensusError: string | undefined;

  // 1) Consensus run.
  try {
    const consensusStartedAt = Date.now();
    const engine = new ConsensusEngine(caller);
    const options: ConsensusOptions = {
      ...engineDefaults,
      question: benchCase.question,
      participants,
      randomSeed,
      ...(signal ? { signal } : {}),
    };
    const result = await engine.run(options);
    const consensusCompletedAt = Date.now();
    consensus = summariseConsensus(result, consensusCompletedAt - consensusStartedAt);
  } catch (err) {
    consensusError = err instanceof Error ? err.message : String(err);
  }
  onProgress?.({
    kind: "consensus-complete",
    caseIndex,
    runIndex,
    caseId: benchCase.id,
    totalCases,
    totalRuns,
    message: `  consensus ${runIndex + 1}: ${
      consensus ? `score=${consensus.finalScore}, σ=${consensus.finalStddev.toFixed(1)}` : "ERRORED"
    }`,
  });

  // 2) Baseline run (always — even if consensus errored, baseline data is useful).
  const baseline = await runBaseline({
    caller,
    modelId: baselineModelId,
    question: benchCase.question,
    ...(signal ? { signal } : {}),
  });
  onProgress?.({
    kind: "baseline-complete",
    caseIndex,
    runIndex,
    caseId: benchCase.id,
    totalCases,
    totalRuns,
    message: `  baseline ${runIndex + 1}: confidence=${baseline.confidence}${
      baseline.errorMessage ? ` (ERRORED: ${baseline.errorMessage})` : ""
    }`,
  });

  const failed = consensus === undefined || baseline.errorMessage !== undefined;
  const errorMessage = consensusError
    ? `consensus: ${consensusError}`
    : baseline.errorMessage
      ? `baseline: ${baseline.errorMessage}`
      : undefined;

  return {
    caseId: benchCase.id,
    panelId: panel.id,
    runIndex,
    randomSeed,
    consensus: consensus ?? placeholderConsensus(),
    baseline,
    failed,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

// ── Helpers ───────────────────────────────────────────────────

function summariseConsensus(result: ConsensusResult, durationMs: number): ConsensusOutcome {
  let disagreementCount = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalTotal = 0;
  let anyUsage = false;
  for (const round of result.rounds) {
    disagreementCount += round.disagreements.length;
    for (const r of round.responses) {
      if (r.usage) {
        anyUsage = true;
        totalInput += r.usage.inputTokens;
        totalOutput += r.usage.outputTokens;
        totalTotal += r.usage.totalTokens;
      }
    }
  }
  if (result.synthesis?.usage) {
    anyUsage = true;
    totalInput += result.synthesis.usage.inputTokens;
    totalOutput += result.synthesis.usage.outputTokens;
    totalTotal += result.synthesis.usage.totalTokens;
  }
  const totalUsage: TokenUsage | undefined = anyUsage
    ? { inputTokens: totalInput, outputTokens: totalOutput, totalTokens: totalTotal }
    : undefined;

  return {
    result,
    finalScore: result.finalScore,
    finalAverageConfidence: result.finalAverageConfidence,
    finalStddev: result.finalStddev,
    roundsCompleted: result.roundsCompleted,
    disagreementCount,
    judgeConfidence: result.synthesis?.judgeConfidence,
    durationMs,
    totalUsage,
  };
}

/**
 * Placeholder consensus outcome used only when the engine itself failed. The
 * `failed` flag on the surrounding `BenchRun` keeps this from being averaged
 * into metrics; we still produce a valid shape so report rendering is uniform.
 */
function placeholderConsensus(): ConsensusOutcome {
  const now = Date.now();
  const emptyResult: ConsensusResult = {
    question: "",
    participants: [],
    rounds: [],
    roundsCompleted: 0,
    finalScore: 0,
    finalAverageConfidence: 0,
    finalStddev: 0,
    stopReason: "aborted",
    startedAt: now,
    completedAt: now,
    durationMs: 0,
  };
  return {
    result: emptyResult,
    finalScore: 0,
    finalAverageConfidence: 0,
    finalStddev: 0,
    roundsCompleted: 0,
    disagreementCount: 0,
    judgeConfidence: undefined,
    durationMs: 0,
    totalUsage: undefined,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new DOMException("Aborted", "AbortError");
  }
}
