// Premortem F9 contract: keyword recall is whole-token, case-insensitive,
// returns matched fragments so the caller can sanity-check relevance.

import { describe, expect, it } from "vitest";
import { scoreEntry, tokenize } from "../query.js";
import type { IndexLine } from "../types.js";

function makeLine(questionPreview: string, tags: string[] = []): IndexLine {
  return {
    id: "abc123def456",
    storedAt: Date.now(),
    projectKey: "key123456789",
    panelId: "test_panel",
    questionPreview,
    tags,
    finalScore: 75,
    judgeConfidence: 80,
  };
}

describe("tokenize", () => {
  it("lowercases and splits on whitespace, dropping short tokens", () => {
    const t = tokenize("Should We Adopt MICROSERVICES from day one?");
    expect(t).toContain("microservices");
    expect(t).toContain("adopt");
    expect(t).toContain("day");
    expect(t).toContain("one");
    expect(t).toContain("we"); // length 2 is kept (MIN_TOKEN_LEN = 2)
  });

  it("strips punctuation but keeps internal hyphens / underscores", () => {
    const t = tokenize("auth-flow, jwt_token, db-name; api.url");
    expect(t).toContain("auth-flow");
    expect(t).toContain("jwt_token");
    expect(t).toContain("db-name");
    // 'api.url' splits into 'api' + 'url' because we filter to letters/digits/_/-
    expect(t).toContain("apiurl"); // dot is stripped, not split
  });

  it("dedupes case-insensitively", () => {
    const t = tokenize("auth Auth AUTH");
    expect(t).toEqual(["auth"]);
  });

  it("drops 1-char tokens", () => {
    const t = tokenize("a b cd ef gh");
    expect(t).not.toContain("a");
    expect(t).toContain("cd");
  });
});

describe("scoreEntry — empty/edge cases", () => {
  it("returns score 0 for empty query", () => {
    expect(scoreEntry(makeLine("any text"), "")).toEqual({ score: 0, fragments: [] });
    expect(scoreEntry(makeLine("any text"), "   ")).toEqual({ score: 0, fragments: [] });
  });

  it("returns score 0 when no tokens match", () => {
    const { score, fragments } = scoreEntry(makeLine("about microservices"), "billing");
    expect(score).toBe(0);
    expect(fragments).toEqual([]);
  });
});

describe("scoreEntry — F9 whole-token matching", () => {
  it("matches whole token, case-insensitive", () => {
    const { score, fragments } = scoreEntry(
      makeLine("Should we adopt microservices?"),
      "microservices",
    );
    expect(score).toBe(1);
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments[0]).toMatch(/microservices/i);
  });

  it("does NOT match across word boundaries (no substring match)", () => {
    // 'auth' inside 'author' must not match — premortem F9 verbatim.
    const r = scoreEntry(makeLine("Tooling for paper authors"), "auth");
    expect(r.score).toBe(0);
    expect(r.fragments).toEqual([]);
  });

  it("matches multiple tokens proportionally", () => {
    const r = scoreEntry(makeLine("auth flow with jwt"), "auth jwt missing");
    // 2 out of 3 query tokens match → score = 2/3
    expect(r.score).toBeCloseTo(2 / 3, 5);
    expect(r.fragments.length).toBe(2);
  });

  it("credits tag matches at half-weight", () => {
    const r = scoreEntry(makeLine("unrelated text", ["security", "v2"]), "security");
    // 1 token, half-weight tag match → score = 0.5
    expect(r.score).toBe(0.5);
    expect(r.fragments[0]).toBe("[tag:security]");
  });

  it("clamps the score to 1.0", () => {
    // A query with all tokens matching + tag matches stacks to >1, then clamps.
    const r = scoreEntry(makeLine("auth jwt token", ["auth"]), "auth jwt token");
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThan(0.9);
  });

  it("emits up to 4 fragments and stops", () => {
    const r = scoreEntry(
      makeLine("alpha beta gamma delta epsilon"),
      "alpha beta gamma delta epsilon zeta",
    );
    expect(r.fragments.length).toBeLessThanOrEqual(4);
  });

  it("fragment shows surrounding context with ellipsis when truncated", () => {
    const long = "a".repeat(60) + " target " + "b".repeat(60);
    const r = scoreEntry(makeLine(long), "target");
    expect(r.fragments[0]).toContain("target");
    expect(r.fragments[0]).toMatch(/…/);
  });
});
