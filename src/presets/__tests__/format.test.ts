import { describe, expect, it } from "vitest";
import type { ConsensusResult } from "ai-consensus-core";
import { PERSONAS } from "../../personas.js";
import { CODE_REVIEW_PRESET } from "../definitions/code-review.js";
import { formatPresetResult } from "../format.js";

function makeResult(overrides: Partial<ConsensusResult> = {}): ConsensusResult {
  const base: ConsensusResult = {
    question: "Should we adopt microservices?",
    participants: [
      {
        id: "p_pessimist",
        modelId: "model-a",
        persona: PERSONAS.find((p) => p.id === "pessimist")!,
      },
      {
        id: "p_domain",
        modelId: "model-b",
        persona: PERSONAS.find((p) => p.id === "domain-expert")!,
      },
    ],
    rounds: [
      {
        round: 1,
        phase: "initial-analysis",
        label: "Initial analysis",
        blind: true,
        responses: [
          {
            participantId: "p_pessimist",
            modelId: "model-a",
            personaId: "pessimist",
            round: 1,
            phase: "initial-analysis",
            content: "Risk analysis content here.\n\nCONFIDENCE: 70",
            confidence: 70,
            startedAt: 0,
            completedAt: 1000,
            durationMs: 1000,
          },
          {
            participantId: "p_domain",
            modelId: "model-b",
            personaId: "domain-expert",
            round: 1,
            phase: "initial-analysis",
            content: "Domain expert analysis here.\n\nCONFIDENCE: 80",
            confidence: 80,
            startedAt: 0,
            completedAt: 1500,
            durationMs: 1500,
          },
        ],
        averageConfidence: 75,
        stddev: 5,
        score: 73,
        disagreements: [],
        startedAt: 0,
        completedAt: 1500,
        durationMs: 1500,
      },
    ],
    roundsCompleted: 1,
    finalScore: 73,
    finalAverageConfidence: 75,
    finalStddev: 5,
    stopReason: "converged",
    startedAt: 0,
    completedAt: 1500,
    durationMs: 1500,
  };
  return { ...base, ...overrides };
}

describe("formatPresetResult — default formatter", () => {
  it("leads with the preset title and the question", () => {
    const out = formatPresetResult(CODE_REVIEW_PRESET, makeResult(), {
      prompt: "review this",
      extras: {},
    });
    const titleIdx = out.indexOf(`# ${CODE_REVIEW_PRESET.title}`);
    const questionIdx = out.indexOf("**Question:**");
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(questionIdx).toBeGreaterThan(titleIdx);
  });

  it("includes the score-progression table", () => {
    const out = formatPresetResult(CODE_REVIEW_PRESET, makeResult(), {
      prompt: "review",
      extras: {},
    });
    expect(out).toContain("## Score progression");
    expect(out).toContain("| Round | Phase | Label | Score | Avg | σ | Disagreements |");
  });

  it("renders the synthesis section before the panel responses when judge ran", () => {
    const synthesised = makeResult({
      synthesis: {
        modelId: "judge-x",
        content: "## Findings\n1. Issue A\n2. Issue B",
        majorityPosition: "majority",
        minorityPositions: "minority",
        unresolvedDisputes: "open",
        judgeConfidence: 85,
        startedAt: 0,
        completedAt: 500,
        durationMs: 500,
      },
    });
    const out = formatPresetResult(CODE_REVIEW_PRESET, synthesised, {
      prompt: "review",
      extras: {},
    });
    const synthesisIdx = out.indexOf(`## ${CODE_REVIEW_PRESET.title} — synthesis`);
    const panelIdx = out.indexOf("## Panel responses");
    expect(synthesisIdx).toBeGreaterThanOrEqual(0);
    expect(panelIdx).toBeGreaterThan(synthesisIdx);
    expect(out).toContain("## Findings");
    expect(out).toContain("Issue A");
    expect(out).toContain("judge-x");
    expect(out).toContain("85");
  });

  it("emits a no-judge note when no synthesis is present", () => {
    const out = formatPresetResult(CODE_REVIEW_PRESET, makeResult(), {
      prompt: "review",
      extras: {},
    });
    expect(out).toMatch(/no judge synthesis/i);
  });

  it("renders panel responses with persona name and confidence", () => {
    const out = formatPresetResult(CODE_REVIEW_PRESET, makeResult(), {
      prompt: "review",
      extras: {},
    });
    expect(out).toContain("Risk Analyst");
    expect(out).toContain("Domain Expert");
    expect(out).toContain("confidence 70");
    expect(out).toContain("confidence 80");
  });

  it("flags errored panel responses prominently", () => {
    const erroredResult = makeResult({
      rounds: [
        {
          round: 1,
          phase: "initial-analysis",
          label: "Initial analysis",
          blind: true,
          responses: [
            {
              participantId: "p_pessimist",
              modelId: "model-a",
              personaId: "pessimist",
              round: 1,
              phase: "initial-analysis",
              content: "",
              confidence: 0,
              error: "provider timeout",
              startedAt: 0,
              completedAt: 100,
              durationMs: 100,
            },
            {
              participantId: "p_domain",
              modelId: "model-b",
              personaId: "domain-expert",
              round: 1,
              phase: "initial-analysis",
              content: "ok\n\nCONFIDENCE: 60",
              confidence: 60,
              startedAt: 0,
              completedAt: 1000,
              durationMs: 1000,
            },
          ],
          averageConfidence: 60,
          stddev: 0,
          score: 60,
          disagreements: [],
          startedAt: 0,
          completedAt: 1000,
          durationMs: 1000,
        },
      ],
    });
    const out = formatPresetResult(CODE_REVIEW_PRESET, erroredResult, {
      prompt: "review",
      extras: {},
    });
    expect(out).toContain("ERROR: provider timeout");
  });

  it("delegates to a preset's custom formatResult when defined", () => {
    const customPreset = {
      ...CODE_REVIEW_PRESET,
      formatResult: () => "CUSTOM_OUTPUT",
    };
    const out = formatPresetResult(customPreset, makeResult(), { prompt: "x", extras: {} });
    expect(out).toBe("CUSTOM_OUTPUT");
  });
});
