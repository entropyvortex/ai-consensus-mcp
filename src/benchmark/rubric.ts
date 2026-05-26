// ─────────────────────────────────────────────────────────────
// Rubric evaluator — held-out LLM-as-judge quality scoring
// ─────────────────────────────────────────────────────────────
// Scores a single output against a panel-declared `RubricCriterion[]` by
// asking a held-out model (neither the judge nor the panel) to rate each
// criterion 0..maxPoints with a brief justification.
//
// The bench runner invokes this twice per run — once for the consensus
// output, once for the baseline output — and reports both alongside the
// existing self-reported confidence numbers. That gives a quality signal
// that is independent of either side's self-assessment.
//
// Kept deliberately thin: one model call, structured-output parsing with
// a tolerant JSON extractor, sentinel `errorMessage` on failure rather
// than thrown exceptions (a rubric eval failure shouldn't abort a bench
// suite, matching the contract used by baseline.ts).

import { z } from "zod";
import type { ModelCaller, TokenUsage } from "ai-consensus-core";
import type { RubricCriterion } from "../presets/types.js";

/** Score the evaluator emitted for one criterion. */
export interface RubricCriterionScore {
  criterionId: string;
  /** 0..maxPoints (clamped). */
  score: number;
  /** Evaluator's one-to-two-sentence justification. */
  justification: string;
}

/** Full rubric evaluation of a single output. */
export interface RubricEvaluation {
  evaluatorModelId: string;
  criteria: readonly RubricCriterionScore[];
  /** Sum of scores across criteria. */
  total: number;
  /** Sum of maxPoints across criteria. */
  maxTotal: number;
  /**
   * Integer 0..100, `Math.round((total / maxTotal) * 100)`. Mirrors the
   * 0..100 scale of consensus score and baseline confidence so the report
   * can put them side by side.
   */
  normalized: number;
  durationMs: number;
  usage: TokenUsage | undefined;
  /** Set when the evaluation failed; metrics filter on this. */
  errorMessage: string | undefined;
}

