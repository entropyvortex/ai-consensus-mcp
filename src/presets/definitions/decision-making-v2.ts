// ─────────────────────────────────────────────────────────────
// Expert panel: decision_making_v2
// ─────────────────────────────────────────────────────────────
// Second-generation decision support. Each option carries quantified
// expected-value where possible (with the missing inputs named where
// not), explicit reversibility, tripwires that flip the ranking, and
// the bets the panel is consciously NOT making.

import type { Preset } from "../types.js";

export const DECISION_MAKING_V2_PRESET: Preset = {
  id: "decision_making_v2",
  toolName: "consensus_decision_making_v2",
  title: "Decision support (v2)",
  description: [
    "Run a structured decision-making analysis across the configured panel, v2.",
    "",
    "Pass the decision and candidate options as `prompt` (or describe the situation",
    "and let the panel surface options). The panel evaluates from four angles —",
    "expected value, worst-case stress test, prior-decision precedent, and strongest",
    "counter-argument — then debates. The judge produces a ranked options list with",
    "EV reasoning, reversibility, tripwire signals, and an explicit 'bets not made'",
    "section so the decision context survives in memory.",
    "",
    "Improvements over v1: every option carries reversibility (low/med/high), every",
    "ranking comes with the specific signals that would flip it, and the synthesis",
    "names what the panel is consciously not optimizing for — preventing later",
    "second-guessing without context.",
    "",
    "Best for: hiring/firing, vendor selection, scope cuts, product bets, contract",
    "terms, where to spend the next quarter.",
  ].join("\n"),
  panel: [
    {
      personaId: "vc-specialist",
      required: true,
      fallbackPersonaIds: ["first-principles"],
      taskSystemSuffix: [
        "TASK: decision analysis (v2).",
        "Frame each option through expected value with units: payoff distribution",
        "(magnitude × probability), optionality preserved, capital cost, time-to-impact,",
        "reversibility (low/med/high). Quantify with numbers where you can; when you",
        "can't, name the missing input you would need and propose a defensible value.",
      ].join("\n"),
    },
    {
      personaId: "pessimist",
      required: true,
      taskSystemSuffix: [
        "TASK: decision analysis (v2).",
        "Stress-test the worst credible outcome of each option at 12 and 36 months.",
        "Be specific: what does failure look like, what triggers it, who bears the",
        "cost, what's the early signal that we're inside the failure scenario?",
        "Distinguish ruinous risks (recovery cost = company death) from costly-but-",
        "recoverable ones.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: true,
      taskSystemSuffix: [
        "TASK: decision analysis (v2).",
        "Anchor in concrete prior decisions in adjacent contexts — what worked, what",
        "didn't, what surprised the deciders. Name decisions specifically (company,",
        "year, outcome). Generic 'I've seen this go badly' is weak. Identify which",
        "of those priors are most analogous and which are misleading.",
      ].join("\n"),
    },
    {
      personaId: "devils-advocate",
      required: false,
      fallbackPersonaIds: ["scientific-skeptic"],
      taskSystemSuffix: [
        "TASK: decision analysis (v2).",
        "For each option, construct the strongest argument that it's wrong. Watch for",
        "anchoring on the first option proposed and for sunk-cost framing. Surface",
        "the implicit second-order effects each option has on adjacent decisions",
        "(team morale, customer trust, vendor relationships).",
      ].join("\n"),
    },
  ],
  defaults: {
    maxRounds: 4,
    participantTemperature: 0.45,
    convergenceDelta: 3,
    disagreementThreshold: 18,
    blindFirstRound: true,
    randomizeOrder: true,
  },
  judgeSystemPrompt: [
    "You are synthesising a decision analysis (v2).",
    "",
    "Produce a ranked-options report with this exact structure:",
    "  ## Ranked options",
    "  Numbered, best-to-worst. For each option:",
    "    • One-sentence summary.",
    "    • EV rationale (quantified with units where possible; missing inputs named).",
    "    • Reversibility: LOW / MEDIUM / HIGH with a one-line basis.",
    "    • Top 3 risks (specific, with the early signal that surfaces each).",
    "    • Top 3 upsides.",
    "    • Panel agreement strength: 0-100.",
    "  ## Recommendation",
    "  The single option recommended. Lead with the choice, then the dominant",
    "  reason, in 3-6 sentences.",
    "  ## Tripwire conditions",
    "  Bulleted: specific signals — measurable thresholds, not vague conditions —",
    "  that would flip the recommendation to the next-ranked option.",
    "  ## Bets we're consciously not making",
    "  What the panel ranked low and why. Preserves the decision context so a future",
    "  reviewer doesn't undo the call without remembering the rejected alternatives.",
    "  ## Information we still need",
    "  What the panel flagged as missing. Name what to gather and why it matters.",
    "",
    "Do not present a list of equal options. Rank them. State your confidence.",
  ].join("\n"),
  meta: {
    version: "2.0.0",
    rationale: [
      "v2 adds two structural elements v1 missed: reversibility as a first-class",
      "column on every option, and the 'bets we're consciously not making' section",
      "that preserves the rejected alternatives. Both target the same failure mode —",
      "decisions that get second-guessed in 6 months because the context evaporated.",
    ].join(" "),
    expectedOutputShape: {
      sections: [
        {
          heading: "Ranked options",
          description:
            "Best-to-worst with EV, reversibility, risks, upsides, and agreement strength.",
        },
        {
          heading: "Recommendation",
          description: "Single recommended option with dominant reason.",
        },
        {
          heading: "Tripwire conditions",
          description: "Specific measurable signals that would flip the ranking.",
        },
        {
          heading: "Bets we're consciously not making",
          description: "Rejected alternatives, preserving decision context.",
        },
        {
          heading: "Information we still need",
          description: "Missing inputs and why they matter.",
        },
      ],
      tags: ["LOW", "MEDIUM", "HIGH"],
    },
    tags: ["decision-support", "v2", "high-stakes"],
  },
};
