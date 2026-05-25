// ─────────────────────────────────────────────────────────────
// Expert panel: code_review_v2
// ─────────────────────────────────────────────────────────────
// Second-generation code review. Every finding must name a concrete
// location, mechanism, and fix; generic "could be cleaner" suggestions
// are rejected. Devil's Advocate is required to construct the strongest
// case that the code is correct as written — exposes weaknesses pattern-
// matching reviewers miss.

import type { Preset } from "../types.js";

export const CODE_REVIEW_V2_PRESET: Preset = {
  id: "code_review_v2",
  toolName: "consensus_code_review_v2",
  title: "Code review roundtable (v2)",
  description: [
    "Run a multi-perspective code review across the configured panel, v2.",
    "",
    "Pass the diff, file, or change description as `prompt`. The panel reviews from",
    "four angles in parallel — risk/defects, idiomatic patterns, steelmanned defense,",
    "and first-principles purpose — then debates until findings converge. The judge",
    "produces a severity-ranked review with BLOCKER/MAJOR/MINOR/NIT tags, line",
    "citations, root cause per finding, and a specific recommended fix.",
    "",
    "Improvements over v1: every finding must name (a) location, (b) mechanism,",
    "(c) trigger condition, (d) concrete fix. Generic 'consider X' suggestions are",
    "rejected by the judge. Lower temperature (0.25) for higher precision.",
    "",
    "Best for: PR reviews, design-doc reviews, refactor sanity-checks, security-",
    "adjacent diffs (combine with consensus_security_redteam for sensitive code).",
  ].join("\n"),
  panel: [
    {
      personaId: "pessimist",
      required: true,
      taskSystemSuffix: [
        "TASK: code review (v2).",
        "Surface defects, security risks, performance footguns, concurrency bugs,",
        "and tail-risk failure modes. Each finding must include: (a) file:line",
        "citation when the diff makes it visible, (b) the specific trigger condition",
        "(input shape, load, race ordering), (c) blast radius, (d) recommended fix.",
        "Reject generic risk lists — every entry is testable or it's noise.",
      ].join("\n"),
    },
    {
      personaId: "domain-expert",
      required: true,
      fallbackPersonaIds: ["first-principles"],
      taskSystemSuffix: [
        "TASK: code review (v2).",
        "Anchor in idiomatic patterns of the actual language/framework. Name each",
        "pattern or anti-pattern explicitly. For every anti-pattern you flag, propose",
        "the concrete refactor (function names, file locations, contract changes).",
        "Distinguish style preferences from correctness gaps and from performance",
        "regressions — tag each finding with which category it falls into.",
      ].join("\n"),
    },
    {
      personaId: "devils-advocate",
      required: true,
      fallbackPersonaIds: ["scientific-skeptic"],
      taskSystemSuffix: [
        "TASK: code review (v2).",
        "Construct the strongest case that the code is correct and appropriate as",
        "written. Steelman the author. Then identify the single most damaging",
        "counter-argument to your own defense. The point is to expose hidden",
        "weaknesses that pattern-matching review would miss — and to prevent the",
        "panel from converging on a 'gotcha' that doesn't survive scrutiny.",
      ].join("\n"),
    },
    {
      personaId: "first-principles",
      required: false,
      taskSystemSuffix: [
        "TASK: code review (v2).",
        "Decompose the change into its fundamental purpose. Question the assumptions",
        "baked into the design — error model, ownership, lifecycle, mutability,",
        "concurrency model. If a simpler implementation would meet the requirement",
        "with strictly less surface area, propose it as code (signatures, not prose).",
      ].join("\n"),
    },
  ],
  defaults: {
    maxRounds: 3,
    participantTemperature: 0.25,
    convergenceDelta: 4,
    disagreementThreshold: 18,
    blindFirstRound: true,
    randomizeOrder: true,
  },
  judgeSystemPrompt: [
    "You are synthesising a multi-reviewer code review (v2).",
    "",
    "Produce a final review with this exact structure:",
    "  ## Findings",
    "  Numbered list, each severity-tagged: BLOCKER / MAJOR / MINOR / NIT.",
    "  For each finding:",
    "    • Location (file:line when known)",
    "    • Root cause (the mechanism, not the symptom)",
    "    • Trigger condition (what input/load/state surfaces it)",
    "    • Recommended fix (concrete — names, signatures, file paths)",
    "  ## Agreed",
    "  Bulleted: issues every reviewer (independently or after debate) flagged.",
    "  ## Disagreements",
    "  Bulleted: issues where reviewers split, each side's reasoning in one line.",
    "  Do not pick a winner unless the technical case is unambiguous.",
    "  ## Refactor opportunities",
    "  Optional. Out-of-scope for this diff but worth tracking — name the work.",
    "",
    "Reject generic suggestions. 'Consider extracting helper' is useless;",
    "'extract foo() into shared/utils.ts to deduplicate the parsing in three",
    "call-sites at config.ts:42, loader.ts:88, validator.ts:120' is useful.",
  ].join("\n"),
  meta: {
    version: "2.0.0",
    rationale: [
      "v2 enforces the four-part finding shape — location, root cause, trigger, fix —",
      "that v1 left implicit. Devil's Advocate is now required, not optional: the",
      "single most common code-review failure mode is converging on a defect that",
      "doesn't survive the author's steelmanned defense. Temperature drops to 0.25",
      "for precision over wide-net brainstorming.",
    ].join(" "),
    expectedOutputShape: {
      sections: [
        { heading: "Findings", description: "Severity-tagged findings with location, root cause, trigger, and concrete fix." },
        { heading: "Agreed", description: "Issues every reviewer flagged independently or after debate." },
        { heading: "Disagreements", description: "Issues where reviewers split, with each side's reasoning." },
        { heading: "Refactor opportunities", description: "Out-of-scope work worth tracking." },
      ],
      tags: ["BLOCKER", "MAJOR", "MINOR", "NIT"],
    },
    tags: ["code-review", "v2", "engineering", "high-precision"],
  },
};
