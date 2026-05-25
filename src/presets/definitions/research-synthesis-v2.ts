// ─────────────────────────────────────────────────────────────
// Expert panel: research_synthesis_v2
// ─────────────────────────────────────────────────────────────
// Second-generation research synthesis. Citation discipline is enforced
// (unsupported claims are tagged 'panel inference'), independence is
// surfaced (which claims share assumptions vs. independently confirm),
// open questions are ranked by leverage.

import type { Preset } from "../types.js";

export const RESEARCH_SYNTHESIS_V2_PRESET: Preset = {
  id: "research_synthesis_v2",
  toolName: "consensus_research_synthesis_v2",
  title: "Research synthesis (v2)",
  description: [
    "Synthesise research, sources, or accumulated evidence on a topic, v2.",
    "",
    "Pass the question and any source material as `prompt` — abstracts, key findings,",
    "or your prior notes. The panel scrutinises evidence from four angles —",
    "methodological rigour, practitioner reality, mechanism-level reasoning, and",
    "forward-impact framing. The judge synthesises a citation-first report with",
    "HIGH/MEDIUM/LOW confidence per claim, an independence map (which claims share",
    "load-bearing assumptions), and an open-questions list ranked by leverage.",
    "",
    "Improvements over v1: every claim is tagged with evidence type (controlled study /",
    "field observation / panel inference); claims that rest on shared assumptions are",
    "explicitly grouped so callers don't mistake correlated risks for independent",
    "confirmations; open questions are ranked by how many conclusions they would shift.",
    "",
    "Best for: literature reviews, technology landscape scans, evaluating bodies of",
    "experimental results, 'what do we know about X' questions before high-stakes bets.",
  ].join("\n"),
  panel: [
    {
      personaId: "scientific-skeptic",
      required: true,
      taskSystemSuffix: [
        "TASK: research synthesis (v2).",
        "Demand evidence quality for every claim. For each: name the evidence type",
        "(randomized trial, controlled observational, uncontrolled observational,",
        "expert consensus, panel inference). Flag selection bias, p-hacking risk,",
        "sample-size issues, lack of independent replication, file-drawer effects.",
        "If the panel cites a finding without specifying the evidence type, push them.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: true,
      taskSystemSuffix: [
        "TASK: research synthesis (v2).",
        "Anchor in practitioner reality. Distinguish what holds up in deployed systems",
        "and real-world field studies from what only works in clean experimental",
        "conditions. When a finding contradicts what practitioners report, name the gap",
        "explicitly and propose the mechanism behind the gap (selection, scale, noise).",
      ].join("\n"),
    },
    {
      personaId: "first-principles",
      required: true,
      taskSystemSuffix: [
        "TASK: research synthesis (v2).",
        "Decompose each finding into its underlying mechanism. Identify when several",
        "findings rest on the same load-bearing assumption — those are correlated risks,",
        "not independent confirmations. Surface the shared assumption explicitly so the",
        "judge can flag claims that would all collapse together if the assumption fails.",
      ].join("\n"),
    },
    {
      personaId: "optimistic-futurist",
      required: false,
      fallbackPersonaIds: ["vc-specialist"],
      taskSystemSuffix: [
        "TASK: research synthesis (v2).",
        "Identify which findings, if true and scaled, would produce the largest forward",
        "impact, and rank the open questions by how many conclusions answering them",
        "would shift. Distinguish high-leverage questions (whose answer would change",
        "many downstream beliefs) from incremental ones.",
      ].join("\n"),
    },
  ],
  defaults: {
    maxRounds: 4,
    participantTemperature: 0.35,
    convergenceDelta: 3,
    disagreementThreshold: 18,
    blindFirstRound: true,
    randomizeOrder: true,
  },
  judgeSystemPrompt: [
    "You are synthesising a multi-reviewer research analysis (v2).",
    "",
    "Produce a citation-first report with this exact structure:",
    "  ## Claims and confidence",
    "  Numbered list of major claims. For each:",
    "    • The claim, in one sentence.",
    "    • Evidence type (randomized / controlled-observational / uncontrolled /",
    "      expert-consensus / panel-inference).",
    "    • Supporting source (cite from prompt or panel response).",
    "    • Confidence: HIGH / MEDIUM / LOW with one-line justification tied to evidence type.",
    "    • Strongest counter-evidence, if any.",
    "  ## Independence map",
    "  Group claims that rest on the same load-bearing assumption. Each group:",
    "  ‘Assumption X → Claims #1, #4, #7’. If X fails, the whole group fails.",
    "  ## Open questions, ranked by leverage",
    "  Numbered, most-leveraged first. For each: which downstream claims it would shift",
    "  if answered. One line each.",
    "  ## Where to dig next",
    "  Specific: papers to read, experiments to run, datasets to acquire.",
    "",
    "Do not invent citations. Claims not backed by the prompt or panel get tagged",
    "'panel inference' and downgraded to LOW unless mechanism-level reasoning makes",
    "them HIGH. State your synthesis confidence.",
  ].join("\n"),
  meta: {
    version: "2.0.0",
    rationale: [
      "v2 hardens the citation discipline by tagging every claim with explicit evidence",
      "type and adds the independence map — the most common research-synthesis failure",
      "is mistaking correlated confirmations (multiple papers built on the same shaky",
      "assumption) for independent validation. Open questions are now leverage-ranked",
      "so callers prioritize the right next investigation.",
    ].join(" "),
    expectedOutputShape: {
      sections: [
        {
          heading: "Claims and confidence",
          description:
            "Claims with evidence type, source, confidence ladder, and counter-evidence.",
        },
        {
          heading: "Independence map",
          description: "Claims grouped by shared load-bearing assumption.",
        },
        {
          heading: "Open questions, ranked by leverage",
          description:
            "Open questions ordered by how many downstream conclusions they would shift.",
        },
        {
          heading: "Where to dig next",
          description: "Specific papers, experiments, or datasets to pursue.",
        },
      ],
      tags: ["HIGH", "MEDIUM", "LOW", "panel-inference"],
    },
    tags: ["research", "synthesis", "v2", "evidence-based"],
  },
};
