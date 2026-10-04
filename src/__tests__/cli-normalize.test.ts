// Output-parsing contracts for CLI oracles run with --output-format json.

import { describe, expect, it } from "vitest";
import { extractConfidence } from "ai-consensus-core";
import { normalizeCliStdout } from "../cli-backend/normalize.js";

function normalize(stdout: string) {
  const logs: string[] = [];
  const result = normalizeCliStdout({
    driver: "grok",
    participantId: "p1",
    round: 1,
    stdout,
    log: (line) => logs.push(line),
  });
  return { result, logs };
}

describe("cli stdout normalization", () => {
  it("takes the last JSON object when an earlier line is also JSON", () => {
    // Contract: a JSON-shaped log line before the result does not turn the
    // whole stdout into the answer; the final object is the result.
    const stdout =
      '{"type":"warning","msg":"update available"}\n' +
      '{"structured_output":{"answer":"real answer","confidence":90}}\n';
    const { result } = normalize(stdout);
    expect(result.content).toBe("real answer\nCONFIDENCE: 90");
    expect(result.source).toBe("structured");
  });

  it("parses a pretty-printed result after a plain log line", () => {
    const stdout =
      "grok: checking for updates\n" +
      JSON.stringify({ structured_output: { answer: "pretty", confidence: 64 } }, null, 2) +
      "\n";
    const { result } = normalize(stdout);
    expect(result.content).toBe("pretty\nCONFIDENCE: 64");
  });

  it("rejects stdout that holds no JSON instead of scoring the raw text", () => {
    // Contract: under --output-format json, unparseable stdout is a seat
    // error. It never becomes the answer at a defaulted confidence of 50.
    expect(() => normalize("Error: model overloaded, try again\nCONFIDENCE: 99")).toThrow(
      /cli driver grok returned output that is not JSON/,
    );
    expect(() => normalize('{"structured_output": {"answer": "cut off')).toThrow(/not JSON/);
  });

  it("rejects a JSON object that carries no answer field", () => {
    expect(() => normalize('{"type":"system","subtype":"init"}')).toThrow(
      /cli driver grok returned JSON without an answer/,
    );
  });

  it("keeps the prose path for a JSON result string", () => {
    const { result } = normalize(JSON.stringify({ result: "line\nCONFIDENCE: 70" }));
    expect(extractConfidence(result.content)).toBe(70);
    expect(result.source).toBe("prose");
  });
});
