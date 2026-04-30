// ─────────────────────────────────────────────────────────────
// Preset type definitions
// ─────────────────────────────────────────────────────────────
// A preset is a curated, opinionated bundle that turns one MCP tool
// call into a tuned consensus run for a specific use case (code review,
// architecture debate, etc.). Each preset declares:
//   • Which personas should be at the table.
//   • Per-task system-prompt overrides for those personas.
//   • Engine knobs (rounds, temperature, convergence) tuned for the task.
//   • Optional judge-prompt override.
//   • Optional extra tool-input fields and a custom result formatter.

import type { z } from "zod";
import type { ConsensusResult } from "ai-consensus-core";

/**
 * A persona id. Loose-typed (string) so user-defined personas can plug in
 * later without a type-system migration.
 */
export type PersonaId = string;

/**
 * Engine knobs a preset is allowed to set as defaults. A strict subset of
 * `ResolvedDefaults` from config.ts — `useJudge` is not preset-controlled
 * (that stays with the user's config), and every field is plain-optional
 * rather than `T | undefined` so preset definitions stay readable.
 *
 * Resolution order at call time, highest priority first:
 *   tool input → preset defaults → config defaults → engine defaults
 */
export interface PresetDefaults {
  maxRounds?: number;
  earlyStop?: boolean;
  convergenceDelta?: number;
  disagreementThreshold?: number;
  blindFirstRound?: boolean;
  randomizeOrder?: boolean;
  participantTemperature?: number;
  maxOutputTokens?: number;
}

/**
 * One seat at the preset's panel.
 */
export interface PresetPanelEntry {
  /** Persona id to match against `LoadedConfig.participants[].persona.id`. */
  personaId: PersonaId;
  /** If true, the preset cannot run when this persona is unconfigured. */
  required: boolean;
  /**
   * Appended to the persona's base `systemPrompt` for this preset's runs.
   * The base prompt is preserved — we mint a fresh persona object per call
   * rather than mutating the shared registry.
   */
  taskSystemSuffix: string;
  /**
   * If `personaId` is not configured by the user, try these in order. The
   * first match wins. A satisfied fallback applies the same `taskSystemSuffix`.
   */
  fallbackPersonaIds?: readonly PersonaId[];
}

/**
 * Forward-looking placeholder for Phase 3 (tool-calling). Unused in Phase 1.
 * Declared here so preset definitions can already reference the field name
 * without Phase 1 → Phase 3 re-shaping.
 */
export interface ToolBinding {
  /** Namespaced tool name (e.g. "fs:read_file"). */
  toolName: string;
}

/** Inputs handed to a preset's custom `formatResult`. */
export interface PresetCallInput {
  prompt: string;
  /** Extra fields parsed from the preset's `extraInputs` schema. */
  extras: Record<string, unknown>;
}

/** Optional per-preset markdown summary renderer. */
export type PresetResultFormatter = (result: ConsensusResult, input: PresetCallInput) => string;

/**
 * A complete preset definition. Pure data — no runtime side-effects.
 */
export interface Preset {
  /** Stable id (snake_case); also forms the tool name suffix. */
  id: string;
  /** Full MCP tool name. Convention: `consensus_${id}`. */
  toolName: `consensus_${string}`;
  /** Single-line title shown in the tool description heading. */
  title: string;
  /** Multi-line tool description — what it does and when to reach for it. */
  description: string;
  /** Personas at the table, in resolution-preference order. */
  panel: readonly PresetPanelEntry[];
  /** Engine knobs this preset prefers; the user's tool input args still win. */
  defaults: PresetDefaults;
  /** Optional task-specific judge system prompt. */
  judgeSystemPrompt?: string;
  /** Phase 3 surface — empty/unused in Phase 1. */
  toolBindings?: readonly ToolBinding[];
  /**
   * Extra zod fields merged into the base consensus tool-input shape. Each
   * preset can require its own typed payload (e.g. `code_review` requires
   * `paths` and/or `diff`).
   */
  extraInputs?: z.ZodRawShape;
  /** Optional custom markdown summary renderer. */
  formatResult?: PresetResultFormatter;
}

/**
 * Result of checking whether a preset can run given the user's current panel.
 * `runnable: false` carries the missing persona ids so error messages can
 * tell the operator exactly what they need to add.
 */
export type PresetRunnability =
  | { runnable: true }
  | { runnable: false; missingPersonaIds: readonly PersonaId[] };
