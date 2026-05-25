// ─────────────────────────────────────────────────────────────
// Expert panel: security_redteam
// ─────────────────────────────────────────────────────────────
// Adversarial threat-modelling roundtable. Four perspectives — attack
// surface enumeration, mechanism-level trust boundary decomposition,
// strongest attack path, and known-CVE pattern matching — converge on
// a threat model, attack tree, and prioritised mitigations.
//
// Tuned for precision: low temperature, tight disagreement threshold,
// blind first round. Defensive context only — use for code review of
// security-sensitive changes, threat-modelling new systems, or
// reviewing existing systems for hardening priorities.

import type { Preset } from "../types.js";

export const SECURITY_REDTEAM_PRESET: Preset = {
  id: "security_redteam",
  toolName: "consensus_security_redteam",
  title: "Security red-team threat model",
  description: [
    "Run a multi-perspective adversarial threat-modelling exercise over a system,",
    "design, or change. Defensive use only — the goal is to harden the system",
    "by surfacing the attack paths a real adversary would try first.",
    "",
    "Pass the system description, design doc, or diff as `prompt` (include any",
    "known trust boundaries, auth model, and data sensitivity). The panel works",
    "from four angles — attack surface enumeration, trust-boundary mechanism,",
    "strongest attack path, and known-pattern (STRIDE / CWE / CVE) matching —",
    "over four rounds. The judge produces a threat model, attack tree ranked by",
    "severity × likelihood, confirmed vulnerabilities, and prioritised mitigations.",
    "",
    "Best for: pre-launch security review, audit prep, prioritising hardening",
    "work, reviewing security-sensitive code changes, evaluating new auth models.",
  ].join("\n"),
  panel: [
    {
      personaId: "pessimist",
      required: true,
      taskSystemSuffix: [
        "TASK: security red-team threat model.",
        "Enumerate the attack surface exhaustively: external inputs, deserialization",
        "boundaries, authentication endpoints, authorization checks, secrets handling,",
        "data exfiltration paths, lateral-movement paths if a single component is",
        "compromised. For each surface, name the specific class of attack it enables",
        "(injection, SSRF, auth bypass, data exfil, etc.) and the precondition under",
        "which it fires. Be exhaustive, not selective.",
      ].join("\n"),
    },
    {
      personaId: "devils-advocate",
      required: true,
      fallbackPersonaIds: ["scientific-skeptic"],
      taskSystemSuffix: [
        "TASK: security red-team threat model.",
        "Construct the single most damaging attack path against this system,",
        "end-to-end. Chain primitives — recon → initial access → privilege",
        "escalation → lateral movement → objective. Be concrete: name the request",
        "you would send, the response you would parse, the next step it enables.",
        "Distinguish theoretical attacks from ones a competent attacker would",
        "actually attempt given the cost/payoff.",
      ].join("\n"),
    },
    {
      personaId: "first-principles",
      required: true,
      taskSystemSuffix: [
        "TASK: security red-team threat model.",
        "Decompose the system into trust boundaries. For each boundary: what crosses",
        "it (data, capability, identity), what is supposed to be enforced as it",
        "crosses, and what mechanism enforces it. Then identify which boundaries",
        "rely on the same load-bearing assumption (e.g. 'JWT signature verified",
        "everywhere') — a single bug there compromises every boundary that depends",
        "on it. Surface that shared assumption explicitly.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: false,
      fallbackPersonaIds: ["scientific-skeptic"],
      taskSystemSuffix: [
        "TASK: security red-team threat model.",
        "Match observed patterns against known taxonomies — OWASP Top 10, CWE",
        "categories, recent in-the-wild CVE patterns for the same tech stack.",
        "Cite specific CWE numbers or analogous incidents when you can. Distinguish",
        "patterns that are well-mitigated by the framework defaults from ones the",
        "implementation has opted out of.",
      ].join("\n"),
    },
  ],
  defaults: {
    maxRounds: 4,
    participantTemperature: 0.3,
    convergenceDelta: 3,
    disagreementThreshold: 15,
    blindFirstRound: true,
    randomizeOrder: true,
  },
  judgeSystemPrompt: [
    "You are synthesising a multi-reviewer security red-team threat model.",
    "",
    "Produce a defensive threat-model report with this exact structure:",
    "  ## Threat model",
    "  - Assets: what the system protects (data, capabilities, identity).",
    "  - Trust boundaries: where checks must hold.",
    "  - Adversaries: realistic threat actors and their goals.",
    "  ## Attack tree",
    "  Top attack paths ranked by Severity (HIGH/MEDIUM/LOW) × Likelihood (H/M/L).",
    "  For each: entry vector → chain → impact, with the specific preconditions.",
    "  ## Confirmed vulnerabilities",
    "  Numbered findings tagged BLOCKER / HIGH / MEDIUM / LOW. For each:",
    "  - Mechanism (the underlying bug or design flaw).",
    "  - Reproduction outline (the steps an attacker takes).",
    "  - Impact (what they get).",
    "  - CWE / OWASP category if matched.",
    "  ## Prioritised mitigations",
    "  Numbered, highest leverage first. For each:",
    "  - Fix description (concrete — code change, config change, or design change).",
    "  - Vulnerabilities closed.",
    "  - Cost (low / med / high) in implementation effort.",
    "  - Detection counterpart: what alert would catch this if exploited.",
    "  ## Open attack surface",
    "  Areas the panel could not fully analyze (missing info, out-of-scope). Name",
    "  what would need to be in scope to close the gap.",
    "",
    "Defensive framing only. Do not produce working exploit code. Outline the",
    "attack at the level needed to verify the fix, no further.",
  ].join("\n"),
  meta: {
    version: "1.0.0",
    rationale: [
      "Defensive threat modelling needs both breadth (enumerate everything) and depth",
      "(steelman the strongest attack). The panel pairs an exhaustive Risk Analyst",
      "with a focused Devil's Advocate who picks one path and chains it end-to-end —",
      "preventing both blind-spots (breadth alone) and selection-bias (depth alone).",
      "First Principles surfaces shared-assumption boundaries because one bug there",
      "breaks everything downstream. Disagreement threshold is 15 (tighter than",
      "default) — security splits on small confidence deltas matter.",
    ].join(" "),
    expectedOutputShape: {
      sections: [
        { heading: "Threat model", description: "Assets protected, trust boundaries, realistic adversaries." },
        { heading: "Attack tree", description: "Top attack paths ranked by severity × likelihood with preconditions." },
        { heading: "Confirmed vulnerabilities", description: "Findings tagged with severity, mechanism, repro outline, impact, CWE/OWASP." },
        { heading: "Prioritised mitigations", description: "Concrete fixes ranked by leverage with cost and detection counterpart." },
        { heading: "Open attack surface", description: "Unanalyzed areas and what's needed to close them." },
      ],
      tags: ["BLOCKER", "HIGH", "MEDIUM", "LOW"],
    },
    tags: ["security", "threat-modelling", "defensive", "high-stakes"],
  },
};
