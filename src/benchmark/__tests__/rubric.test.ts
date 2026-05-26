import { describe, it, expect } from "vitest";
import type { ModelCaller, ModelCallRequest } from "ai-consensus-core";
import type { RubricCriterion } from "../../presets/types.js";
import {
  buildRubricSystemPrompt,
  buildRubricUserPrompt,
  evaluateOutput,
  extractJsonObject,
} from "../rubric.js";

const RUBRIC: readonly RubricCriterion[] = [
  { id: "quantification", description: "Quantified constraints.", maxPoints: 5 },
  { id: "single-recommendation", description: "Pick one option.", maxPoints: 5 },
  { id: "reversibility", description: "Weigh reversibility.", maxPoints: 5 },
];

function mockCallerEmitting(content: string, opts: { throwError?: string } = {}): ModelCaller {
  return (_req: ModelCallRequest) => {
    if (opts.throwError) {
      return Promise.reject(new Error(opts.throwError));
    }
    return Promise.resolve({
      content,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
  };
}

describe("buildRubricSystemPrompt", () => {
  it("lists each criterion with id and max points", () => {
    const prompt = buildRubricSystemPrompt(RUBRIC);
    expect(prompt).toContain('"quantification" (0-5)');
    expect(prompt).toContain('"single-recommendation" (0-5)');
    expect(prompt).toContain('"reversibility" (0-5)');
  });

  it("instructs the model to return only JSON, no fences", () => {
    const prompt = buildRubricSystemPrompt(RUBRIC);
    expect(prompt).toMatch(/no prose before or after, no markdown fences/);
  });

  it("requires justifications to cite specifics, not generic praise", () => {
    const prompt = buildRubricSystemPrompt(RUBRIC);
    expect(prompt).toMatch(/not generic praise or criticism/);
  });
});

describe("buildRubricUserPrompt", () => {
  it("fences the answer so it cannot be confused with the evaluator's own output", () => {
    const out = buildRubricUserPrompt({
      question: "What architecture?",
      output: "use a monolith because…",
    });
    expect(out).toContain("<<<ANSWER>>>");
    expect(out).toContain("<<<END ANSWER>>>");
    expect(out).toContain("use a monolith because…");
  });
});

describe("extractJsonObject", () => {
  it("parses raw JSON", () => {
    const v = extractJsonObject('{"scores":[]}');
    expect(v).toEqual({ scores: [] });
  });

  it("parses JSON inside a ```json fenced block", () => {
    const v = extractJsonObject('Here you go:\n```json\n{"scores":[{"a":1}]}\n```\n');
    expect(v).toEqual({ scores: [{ a: 1 }] });
  });

  it("parses JSON inside a plain ``` fenced block", () => {
    const v = extractJsonObject('```\n{"k":42}\n```');
    expect(v).toEqual({ k: 42 });
  });

  it("recovers JSON from surrounding prose", () => {
    const v = extractJsonObject('Preamble. {"scores":[]} Trailing prose.');
    expect(v).toEqual({ scores: [] });
  });

  it("handles strings containing braces without breaking depth tracking", () => {
    const v = extractJsonObject('text {"s":"a }brace{ in string","n":1}');
    expect(v).toEqual({ s: "a }brace{ in string", n: 1 });
  });

  it("returns undefined for unparseable content", () => {
    expect(extractJsonObject("totally not json")).toBeUndefined();
  });

  it("returns undefined for non-object JSON (arrays, primitives)", () => {
    // The evaluator contract is a JSON object; an array alone isn't valid.
    expect(extractJsonObject("[1,2,3]")).toBeUndefined();
    expect(extractJsonObject("42")).toBeUndefined();
  });
});

describe("evaluateOutput — happy path", () => {
  it("returns scores, total, maxTotal, and normalized for a valid JSON response", async () => {
    const response = JSON.stringify({
      scores: [
        { criterion_id: "quantification", score: 4, justification: "names ms and $." },
        {
          criterion_id: "single-recommendation",
          score: 5,
          justification: "picks monolith outright.",
        },
        { criterion_id: "reversibility", score: 3, justification: "mentions but does not rate." },
      ],
    });
    const result = await evaluateOutput({
      caller: mockCallerEmitting(response),
      evaluatorModelId: "test-evaluator",
      rubric: RUBRIC,
      question: "Q",
      output: "A",
    });
    expect(result.errorMessage).toBeUndefined();
    expect(result.total).toBe(12);
    expect(result.maxTotal).toBe(15);
    expect(result.normalized).toBe(80); // 12/15 = 0.8
    expect(result.criteria).toHaveLength(3);
    expect(result.criteria[0]?.criterionId).toBe("quantification");
    expect(result.criteria[0]?.score).toBe(4);
  });

  it("preserves rubric order in the criteria output, regardless of response order", async () => {
    const response = JSON.stringify({
      scores: [
        { criterion_id: "reversibility", score: 1, justification: "…" },
        { criterion_id: "quantification", score: 2, justification: "…" },
        { criterion_id: "single-recommendation", score: 3, justification: "…" },
      ],
    });
    const result = await evaluateOutput({
      caller: mockCallerEmitting(response),
      evaluatorModelId: "test-evaluator",
      rubric: RUBRIC,
      question: "Q",
      output: "A",
    });
    expect(result.criteria.map((c) => c.criterionId)).toEqual([
      "quantification",
      "single-recommendation",
      "reversibility",
    ]);
    expect(result.criteria.map((c) => c.score)).toEqual([2, 3, 1]);
  });
});

describe("evaluateOutput — score handling", () => {
  it("clamps scores above maxPoints", async () => {
    const response = JSON.stringify({
      scores: [
        { criterion_id: "quantification", score: 99, justification: "j" },
        { criterion_id: "single-recommendation", score: 5, justification: "j" },
        { criterion_id: "reversibility", score: 5, justification: "j" },
      ],
    });
    const result = await evaluateOutput({
      caller: mockCallerEmitting(response),
      evaluatorModelId: "x",
      rubric: RUBRIC,
      question: "Q",
      output: "A",
    });
    expect(result.criteria[0]?.score).toBe(5);
    expect(result.total).toBe(15);
  });

  it("clamps negative scores to 0", async () => {
    const response = JSON.stringify({
      scores: [
        { criterion_id: "quantification", score: -3, justification: "j" },
        { criterion_id: "single-recommendation", score: 0, justification: "j" },
        { criterion_id: "reversibility", score: 0, justification: "j" },
      ],
    });
    const result = await evaluateOutput({
      caller: mockCallerEmitting(response),
      evaluatorModelId: "x",
      rubric: RUBRIC,
      question: "Q",
      output: "A",
    });
    expect(result.criteria[0]?.score).toBe(0);
    expect(result.total).toBe(0);
    expect(result.normalized).toBe(0);
  });

  it("treats a missing criterion as 0 with a sentinel justification", async () => {
    const response = JSON.stringify({
      scores: [
        { criterion_id: "quantification", score: 5, justification: "j" },
        { criterion_id: "single-recommendation", score: 5, justification: "j" },
        // reversibility omitted
      ],
    });
    const result = await evaluateOutput({
      caller: mockCallerEmitting(response),
      evaluatorModelId: "x",
      rubric: RUBRIC,
      question: "Q",
      output: "A",
    });
    expect(result.criteria).toHaveLength(3);
    const reversibility = result.criteria.find((c) => c.criterionId === "reversibility");
    expect(reversibility?.score).toBe(0);
    expect(reversibility?.justification).toMatch(/omitted/);
    // Eval still succeeds (no errorMessage) — partial data is data.
    expect(result.errorMessage).toBeUndefined();
  });
});

describe("evaluateOutput — failure modes (sentinel, never throws)", () => {
  it("records errorMessage when the caller throws", async () => {
    const result = await evaluateOutput({
      caller: mockCallerEmitting("", { throwError: "provider down" }),
      evaluatorModelId: "x",
      rubric: RUBRIC,
      question: "Q",
      output: "A",
    });
    expect(result.errorMessage).toBe("provider down");
    expect(result.criteria).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("records errorMessage when the response contains no parseable JSON", async () => {
    const result = await evaluateOutput({
      caller: mockCallerEmitting("I cannot do that."),
      evaluatorModelId: "x",
      rubric: RUBRIC,
      question: "Q",
      output: "A",
    });
    expect(result.errorMessage).toMatch(/parseable JSON/);
    expect(result.criteria).toHaveLength(0);
  });

  it("records errorMessage when JSON has the wrong shape", async () => {
    const result = await evaluateOutput({
      caller: mockCallerEmitting('{"wrong":"shape"}'),
      evaluatorModelId: "x",
      rubric: RUBRIC,
      question: "Q",
      output: "A",
    });
    expect(result.errorMessage).toBeDefined();
    expect(result.criteria).toHaveLength(0);
  });
});

describe("evaluateOutput — caller is invoked with the right request shape", () => {
  it("routes to participantId=rubric-evaluator with the configured modelId", async () => {
    let captured: ModelCallRequest | undefined;
    const caller: ModelCaller = (req) => {
      captured = req;
      return Promise.resolve({
        content: JSON.stringify({
          scores: RUBRIC.map((c) => ({ criterion_id: c.id, score: 1, justification: "j" })),
        }),
      });
    };
    await evaluateOutput({
      caller,
      evaluatorModelId: "my-eval-model",
      rubric: RUBRIC,
      question: "Q",
      output: "A",
    });
    expect(captured?.participantId).toBe("rubric-evaluator");
    expect(captured?.modelId).toBe("my-eval-model");
    expect(captured?.system).toContain('"quantification"');
    expect(captured?.user).toContain("<<<ANSWER>>>");
  });
});
