// ─────────────────────────────────────────────────────────────
// Expert panel: ml_research_2026
// ─────────────────────────────────────────────────────────────
// Critical evaluation of ML research claims, results, and proposals.
// The panel separates rigorous evidence from hype, anchors in
// deployment reality, decomposes claims to mechanism, and projects
// scaling implications honestly. Tuned for the 2026 ML landscape —
// where most papers ship demos and benchmarks but few survive
// production scaling and adversarial inputs intact.

import type { Preset } from "../types.js";

export const ML_RESEARCH_2026_PRESET: Preset = {
  id: "ml_research_2026",
  toolName: "consensus_ml_research_2026",
  title: "ML research critical review (2026)",
  description: [
    "Critically evaluate ML research claims — papers, benchmarks, model releases,",
    "agent demos, system designs — through a discipline-aware lens.",
    "",
    "Pass the abstract, paper, system card, or claim as `prompt` (include numbers",
    "where present — benchmark scores, scaling exponents, dataset sizes). The",
    "panel reviews from four angles — methodology rigour, practitioner reality,",
    "mechanism-level reasoning, and scaling/impact projection. The judge produces",
    "a claim taxonomy with evidence tier, methodological strength assessment,",
    "honest scaling implications, reproducibility risk, and concrete next",
    "experiments that would tighten the answer.",
    "",
    "Best for: deciding whether to chase a research direction, evaluating a",
    "competing approach, vetting an external benchmark before citing it, or",
    "stress-testing your own paper before submission. Calibrated for the post-",
    "2025 landscape where capability claims often outpace verification.",
  ].join("\n"),
  panel: [
    {
      personaId: "scientific-skeptic",
      required: true,
      taskSystemSuffix: [
        "TASK: ML research critical review.",
        "Demand methodology evidence for every claim. For benchmark numbers: was the",
        "test set contaminated by the training set? Were ablations done? Was the",
        "baseline tuned with comparable effort? Was the metric chosen post-hoc? For",
        "scaling laws: how many points are on the curve, what's the residual",
        "structure? For agent demos: were inputs cherry-picked, was the success rate",
        "reported on the full distribution? Cite the specific methodological gap.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: true,
      taskSystemSuffix: [
        "TASK: ML research critical review.",
        "Anchor in deployment reality. Which results would translate to production",
        "and which depend on the clean experimental conditions of the paper? Common",
        "gaps: latency budget, cost per query, adversarial inputs, distribution",
        "shift, long-tail user inputs, multi-turn coherence, prompt engineering",
        "fragility. Name the specific gap and the magnitude of the divergence you'd",
        "expect.",
      ].join("\n"),
    },
    {
      personaId: "first-principles",
      required: true,
      taskSystemSuffix: [
        "TASK: ML research critical review.",
        "Decompose each claim to its mechanism. Why does the proposed approach",
        "work — what mathematical, statistical, or computational primitive is being",
        "exploited? If the mechanism is unclear or load-bearing on a brittle",
        "assumption (sparsity, low rank, isotropy, scaling law continuity), name it.",
        "Identify which claims in the paper rest on the same assumption.",
      ].join("\n"),
    },
    {
      personaId: "optimistic-futurist",
      required: true,
      fallbackPersonaIds: ["vc-specialist"],
      taskSystemSuffix: [
        "TASK: ML research critical review.",
        "Project scaling implications honestly. If the result holds at 10× / 100× /",
        "1000× the reported compute or data, what changes downstream? Which",
        "currently-impossible tasks become tractable? Where does the trajectory",
        "saturate? Distinguish 'this generalizes' from 'this hits a known scaling",
        "wall' from 'this is a one-off benchmark optimization'. Be specific about",
        "the scale at which each conclusion flips.",
      ].join("\n"),
    },
  ],
  defaults: {
    maxRounds: 4,
    participantTemperature: 0.4,
    convergenceDelta: 3,
    disagreementThreshold: 18,
    blindFirstRound: true,
    randomizeOrder: true,
  },
  judgeSystemPrompt: [
    "You are synthesising a multi-reviewer ML research critical review.",
    "",
    "Produce an evidence-first report with this exact structure:",
    "  ## Claim taxonomy",
    "  Numbered list of major claims. For each:",
    "    • The claim, in one sentence.",
    "    • Evidence tier: RIGOROUS (peer-reviewed, replicated, ablated) /",
    "      CONTROLLED (single-paper, clean methodology) / SUGGESTIVE (preliminary,",
    "      methodology gaps) / ANECDOTAL (demos, cherry-picked).",
    "    • Methodological strength (2-3 sentences on what the evidence is and isn't).",
    "    • Practitioner-reality gap, if any (what changes in deployment).",
    "  ## Scaling implications",
    "  If the central claim holds at 10× / 100× / 1000× the reported scale, what",
    "  follows? Where does it saturate? What's the specific signal of saturation?",
    "  ## Reproducibility risk",
    "  HIGH / MEDIUM / LOW with one-line basis. Name the specific factor that",
    "  drives the risk (data not released, eval scripts withheld, hyperparameters",
    "  not disclosed, etc.).",
    "  ## Next experiments to run",
    "  Numbered, highest information-gain first. For each: the experiment, what it",
    "  resolves, and the rough cost (compute-days, FLOPs, or analyst-weeks).",
    "  ## Bottom line",
    "  2-4 sentences. Should the reader build on this, watch it, or discount it?",
    "  State your confidence.",
    "",
    "Do not invent numbers. If a claim is unsupported by the prompt, tag it",
    "ANECDOTAL and lower the confidence. Use the panel's specific citations.",
  ].join("\n"),
  meta: {
    version: "1.0.0",
    rationale: [
      "ML in 2026 is a landscape where capability claims accelerate faster than",
      "verification. This panel forces every claim into one of four evidence tiers",
      "and demands the practitioner-reality gap be named explicitly — the most",
      "common failure of paper readers is conflating benchmark performance with",
      "deployment behaviour. Scaling implications are required, not optional,",
      "because the question that matters is 'does this hold at the next scale.'",
    ].join(" "),
    expectedOutputShape: {
      sections: [
        { heading: "Claim taxonomy", description: "Claims with evidence tier, methodological strength, and practitioner gap." },
        { heading: "Scaling implications", description: "Honest projection at 10×/100×/1000× with saturation signals." },
        { heading: "Reproducibility risk", description: "Risk level with named drivers (data, eval, hyperparams)." },
        { heading: "Next experiments to run", description: "Information-gain-ranked experiments with cost estimates." },
        { heading: "Bottom line", description: "Build-on / watch / discount verdict with confidence." },
      ],
      tags: ["RIGOROUS", "CONTROLLED", "SUGGESTIVE", "ANECDOTAL", "HIGH", "MEDIUM", "LOW"],
    },
    tags: ["ml", "research", "evidence-based", "2026"],
  },
};
