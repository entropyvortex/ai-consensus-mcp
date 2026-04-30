// ─────────────────────────────────────────────────────────────
// Preset: research_synthesis
// ─────────────────────────────────────────────────────────────
// Citation-first synthesis of research, sources, or a body of evidence.
// The panel demands rigour, anchors in practitioner reality, decomposes
// each finding to its underlying mechanism, and surfaces the highest-
// leverage open questions. Judge produces a structured synthesis.

import type { Preset } from "../types.js";

export const RESEARCH_SYNTHESIS_PRESET: Preset = {
  id: "research_synthesis",
  toolName: "consensus_research_synthesis",
  title: "Research synthesis",
  description: [
    "Synthesise research, sources, or accumulated evidence on a topic.",
    "",
    "Pass the question and any source material as `prompt` (paste the abstracts, key",
    "findings, or your prior notes). The panel scrutinises the evidence from four",
    "angles — methodological rigour, practitioner reality, mechanism-level reasoning,",
    "and forward-impact framing — over four rounds. The judge synthesises a",
    "citation-first report with explicit confidence levels per claim.",
    "",
    "Best for: literature reviews, technology landscape scans, evaluating a body of",
    "experimental results, or 'what do we know about X' questions. Low-mid temperature",
    "to keep claims grounded.",
  ].join("\n"),
  panel: [
    {
      personaId: "scientific-skeptic",
      required: true,
      taskSystemSuffix: [
        "TASK: research synthesis.",
        "Demand evidence quality for every claim. Flag selection bias, p-hacking risk,",
        "sample-size issues, lack of independent replication, observational-vs-causal",
        "confusion, file-drawer effects. If the panel makes a claim without specifying",
        "the evidence type, push them.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: true,
      taskSystemSuffix: [
        "TASK: research synthesis.",
        "Anchor the synthesis in practitioner reality. Distinguish what holds up in",
        "deployed systems and field studies from what only works in clean experimental",
        "conditions. When a finding contradicts what practitioners actually report,",
        "name the gap and propose why it exists.",
      ].join("\n"),
    },
    {
      personaId: "first-principles",
      required: true,
      taskSystemSuffix: [
        "TASK: research synthesis.",
        "Decompose each finding into its underlying mechanism. Identify when several",
        "findings rest on the same shared assumption — those are correlated risks, not",
        "independent confirmations. Surface the load-bearing assumptions explicitly.",
      ].join("\n"),
    },
    {
      personaId: "optimistic-futurist",
      required: false,
      fallbackPersonaIds: ["vc-specialist"],
      taskSystemSuffix: [
        "TASK: research synthesis.",
        "Identify which findings, if true and scaled, would produce the largest forward",
        "impact — and which research directions logically follow. Distinguish",
        "high-leverage open questions from incremental ones.",
      ].join("\n"),
    },
  ],
  defaults: {
    maxRounds: 4,
    participantTemperature: 0.4,
    convergenceDelta: 3,
    blindFirstRound: true,
    randomizeOrder: true,
  },
  judgeSystemPrompt: [
    "You are synthesising a multi-reviewer research analysis.",
    "",
    "Produce a citation-first report with this structure:",
    "  ## Claims and confidence",
    "  Numbered list of major claims. For each:",
    "    • the claim, in one sentence",
    "    • supporting evidence (cite source from the prompt or panel response)",
    "    • confidence: HIGH / MEDIUM / LOW with one-line justification",
    "    • most-cited counter-evidence, if any",
    "  ## Open questions",
    "  Ranked by leverage — which open questions, if answered, would shift the most",
    "  conclusions? One line each.",
    "  ## Where to dig next",
    "  Specific next steps — papers to read, experiments to run, datasets to acquire.",
    "",
    "Do not invent citations. If a claim is not backed by something in the prompt or",
    "the panel responses, mark it 'panel inference' and lower the confidence.",
  ].join("\n"),
};