export interface EvaluateOutputArgs {
  caller: ModelCaller;
  evaluatorModelId: string;
  rubric: readonly RubricCriterion[];
  question: string;
  /** The output to score (consensus synthesis or baseline answer). */
  output: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

const DEFAULTS = {
  temperature: 0.1,
  maxOutputTokens: 2000,
} as const;

/** Zod shape we expect the evaluator to emit as JSON. */
const EvaluatorResponseSchema = z.object({
  scores: z
    .array(
      z.object({
        criterion_id: z.string().min(1),
        score: z.number(),
        justification: z.string().min(1),
      }),
    )
    .min(1),
});
type EvaluatorResponse = z.infer<typeof EvaluatorResponseSchema>;

/**
 * Build the evaluator's system prompt. The model is told it is judging
 * answer quality against named criteria, NOT picking a winner, NOT
 * comparing to anything else. The output is constrained to a single JSON
 * object with one entry per criterion.
 */
export function buildRubricSystemPrompt(rubric: readonly RubricCriterion[]): string {
  const criteriaLines = rubric.map((c) => `- "${c.id}" (0-${c.maxPoints}): ${c.description}`);
  return [
    "You are a quality evaluator. You are NOT writing an answer to the question — your only job is to score the given answer against the listed criteria.",
    "",
    "Score each criterion on the 0..maxPoints scale named in its label. Use the full range: 0 means the answer ignores the criterion entirely; max means the answer fully meets it. Mid-range scores are appropriate for partial coverage.",
    "",
    "Criteria:",
    ...criteriaLines,
    "",
    "Return a SINGLE JSON object with exactly this shape — no prose before or after, no markdown fences:",
    "",
    '{"scores":[{"criterion_id":"<id>","score":<number>,"justification":"<one or two sentences>"}, ...]}',
    "",
    "Include exactly one entry per criterion, in the order listed above. The justification must cite something specific from the answer (a phrase, a missing element, a vague vs measurable claim) — not generic praise or criticism.",
  ].join("\n");
}

/**
 * Build the user message: the question being answered + the answer being
 * evaluated. The answer is fenced so the evaluator can't confuse it with
 * its own output.
 */
export function buildRubricUserPrompt(args: { question: string; output: string }): string {
  return [
    "QUESTION (what the answer is trying to address):",
    args.question,
    "",
    "ANSWER TO EVALUATE (between the fences):",
    "<<<ANSWER>>>",
    args.output,
    "<<<END ANSWER>>>",
    "",
    "Score the answer against the criteria. Return only the JSON object.",
  ].join("\n");
}

/**
 * Evaluate one output against a rubric. Returns a `RubricEvaluation` with
 * `errorMessage` set on any failure (caller failure, malformed JSON,
 * mismatched criterion ids, schema violation). Never throws — bench
 * suites must complete even if a single eval fails.
 */
export async function evaluateOutput(args: EvaluateOutputArgs): Promise<RubricEvaluation> {
  const {
    caller,
    evaluatorModelId,
    rubric,
    question,
    output,
    temperature = DEFAULTS.temperature,
    maxOutputTokens = DEFAULTS.maxOutputTokens,
    signal,
  } = args;

  const maxTotal = rubric.reduce((acc, c) => acc + c.maxPoints, 0);
  const startedAt = Date.now();
  let usage: TokenUsage | undefined;
  let errorMessage: string | undefined;
  let parsed: EvaluatorResponse | undefined;

  try {
    const response = await caller({
      participantId: "rubric-evaluator",
      modelId: evaluatorModelId,
      round: 1,
      phase: "initial-analysis",
      system: buildRubricSystemPrompt(rubric),
      user: buildRubricUserPrompt({ question, output }),
      temperature,
      maxOutputTokens,
      ...(signal ? { signal } : {}),
    });
    usage = response.usage;

    const json = extractJsonObject(response.content);
    if (json === undefined) {
      throw new Error("evaluator did not emit a parseable JSON object");
    }
    const validation = EvaluatorResponseSchema.safeParse(json);
    if (!validation.success) {
      throw new Error(
        `evaluator JSON failed schema: ${validation.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    parsed = validation.data;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const completedAt = Date.now();
  const criteria: RubricCriterionScore[] = [];
  let total = 0;

  if (parsed) {
    const byId = new Map(parsed.scores.map((s) => [s.criterion_id, s]));
    for (const criterion of rubric) {
      const got = byId.get(criterion.id);
      if (!got) {
        // Missing criterion → treat as 0 and record in justification.
        criteria.push({
          criterionId: criterion.id,
          score: 0,
          justification: "(evaluator omitted this criterion)",
        });
        continue;
      }
      const clamped = clamp(got.score, 0, criterion.maxPoints);
      criteria.push({
        criterionId: criterion.id,
        score: clamped,
        justification: got.justification.trim(),
      });
      total += clamped;
    }
  }

  const normalized = maxTotal > 0 ? Math.round((total / maxTotal) * 100) : 0;

  return {
    evaluatorModelId,
    criteria,
    total,
    maxTotal,
    normalized,
    durationMs: completedAt - startedAt,
    usage,
    errorMessage,
  };
}

// ── Internals ────────────────────────────────────────────────

/**
 * Tolerant JSON object extractor. Models often wrap JSON in prose or in
 * markdown fences (```json …```). We try, in order:
 *
 *   1. `JSON.parse(content.trim())` — happy path when the model complied.
 *   2. The contents of the first ```…``` fenced block.
 *   3. The substring from the first `{` to the matched closing `}`.
 *
 * Returns `undefined` if no valid JSON object can be extracted. Linear-
 * time bracket scan; no regex backtracking (matches the parser hardening
 * convention used in ai-consensus-core).
 */
export function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fenced = extractFencedBlock(trimmed);
  if (fenced !== undefined) {
    const parsed = tryParse(fenced);
    if (parsed !== undefined) return parsed;
  }

  const braced = extractFirstBracedObject(trimmed);
  if (braced !== undefined) {
    const parsed = tryParse(braced);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

function tryParse(s: string): unknown {
  if (s.length === 0) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    // The evaluator contract is "a single JSON object" — bare arrays and
    // primitives are rejected here so callers don't have to redo the check.
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function extractFencedBlock(s: string): string | undefined {
  const fenceOpen = s.indexOf("```");
  if (fenceOpen === -1) return undefined;
  const afterOpenLine = s.indexOf("\n", fenceOpen);
  if (afterOpenLine === -1) return undefined;
  const fenceClose = s.indexOf("```", afterOpenLine);
  if (fenceClose === -1) return undefined;
  return s.slice(afterOpenLine + 1, fenceClose).trim();
}

/**
 * Walk the string from the first `{` forward, tracking brace depth while
 * respecting strings + escapes, and return the substring covering the
 * matching `}`. Linear time.
 */
function extractFirstBracedObject(s: string): string | undefined {
  const start = s.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
