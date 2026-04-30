// ─────────────────────────────────────────────────────────────
// Built-in preset slate
// ─────────────────────────────────────────────────────────────
// The five presets shipped in v0.11+. New presets land here when their
// definition files exist and snapshot tests pass.

import type { Preset } from "../types.js";
import { CODE_REVIEW_PRESET } from "./code-review.js";
import { ARCHITECTURE_DEBATE_PRESET } from "./architecture-debate.js";
import { RESEARCH_SYNTHESIS_PRESET } from "./research-synthesis.js";
import { DECISION_MAKING_PRESET } from "./decision-making.js";
import { DEBUG_POSTMORTEM_PRESET } from "./debug-postmortem.js";

export const BUILT_IN_PRESETS: readonly Preset[] = [
  CODE_REVIEW_PRESET,
  ARCHITECTURE_DEBATE_PRESET,
  RESEARCH_SYNTHESIS_PRESET,
  DECISION_MAKING_PRESET,
  DEBUG_POSTMORTEM_PRESET,
] as const;

export {
  CODE_REVIEW_PRESET,
  ARCHITECTURE_DEBATE_PRESET,
  RESEARCH_SYNTHESIS_PRESET,
  DECISION_MAKING_PRESET,
  DEBUG_POSTMORTEM_PRESET,
};
