// ─────────────────────────────────────────────────────────────
// Preset: debug_postmortem
// ─────────────────────────────────────────────────────────────
// Incident postmortem. The panel runs 5-whys to a real mechanism-level
// root cause, anchors in known failure-mode taxonomies, demands evidence
// for every causal claim, and identifies the system-design changes that
// would have prevented the entire incident class. Judge produces a
// structured postmortem report with remediation items.

import type { Preset } from "../types.js";

export const DEBUG_POSTMORTEM_PRESET: Preset = {
  id: "debug_postmortem",
  toolName: "consensus_debug_postmortem",
  title: "Incident postmortem",
  description: [
    "Run a structured incident postmortem across the configured panel.",
    "",
    "Pass the incident description as `prompt` (timeline, symptoms, what was tried,",
    "what was found). The panel analyses from four angles — failure-mode mapping,",
    "operational-pattern recognition, mechanism-level root-cause via 5-whys, and",
    "evidence demands for every causal claim — over three rounds. The judge",
    "produces a postmortem report with remediation items.",
    "",
    "Best for: production incidents, regression debugging, support escalations, and",
    "near-miss reviews. Low temperature — postmortems reward precision, not creative",
    "speculation.",
  ].join("\n"),
  panel: [
    {
      personaId: "pessimist",
      required: true,
      taskSystemSuffix: [
        "TASK: incident postmortem.",
        "Identify what failed, what amplified the impact, why detection took as long",
        "as it did, and what could fail next under similar load. Be specific about",
        "timing, blast radius, and the chain of dependencies that propagated the",
        "fault.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: true,
      taskSystemSuffix: [
        "TASK: incident postmortem.",
        "Map this incident to known failure-mode taxonomies for the systems involved",
        "(retry storms, thundering herds, bimodal latency, replication lag, schema",
        "drift, etc.). Cite analogous incidents you've seen and how they were",
        "remediated. Name the failure category explicitly.",
      ].join("\n"),
    },
    {
      personaId: "first-principles",
      required: true,
      taskSystemSuffix: [
        "TASK: incident postmortem.",
        "Apply 5-whys until you reach a root cause that's a real mechanism, not a",
        "symptom or an organisational explanation. Reject 'we should have monitored",
        "X' as a root cause — that's a remediation, not a cause. Force the chain",
        "down to: what physically had to be true for this to happen?",
      ].join("\n"),
    },
    {
      personaId: "scientific-skeptic",
      required: false,
      fallbackPersonaIds: ["devils-advocate"],
      taskSystemSuffix: [
        "TASK: incident postmortem.",
        "Demand evidence for every causal claim. If the panel says 'X caused Y', ask:",
        "what would be true if X did NOT cause Y? Was that ruled out by evidence, or",
        "by assumption? Push back on hindsight bias and on plausible-sounding stories",
        "that lack a falsifiable mechanism.",
      ].join("\n"),
    },
  ],
  defaults: {
    maxRounds: 3,
    participantTemperature: 0.3,
    convergenceDelta: 4,
    disagreementThreshold: 20,
    blindFirstRound: true,
    randomizeOrder: true,
  },
  judgeSystemPrompt: [
    "You are synthesising an incident postmortem.",
    "",
    "Produce a postmortem report with this exact structure:",
    "  ## Summary",
    "  2-4 sentences: what broke, scope, duration, top remediation.",
    "  ## Timeline",
    "  Bulleted, with timestamps when present in the prompt or panel responses.",
    "  Include detection time, escalation time, mitigation time, full-recovery time.",
    "  ## Root cause",
    "  The 5-whys chain: cause → mechanism → mechanism → mechanism → first cause.",
    "  End with the actual root mechanism, not an organisational or process gap.",
    "  ## Contributing factors",
    "  Bulleted. Things that made this worse but weren't the root cause.",
    "  ## Detection gap analysis",
    "  Why didn't we see it sooner? What signal would have caught it earlier?",
    "  ## Remediation items",
    "  Numbered. For each: the action, severity (HIGH/MEDIUM/LOW), suggested owner",
    "  role (not name), and which gap it closes.",
    "  ## System-design changes that would have prevented this class of incident",
    "  The expensive, structural fixes — what's the architectural change that makes",
    "  this whole failure category impossible, not just unlikely?",
    "",
    "Do not assign blame to people. Failures are system-level. Use roles, not names.",
  ].join("\n"),
};
