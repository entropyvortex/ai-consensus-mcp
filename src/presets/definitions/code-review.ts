// ─────────────────────────────────────────────────────────────
// Preset: code_review
// ─────────────────────────────────────────────────────────────
// Multi-perspective code review. The panel surfaces defects, anti-patterns,
// stress-tests the design, and reasons from first principles about whether
// the change is the right shape at all. Judge synthesises a severity-ranked
// findings list.

import type { Preset } from "../types.js";

export const CODE_REVIEW_PRESET: Preset = {
  id: "code_review",
  toolName: "consensus_code_review",
  title: "Code review roundtable",
  description: [
    "Run a multi-perspective code review across the configured panel.",
    "",
    "Pass the diff, file, or change description as `prompt`. The panel reviews it from",
    "four angles in parallel — risk/defects, idiomatic patterns, hidden assumptions,",
    "and worst-case counter-arguments — then debates until a severity-ranked findings",
    "list converges. The judge synthesises a final review with BLOCKER/MAJOR/MINOR/NIT",
    "tags, line citations where possible, and a recommended-fix per issue.",
    "",
    "Best for: PR reviews, design-doc reviews, refactor sanity-checks. Tuned for",
    "low-temperature precision over wide-net brainstorming.",
  ].join("\n"),
  panel: [
    {
      personaId: "pessimist",
      required: true,
      taskSystemSuffix: [
        "TASK: code review.",
        "Surface defects, security risks, performance footguns, concurrency bugs,",
        "and tail-risk failure modes specific to the code in question. Cite line",
        "numbers when the diff or file makes them visible. Be precise about the",
        "conditions under which each risk fires — vague risk lists are noise.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: true,
      fallbackPersonaIds: ["first-principles"],
      taskSystemSuffix: [
        "TASK: code review.",
        "Anchor your review in idiomatic patterns and known anti-patterns for the",
        "language/framework actually used. Name the patterns explicitly. Propose",
        "concrete refactors when you flag something — not just 'this could be cleaner'.",
      ].join("\n"),
    },
    {
      personaId: "devils-advocate",
      required: false,
      fallbackPersonaIds: ["scientific-skeptic"],
      taskSystemSuffix: [
        "TASK: code review.",
        "Construct the strongest argument that the code as written is correct and",
        "appropriate. Then identify the most damaging counter-argument to your own",
        "case. The goal is to expose hidden weaknesses that pattern-matching review",
        "would miss.",
      ].join("\n"),
    },
    {
      personaId: "first-principles",
      required: false,
      taskSystemSuffix: [
        "TASK: code review.",
        "Decompose the change into its fundamental purpose. Question assumptions",
        "baked into the design — error models, ownership, lifecycle, mutability.",
        "If a simpler implementation would meet the requirement with less surface",
        "area, propose it concretely.",
      ].join("\n"),
    },
  ],
  defaults: {
    maxRounds: 3,
    participantTemperature: 0.3,
    convergenceDelta: 4,
    blindFirstRound: true,
    randomizeOrder: true,
  },
  judgeSystemPrompt: [
    "You are synthesising a multi-reviewer code review.",
    "",
    "Produce a final review with this exact structure:",
    "  ## Findings",
    "  A numbered list, severity-tagged: BLOCKER, MAJOR, MINOR, NIT.",
    "  For each finding: location (file/line if known), root cause, recommended fix.",
    "  ## Agreed",
    "  Bulleted list of issues every reviewer (independently or after the debate) flagged.",
    "  ## Disagreements",
    "  Bulleted list of issues where reviewers disagreed, with each side's reasoning",
    "  in one line. Do not pick a winner unless the technical case is unambiguous.",
    "  ## Out-of-scope but worth noting",
    "  Optional. Anything orthogonal to this change that the panel surfaced.",
    "",
    "Be specific. 'Consider extracting helper' is useless; 'extract foo() into",
    "shared/utils.ts:42 to deduplicate the parsing logic in three call-sites' is useful.",
  ].join("\n"),
};
