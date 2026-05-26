// ─────────────────────────────────────────────────────────────
// Built-in preset / expert-panel slate
// ─────────────────────────────────────────────────────────────
// The original 5 v1 presets (kept for backward compatibility) plus the
// 8 v2 expert panels shipped in v0.12+: architecture_v2, code_review_v2,
// research_synthesis_v2, decision_making_v2, incident_postmortem_v2,
// security_redteam, ml_research_2026, product_strategy.
//
// New panels land here when their definition file exists and the registry
// validator + snapshot tests pass.

import type { Preset } from "../types.js";
import { CODE_REVIEW_PRESET } from "./code-review.js";
import { ARCHITECTURE_DEBATE_PRESET } from "./architecture-debate.js";
import { RESEARCH_SYNTHESIS_PRESET } from "./research-synthesis.js";
import { DECISION_MAKING_PRESET } from "./decision-making.js";
import { DEBUG_POSTMORTEM_PRESET } from "./debug-postmortem.js";
import { ARCHITECTURE_V2_PRESET } from "./architecture-v2.js";
import { CODE_REVIEW_V2_PRESET } from "./code-review-v2.js";
import { RESEARCH_SYNTHESIS_V2_PRESET } from "./research-synthesis-v2.js";
import { DECISION_MAKING_V2_PRESET } from "./decision-making-v2.js";
import { INCIDENT_POSTMORTEM_V2_PRESET } from "./incident-postmortem-v2.js";
import { SECURITY_REDTEAM_PRESET } from "./security-redteam.js";
import { ML_RESEARCH_2026_PRESET } from "./ml-research-2026.js";
import { PRODUCT_STRATEGY_PRESET } from "./product-strategy.js";

export const BUILT_IN_PRESETS: readonly Preset[] = [
  CODE_REVIEW_PRESET,
  ARCHITECTURE_DEBATE_PRESET,
  RESEARCH_SYNTHESIS_PRESET,
  DECISION_MAKING_PRESET,
  DEBUG_POSTMORTEM_PRESET,
  ARCHITECTURE_V2_PRESET,
  CODE_REVIEW_V2_PRESET,
  RESEARCH_SYNTHESIS_V2_PRESET,
  DECISION_MAKING_V2_PRESET,
  INCIDENT_POSTMORTEM_V2_PRESET,
  SECURITY_REDTEAM_PRESET,
  ML_RESEARCH_2026_PRESET,
  PRODUCT_STRATEGY_PRESET,
] as const;

export {
  CODE_REVIEW_PRESET,
  ARCHITECTURE_DEBATE_PRESET,
  RESEARCH_SYNTHESIS_PRESET,
  DECISION_MAKING_PRESET,
  DEBUG_POSTMORTEM_PRESET,
  ARCHITECTURE_V2_PRESET,
  CODE_REVIEW_V2_PRESET,
  RESEARCH_SYNTHESIS_V2_PRESET,
  DECISION_MAKING_V2_PRESET,
  INCIDENT_POSTMORTEM_V2_PRESET,
  SECURITY_REDTEAM_PRESET,
  ML_RESEARCH_2026_PRESET,
  PRODUCT_STRATEGY_PRESET,
};
