// ─────────────────────────────────────────────────────────────
// Baseline runner — single model, no panel, no debate
// ─────────────────────────────────────────────────────────────
// Issues one ModelCaller request against the baseline model with a
// neutral domain-expert prompt, then parses the trailing CONFIDENCE
// marker. The result is the "what if you just asked one capable model"
// reference that consensus runs are scored against.
//
// Kept deliberately thin: no retries, no streaming, no persona overlays.
// The whole point of the comparison is that this side is unembellished.

import type { ModelCaller, TokenUsage } from "ai-consensus-core";
import { extractConfidence } from "ai-consensus-core";
import type { BaselineOutcome } from "./types.js";

/**
 * Neutral baseline system prompt. Deliberately persona-free — the goal is
 * to measure "what a single capable model answers when asked directly,"
 * not "what a specialist persona answers." Confidence contract matches
 * the participant contract so `extractConfidence` works verbatim.
 */
export const BASELINE_SYSTEM_PROMPT = `You are a careful senior domain expert. Answer the question directly with concrete recommendations and specific examples. Acknowledge genuine uncertainty rather than hedging. Be decisive where the evidence allows.

IMPORTANT: End your response with a line in exactly this format:
CONFIDENCE: [number 0-100]`;

export interface RunBaselineArgs {
  caller: ModelCaller;
  modelId: string;
  question: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

const DEFAULTS = {
  temperature: 0.7,
  maxOutputTokens: 1500,
} as const;

/**
 * Run the baseline against a single question. The caller is expected to
 * route `modelId` to its provider (or to a mock implementation in tests).
 *
 * Errors from the caller are captured into `BaselineOutcome.errorMessage`
 * rather than thrown — a baseline failure shouldn't abort an entire bench
 * suite, the same contract the engine uses for participant errors.
 */
export async function runBaseline(args: RunBaselineArgs): Promise<BaselineOutcome> {
  const {
    caller,
    modelId,
    question,
    temperature = DEFAULTS.temperature,
    maxOutputTokens = DEFAULTS.maxOutputTokens,
    signal,
  } = args;

  const startedAt = Date.now();
  let content = "";
  let usage: TokenUsage | undefined;
  let errorMessage: string | undefined;

  try {
    const response = await caller({
      participantId: "baseline",
      modelId,
      round: 1,
      phase: "initial-analysis",
      system: BASELINE_SYSTEM_PROMPT,
      user: question,
      temperature,
      maxOutputTokens,
      ...(signal ? { signal } : {}),
    });
    content = response.content;
    usage = response.usage;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    content = `[baseline error from ${modelId}: ${errorMessage}]`;
  }

  const completedAt = Date.now();
  const confidence = errorMessage ? 0 : extractConfidence(content);

  return {
    modelId,
    content,
    confidence,
    durationMs: completedAt - startedAt,
    usage,
    errorMessage,
  };
}
