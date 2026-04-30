// ─────────────────────────────────────────────────────────────
// Preset: architecture_debate
// ─────────────────────────────────────────────────────────────
// Trade-off-driven debate over an architecture or design decision.
// The panel reasons from first principles, weighs operational cost,
// considers capital/time-to-market trade-offs, and stress-tests the
// worst credible production outcome. Judge produces a decision matrix.

import type { Preset } from "../types.js";

export const ARCHITECTURE_DEBATE_PRESET: Preset = {
  id: "architecture_debate",
  toolName: "consensus_architecture_debate",
  title: "Architecture decision debate",
  description: [
    "Run a multi-perspective debate over an architecture or design decision.",
    "",
    "Pass the proposed design, the question to settle, or the choice to make as `prompt`.",
    "The panel debates from four angles — fundamentals, operational reality,",
    "investment / opportunity-cost, and worst-case production behaviour — over four",
    "rounds. The judge synthesises a decision matrix with explicit trade-offs and a",
    "single recommended path with the conditions under which it flips.",
    "",
    "Best for: build-vs-buy, microservices-vs-monolith, sync-vs-async, schema design,",
    "vendor selection, capacity planning. Mid-temperature: open enough to surface",
    "alternatives, disciplined enough to converge.",
  ].join("\n"),
  panel: [
    {
      personaId: "first-principles",
      required: true,
      taskSystemSuffix: [
        "TASK: architecture decision debate.",
        "Reduce the proposal to its fundamental constraints — latency budget, consistency",
        "model, cost ceiling, team capacity, time horizon. Reject analogies and",
        "best-practice citations until the primitives are agreed. If the constraints",
        "are unstated, name them and propose values.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: true,
      taskSystemSuffix: [
        "TASK: architecture decision debate.",
        "Bring concrete operational experience: known failure modes of similar systems,",
        "scaling cliffs, on-call burden, observability cost, upgrade-in-flight pain,",
        "vendor lock-in patterns. Cite specific systems or patterns by name when you can.",
      ].join("\n"),
    },
    {
      personaId: "vc-specialist",
      required: false,
      fallbackPersonaIds: ["optimistic-futurist"],
      taskSystemSuffix: [
        "TASK: architecture decision debate.",
        "Evaluate the decision as an investment: build vs. buy, opportunity cost,",
        "time-to-market impact, capital efficiency, optionality preserved or lost.",
        "Frame it in terms of the cap table of decisions that follow from this one —",
        "which doors does each option close?",
      ].join("\n"),
    },
    {
      personaId: "pessimist",
      required: true,
      taskSystemSuffix: [
        "TASK: architecture decision debate.",
        "Identify what breaks in production over a 12-month horizon: tail latencies,",
        "partial failures, capacity exhaustion, cascading retries, replication lag,",
        "data drift, on-call paging frequency. Be specific about the failure mode and",
        "what triggers it.",
      ].join("\n"),
    },
  ],
  defaults: {
    maxRounds: 4,
    participantTemperature: 0.6,
    convergenceDelta: 3,
    disagreementThreshold: 18,
    blindFirstRound: true,
    randomizeOrder: true,
  },
  judgeSystemPrompt: [
    "You are synthesising an architecture-decision debate.",
    "",
    "Produce a decision report with this structure:",
    "  ## Decision matrix",
    "  Rows = the major design choices surfaced by the debate.",
    "  Columns = | Option | Approach | Key trade-off | Risk (1-5) | Reversibility |",
    "  ## Recommendation",
    "  A single recommended architecture, in 3-6 sentences. Lead with the choice,",
    "  then the dominant reason, then the next-best alternative.",
    "  ## When to pick something else",
    "  Bulleted: the conditions under which the recommendation flips. Be specific —",
    "  'if write QPS exceeds N' beats 'if scale grows'.",
    "  ## Open questions",
    "  Anything the panel could not resolve without information they didn't have.",
    "",
    "Do not hedge by recommending two options. Pick one. State your confidence.",
  ].join("\n"),
};
