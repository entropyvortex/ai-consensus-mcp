// ─────────────────────────────────────────────────────────────
// Preset: decision_making
// ─────────────────────────────────────────────────────────────
// Ranked-options decision support. The panel frames the decision in
// expected-value terms, stress-tests worst credible outcomes, anchors in
// concrete prior decisions, and constructs the strongest argument against
// each option. Judge produces a ranked list with the conditions under
// which the recommendation flips.

import type { Preset } from "../types.js";

export const DECISION_MAKING_PRESET: Preset = {
  id: "decision_making",
  toolName: "consensus_decision_making",
  title: "Decision support",
  description: [
    "Run a structured decision-making analysis across the configured panel.",
    "",
    "Pass the decision and the candidate options as `prompt` (or describe the",
    "situation and let the panel surface options). The panel evaluates from four",
    "angles — expected value, worst-case stress test, prior-decision precedent, and",
    "strongest counter-arguments — over four rounds. The judge produces a ranked",
    "options list with explicit pros/cons and the conditions under which the",
    "ranking flips.",
    "",
    "Best for: hiring/firing, vendor selection, project prioritisation, scope cuts,",
    "product strategy bets, contract terms. Mid temperature for creative option",
    "expansion balanced with discipline.",
  ].join("\n"),
  panel: [
    {
      personaId: "vc-specialist",
      required: true,
      fallbackPersonaIds: ["first-principles"],
      taskSystemSuffix: [
        "TASK: decision analysis.",
        "Frame each option through expected value: payoff distribution, optionality",
        "preserved, capital cost, time-to-impact, reversibility. Quantify when you can.",
        "If the prompt is missing the data needed to estimate EV, name the missing",
        "inputs explicitly.",
      ].join("\n"),
    },
    {
      personaId: "pessimist",
      required: true,
      taskSystemSuffix: [
        "TASK: decision analysis.",
        "Stress-test the worst credible outcome of each option, 12 and 36 months out.",
        "Be specific: what does failure look like, what triggers it, who bears the cost,",
        "how do you know it's happening? Distinguish ruinous risks from costly-but-",
        "recoverable ones.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: true,
      taskSystemSuffix: [
        "TASK: decision analysis.",
        "Anchor in concrete examples of similar decisions made in adjacent contexts —",
        "what worked, what didn't, what surprised the deciders. Name the",
        "decisions specifically when you can; generic 'I've seen this before' is weak.",
      ].join("\n"),
    },
    {
      personaId: "devils-advocate",
      required: false,
      fallbackPersonaIds: ["scientific-skeptic"],
      taskSystemSuffix: [
        "TASK: decision analysis.",
        "For each option, construct the strongest argument that it's the wrong choice.",
        "Force the panel to defend their reasoning, not their preferences. Watch for",
        "anchoring on the first option proposed and for sunk-cost framing.",
      ].join("\n"),
    },
  ],
  defaults: {
    maxRounds: 4,
    participantTemperature: 0.5,
    convergenceDelta: 3,
    disagreementThreshold: 18,
    blindFirstRound: true,
    randomizeOrder: true,
  },
  judgeSystemPrompt: [
    "You are synthesising a decision analysis.",
    "",
    "Produce a ranked-options report with this structure:",
    "  ## Ranked options",
    "  Numbered, best-to-worst. For each option:",
    "    • One-sentence summary",
    "    • Expected-value rationale (1-3 sentences, quantified where possible)",
    "    • Top 3 risks (specific, not generic)",
    "    • Top 3 upsides",
    "    • Panel agreement strength: 0-100",
    "  ## Recommendation",
    "  The single option you recommend. Lead with the choice, then the dominant",
    "  reason, in 3-6 sentences.",
    "  ## When the recommendation flips",
    "  Bulleted: specific conditions under which a different option becomes the right",
    "  call. 'If X happens before Y' beats 'if circumstances change'.",
    "  ## Information we still need",
    "  Anything the panel flagged as missing. Name what to gather and why it matters.",
    "",
    "Do not present a list of equal options. Rank them. State your confidence.",
  ].join("\n"),
};
