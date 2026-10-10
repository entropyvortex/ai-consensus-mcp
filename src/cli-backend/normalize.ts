// Output parsing and confidence normalization for CLI oracles.
// The engine scores the first `confidence:` hit. Structured confidence wins
// over answer text, so marker-like phrases in the body are neutralized and
// the only real marker is the trailer we append. participantId "judge"
// selects JUDGE_CONFIDENCE. Phase "synthesis" does not: participant rounds
// use that phase too.

import { extractConfidence, extractJudgeConfidence, type TokenUsage } from "ai-consensus-core";

const ORACLE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "confidence"],
  properties: {
    answer: { type: "string" },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
  },
} as const;

export const ORACLE_JSON_SCHEMA_TEXT = JSON.stringify(ORACLE_JSON_SCHEMA);

export const CAPTURE_CHAR_CAP = 2_000_000;

export type ConfidenceSource = "structured" | "prose" | "defaulted";

export interface NormalizedCli {
  content: string;
  source: ConfidenceSource;
  usage?: TokenUsage;
}

interface ExtractedAnswer {
  answer: string;
  structured: boolean;
  rawConfidence: unknown;
  isError: boolean;
  errorDetail: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The CLI result object from stdout, or undefined when there is none.
 * Tries the whole output first, then each line that opens with `{`, from
 * the last one up, parsed through to the end of the output. That accepts a
 * log line (plain or JSON) before the result and a pretty-printed result,
 * and always prefers the final object, which is the CLI's answer.
 */
export function parseCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const whole = tryParse(trimmed);
  if (whole !== undefined) return whole;
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i > 0; i -= 1) {
    if (!lines[i]?.trimStart().startsWith("{")) continue;
    const parsed = tryParse(lines.slice(i).join("\n"));
    if (asRecord(parsed)) return parsed;
  }
  return undefined;
}

function clipForError(stdout: string): string {
  const flat = stdout.trim().replace(/\s+/g, " ");
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

// Every driver runs with --output-format json, so stdout that is not a JSON
// object is a seat error. Returning the raw text would score a log line,
// a truncated object, or a CLI error banner as a real answer.
function extractAnswer(driver: string, stdout: string): ExtractedAnswer {
  const parsed = parseCliJson(stdout);
  const obj = asRecord(parsed);
  if (!obj) {
    if (stdout.trim() === "") {
      return {
        answer: "",
        structured: false,
        rawConfidence: undefined,
        isError: false,
        errorDetail: "",
      };
    }
    throw new Error(
      `cli driver ${driver} returned output that is not JSON: ${clipForError(stdout)}`,
    );
  }
  const subtype = typeof obj["subtype"] === "string" ? obj["subtype"] : "";
  const isError = obj["is_error"] === true || subtype.startsWith("error");
  const errorDetail = subtype || (typeof obj["error"] === "string" ? obj["error"] : "");

  const structuredRaw = obj["structured_output"] ?? obj["structuredOutput"];
  const structuredRec = asRecord(structuredRaw);
  if (structuredRec && typeof structuredRec["answer"] === "string") {
    return {
      answer: structuredRec["answer"],
      structured: true,
      rawConfidence: structuredRec["confidence"],
      isError,
      errorDetail,
    };
  }

  if (typeof obj["answer"] === "string") {
    return {
      answer: obj["answer"],
      structured: true,
      rawConfidence: obj["confidence"],
      isError,
      errorDetail,
    };
  }

  if (typeof obj["result"] === "string") {
    return {
      answer: obj["result"],
      structured: false,
      rawConfidence: undefined,
      isError,
      errorDetail,
    };
  }
  if (typeof obj["text"] === "string") {
    return {
      answer: obj["text"],
      structured: false,
      rawConfidence: undefined,
      isError,
      errorDetail,
    };
  }
  if (isError) {
    return { answer: "", structured: false, rawConfidence: undefined, isError, errorDetail };
  }
  throw new Error(`cli driver ${driver} returned JSON without an answer: ${clipForError(stdout)}`);
}

function firstNumber(rec: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readUsage(payload: unknown): TokenUsage | undefined {
  const obj = asRecord(payload);
  if (!obj) return undefined;
  const nests = [obj["usage"], obj];
  for (const nest of nests) {
    const rec = asRecord(nest);
    if (!rec) continue;
    const input = firstNumber(rec, ["input_tokens", "inputTokens", "prompt_tokens"]);
    const output = firstNumber(rec, ["output_tokens", "outputTokens", "completion_tokens"]);
    if (input === undefined || output === undefined) continue;
    const total = firstNumber(rec, ["total_tokens", "totalTokens"]) ?? input + output;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }
  return undefined;
}

function roleFor(participantId: string): "judge" | "participant" {
  return participantId === "judge" ? "judge" : "participant";
}

function structuredConfidence(raw: unknown): { n: number; reason?: "missing" | "invalid" } {
  if (raw === undefined || raw === null) return { n: 50, reason: "missing" };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 100) {
    return { n: 50, reason: "invalid" };
  }
  return { n: raw };
}

function proseConfidence(
  answer: string,
  role: "judge" | "participant",
): { n: number; source: "prose" | "defaulted"; reason?: "unstructured" } {
  if (role === "judge") {
    if (answer.toLowerCase().includes("judge_confidence:")) {
      return { n: extractJudgeConfidence(answer), source: "prose" };
    }
    return { n: 50, source: "defaulted", reason: "unstructured" };
  }
  if (answer.toLowerCase().includes("confidence:")) {
    return { n: extractConfidence(answer), source: "prose" };
  }
  return { n: 50, source: "defaulted", reason: "unstructured" };
}

function neutralize(answer: string): string {
  return answer.replace(/confidence\s*:/gi, "confidence —");
}

export function normalizeCliStdout(args: {
  driver: string;
  participantId: string;
  round: number;
  stdout: string;
  log: (line: string) => void;
}): NormalizedCli {
  const extracted = extractAnswer(args.driver, args.stdout);
  if (extracted.isError) {
    const detail = extracted.errorDetail ? `: ${extracted.errorDetail}` : "";
    throw new Error(`cli driver ${args.driver} returned an error result${detail}`);
  }
  if (extracted.answer.trim() === "") {
    throw new Error(`cli driver ${args.driver} returned an empty answer`);
  }

  const role = roleFor(args.participantId);
  let n = 50;
  let source: ConfidenceSource = "defaulted";
  let reason: "missing" | "invalid" | "unstructured" | undefined;
  if (extracted.structured) {
    const parsed = structuredConfidence(extracted.rawConfidence);
    n = parsed.n;
    if (parsed.reason) {
      source = "defaulted";
      reason = parsed.reason;
    } else {
      source = "structured";
    }
  } else {
    const parsed = proseConfidence(extracted.answer, role);
    n = parsed.n;
    source = parsed.source;
    reason = parsed.reason;
  }

  if (source === "defaulted" && reason) {
    args.log(
      `ai-consensus-mcp: cli confidence defaulted participant=${args.participantId} round=${args.round} driver=${args.driver} reason=${reason}\n`,
    );
  }

  const body = neutralize(extracted.answer);
  const trailer = role === "judge" ? `\nJUDGE_CONFIDENCE: ${n}` : `\nCONFIDENCE: ${n}`;
  const usage = readUsage(parseCliJson(args.stdout));
  return { content: `${body}${trailer}`, source, ...(usage ? { usage } : {}) };
}
