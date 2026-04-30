// ─────────────────────────────────────────────────────────────
// Build the MCP tool input schema for a preset
// ─────────────────────────────────────────────────────────────
// Each preset is advertised as its own MCP tool (`consensus_<id>`).
// Their input schemas all share a common base — the same engine
// knobs as the generic `consensus` tool, minus `participantIds`
// (the preset owns the panel).
//
// `Preset.extraInputs` is forward-looking (Phase 3): when tool-calling
// lands and a preset like `code_review` wants to require `paths` so
// participants can `fs:read_file` them. Phase 1 ships with no extras
// across all five presets — the path is in place but unused.

import { z } from "zod";
import type { Preset } from "./types.js";

// ── Shared base for every preset tool ────────────────────────

export const PRESET_INPUT_BASE_FIELDS = {
  prompt: z.string().min(1),
  maxRounds: z.number().int().min(1).max(10).optional(),
  earlyStop: z.boolean().optional(),
  convergenceDelta: z.number().min(0).optional(),
  disagreementThreshold: z.number().min(0).optional(),
  blindFirstRound: z.boolean().optional(),
  randomizeOrder: z.boolean().optional(),
  participantTemperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  judge: z.boolean().optional(),
  randomSeed: z.number().int().nonnegative().optional(),
} as const;

// JSON Schema mirror — kept hand-written for the same reason the generic
// `consensus` tool's schema is: what's advertised must equal what's enforced,
// without a runtime translator in between. Preset extras (Phase 3+) will
// merge into the `properties` and `required` fields of this base.
export const PRESET_INPUT_BASE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      description: "The question, code, or topic to run the preset on.",
    },
    maxRounds: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description: "Maximum CVP rounds. Default: preset-tuned, then config.defaults.",
    },
    earlyStop: { type: "boolean", description: "Stop when consensus converges. Default: true." },
    convergenceDelta: {
      type: "number",
      minimum: 0,
      description: "Convergence threshold on the score delta. Default: 3.",
    },
    disagreementThreshold: {
      type: "number",
      minimum: 0,
      description: "Confidence-delta threshold for disagreement detection. Default: 20.",
    },
    blindFirstRound: {
      type: "boolean",
      description: "Round 1 in parallel with no cross-visibility. Default: true.",
    },
    randomizeOrder: { type: "boolean", description: "Shuffle speaking order on rounds 2+." },
    participantTemperature: {
      type: "number",
      minimum: 0,
      maximum: 2,
      description: "Sampling temperature for participants. Default: preset-tuned.",
    },
    maxOutputTokens: {
      type: "integer",
      minimum: 1,
      description: "Max output tokens per participant call.",
    },
    judge: {
      type: "boolean",
      description: "Run the judge synthesizer after the final round. Default: true if configured.",
    },
    randomSeed: {
      type: "integer",
      minimum: 0,
      description: "Seeds the round-order shuffle for deterministic replay.",
    },
  },
} as const;

// ── Per-preset builders ──────────────────────────────────────

export type PresetInputZodSchema = z.ZodObject<z.ZodRawShape>;

/**
 * Build the zod schema for a preset's MCP tool input. Phase 1 ignores
 * `extraInputs` (no preset declares any); Phase 3 wires them in.
 */
export function buildPresetZodSchema(preset: Preset): PresetInputZodSchema {
  if (preset.extraInputs && Object.keys(preset.extraInputs).length > 0) {
    return z.object({
      ...PRESET_INPUT_BASE_FIELDS,
      ...preset.extraInputs,
    });
  }
  return z.object(PRESET_INPUT_BASE_FIELDS);
}

/**
 * Build the JSON Schema advertised to MCP hosts for a preset's tool. The
 * schema's `description` is rooted in the preset's own description so
 * hosts surface the right per-tool guidance to users.
 *
 * Phase 1 shape: identical for every preset (extras unused). Phase 3 will
 * add `properties` and `required` entries from `preset.extraInputs`.
 */
export function buildPresetJsonSchema(_preset: Preset): Record<string, unknown> {
  // Forward-compatible hook: presets MAY ship a hand-written JSON Schema for
  // their extras alongside the zod parser. The `_preset` parameter is reserved
  // for that wiring (Phase 3); Phase 1 produces the same base shape for every
  // preset. Intentionally no zod→JSON-Schema converter — the existing
  // hand-written approach keeps what's advertised in lockstep with what the
  // server enforces, with no runtime translator in between.
  return {
    type: "object",
    additionalProperties: false,
    required: [...PRESET_INPUT_BASE_JSON_SCHEMA.required],
    properties: { ...PRESET_INPUT_BASE_JSON_SCHEMA.properties },
  };
}
