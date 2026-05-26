// ─────────────────────────────────────────────────────────────
// Expert panel: architecture_v2
// ─────────────────────────────────────────────────────────────
// Second-generation architecture-decision debate. Tighter than v1: every
// suffix demands quantification or explicit "missing input" naming;
// reversibility is a first-class column in the decision matrix; the
// judge must name the tripwires that flip the recommendation.

import type { Preset } from "../types.js";

export const ARCHITECTURE_V2_PRESET: Preset = {
  id: "architecture_v2",
  toolName: "consensus_architecture_v2",
  title: "Architecture decision debate (v2)",
  description: [
    "Run a multi-perspective debate over an architecture or design decision, v2.",
    "",
    "Pass the proposed design, the question to settle, or the choice to make as `prompt`.",
    "The panel debates from five angles — fundamentals, operational reality, optionality,",
    "production worst-case, and steelmanned counter-case — over four rounds. The judge",
    "produces a decision matrix with reversibility, a single recommendation, and the",
    "tripwire conditions that flip the recommendation.",
    "",
    "Improvements over v1: reversibility is required, quantification is enforced",
    "(name the unit when you can; name the missing input when you can't), and",
    "tripwires must be specific signals, not vague conditions.",
    "",
    "Best for: build-vs-buy, microservices-vs-monolith, sync-vs-async, schema design,",
    "vendor selection, capacity planning, platform migration.",
  ].join("\n"),
  panel: [
    {
      personaId: "first-principles",
      required: true,
      taskSystemSuffix: [
        "TASK: architecture decision debate (v2).",
        "Reduce the proposal to its fundamental constraints — latency budget, consistency",
        "model, cost ceiling, team capacity, data volume, time horizon. Quantify each",
        "constraint with a unit (ms, $/month, headcount, GB/day). If a constraint is",
        "unstated, name it explicitly and propose a defensible value. Reject analogies",
        "and best-practice citations until the primitives are agreed.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: true,
      taskSystemSuffix: [
        "TASK: architecture decision debate (v2).",
        "Bring concrete operational experience: known failure modes, scaling cliffs",
        "(at what QPS, what data volume), on-call burden in pager-events/week,",
        "observability cost in $/month, upgrade-in-flight pain, vendor lock-in shapes.",
        "Cite specific systems or patterns by name. Anchor with at least one prior",
        "deployment you've seen at the same shape.",
      ].join("\n"),
    },
    {
      personaId: "vc-specialist",
      required: false,
      fallbackPersonaIds: ["optimistic-futurist"],
      taskSystemSuffix: [
        "TASK: architecture decision debate (v2).",
        "Evaluate the decision as an investment with explicit optionality framing:",
        "time-to-market impact, capital efficiency, doors closed by each option,",
        "reversibility cost if we're wrong, switching cost in person-months. Frame",
        "each option as a portfolio bet — what do you keep optional, what do you",
        "commit to?",
      ].join("\n"),
    },
    {
      personaId: "pessimist",
      required: true,
      taskSystemSuffix: [
        "TASK: architecture decision debate (v2).",
        "Identify what breaks in production over a 12- and 36-month horizon: tail",
        "latencies under load, partial failures, capacity exhaustion thresholds,",
        "cascading retries, replication lag, data drift, on-call paging frequency.",
        "Each risk must include (a) the failure mode, (b) the specific trigger,",
        "(c) detection latency, (d) blast radius, (e) recovery cost.",
      ].join("\n"),
    },
    {
      personaId: "devils-advocate",
      required: false,
      fallbackPersonaIds: ["scientific-skeptic"],
      taskSystemSuffix: [
        "TASK: architecture decision debate (v2).",
        "Steelman the option the panel is converging away from. Construct the",
        "strongest case for the underdog: what would have to be true for the rejected",
        "option to be the right call? Surface that condition explicitly — it",
        "becomes a tripwire in the final synthesis.",
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
    "You are synthesising an architecture-decision debate (v2).",
    "",
    "Produce a decision report with this exact structure:",
    "  ## Constraint surface",
    "  Bulleted list of the load-bearing constraints the panel agreed on, each with",
    "  a unit. Mark constraints that were assumed (not stated in prompt) with ‹assumed›.",
    "  ## Decision matrix",
    "  Table: | Option | Approach | Key trade-off | Risk (1-5) | Reversibility (low/med/high) | Switching cost |",
    "  ## Recommendation",
    "  A single recommended architecture in 3-6 sentences. Lead with the choice,",
    "  then the dominant reason, then the next-best alternative and what tilts toward it.",
    "  ## Tripwire conditions",
    "  Bulleted: the specific signals — measurable thresholds, not vague conditions —",
    "  under which the recommendation flips. 'If write QPS sustains >5k for 24h'",
    "  beats 'if scale grows.'",
    "  ## Open questions",
    "  Anything the panel could not resolve without information they didn't have.",
    "",
    "Do not hedge by recommending two options. Pick one. State your confidence.",
  ].join("\n"),
  rubric: [
    {
      id: "quantification",
      description:
        "Does the answer cite load-bearing constraints with units (ms, $/month, headcount, GB/day, QPS, percentiles), or explicitly name an unstated constraint with a proposed value? A 5/5 answer reads like an engineer with a spreadsheet; a 0/5 reads like a vibes essay.",
      maxPoints: 5,
    },
    {
      id: "single-recommendation",
      description:
        "Does the answer commit to a single architecture choice with a dominant reason, rather than hedging between two? A 5/5 answer names the recommended option in one sentence and names the next-best alternative only as the runner-up; a 0/5 presents a balanced menu and refuses to choose.",
      maxPoints: 5,
    },
    {
      id: "reversibility",
      description:
        "Does the answer explicitly weigh reversibility / switching cost — the cost of being wrong about this decision? A 5/5 answer treats reversibility as a first-class column with at least a low/medium/high rating per option and a switching cost estimate; a 0/5 ignores reversibility entirely.",
      maxPoints: 5,
    },
    {
      id: "tripwire-specificity",
      description:
        "Are the conditions that would flip the recommendation named as measurable signals with thresholds (e.g. 'write QPS sustains >5k for 24h', 'P99 latency exceeds 200ms for 1h'), not vague conditions ('if scale grows', 'if reliability becomes a concern')? A 5/5 answer has tripwires you could literally write a Prometheus alert against; a 0/5 has hand-waving.",
      maxPoints: 5,
    },
    {
      id: "failure-mode-realism",
      description:
        "Are failure modes named with concrete trigger conditions, blast radius, and detection latency — not generic risks? A 5/5 answer names specific failure modes a senior on-call engineer would recognise from incidents they've actually worked; a 0/5 lists abstract risks ('complexity', 'scaling issues') with no shape.",
      maxPoints: 5,
    },
  ],
  meta: {
    version: "2.0.0",
    rationale: [
      "v2 tightens v1's good-but-loose architecture debate by enforcing quantification,",
      "adding reversibility as a first-class matrix column, and requiring tripwires to be",
      "specific measurable signals. The Devil's Advocate seat (optional in v1) is now",
      "required when configured, ensuring the steelmanned counter-case is always voiced.",
    ].join(" "),
    expectedOutputShape: {
      sections: [
        {
          heading: "Constraint surface",
          description: "Load-bearing constraints with units; assumed values tagged.",
        },
        {
          heading: "Decision matrix",
          description: "Table comparing options on trade-off, risk, reversibility, switching cost.",
        },
        {
          heading: "Recommendation",
          description:
            "Single recommended architecture with dominant reason and next-best alternative.",
        },
        {
          heading: "Tripwire conditions",
          description: "Specific measurable signals that would flip the recommendation.",
        },
        {
          heading: "Open questions",
          description: "Unresolved questions blocked on missing information.",
        },
      ],
      tags: ["reversibility:low", "reversibility:medium", "reversibility:high"],
    },
    tags: ["architecture", "decision-support", "v2", "high-stakes"],
  },
};
