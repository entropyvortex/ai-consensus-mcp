// Contract tests for the JSON case-file loader. Covers happy-path parsing,
// schema-violation messaging (must reference the source path), JSON-parse
// failure, and duplicate id rejection. R6: each test names the contract.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCaseFile, parseCaseFile } from "../load.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bench-load-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content, "utf8");
  return p;
}

describe("loadCaseFile — happy path", () => {
  it("loads a minimal valid case file", async () => {
    const p = await write(
      "cases.json",
      JSON.stringify({
        version: "1.0.0",
        cases: [{ id: "c1", question: "What is X?" }],
      }),
    );
    const { sourcePath, file } = await loadCaseFile(p);
    expect(sourcePath).toBe(p);
    expect(file.cases).toHaveLength(1);
    expect(file.cases[0]!.id).toBe("c1");
  });

  it("preserves optional fields (tags, expectedTopics, panelId, notes)", async () => {
    const p = await write(
      "cases.json",
      JSON.stringify({
        version: "1.0.0",
        name: "Suite name",
        cases: [
          {
            id: "c1",
            question: "Q?",
            panelId: "architecture_v2",
            tags: ["arch"],
            expectedTopics: ["latency"],
            notes: "n",
          },
        ],
      }),
    );
    const { file } = await loadCaseFile(p);
    expect(file.name).toBe("Suite name");
    expect(file.cases[0]!.panelId).toBe("architecture_v2");
    expect(file.cases[0]!.tags).toEqual(["arch"]);
    expect(file.cases[0]!.expectedTopics).toEqual(["latency"]);
    expect(file.cases[0]!.notes).toBe("n");
  });
});

describe("loadCaseFile — failures reference the source path", () => {
  it("rejects malformed JSON with a path-tagged error", async () => {
    const p = await write("bad.json", "{ not valid");
    await expect(loadCaseFile(p)).rejects.toThrow(p);
    await expect(loadCaseFile(p)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects schema violations with a path-tagged error", async () => {
    const p = await write("missing.json", JSON.stringify({ version: "1.0.0", cases: [] }));
    await expect(loadCaseFile(p)).rejects.toThrow(p);
    await expect(loadCaseFile(p)).rejects.toThrow(/failed validation/);
  });

  it("rejects unknown version", async () => {
    const p = await write(
      "wrong-ver.json",
      JSON.stringify({
        version: "2.0.0",
        cases: [{ id: "c1", question: "Q" }],
      }),
    );
    await expect(loadCaseFile(p)).rejects.toThrow(/version/);
  });

  it("rejects empty case id", async () => {
    const p = await write(
      "empty-id.json",
      JSON.stringify({
        version: "1.0.0",
        cases: [{ id: "", question: "Q" }],
      }),
    );
    await expect(loadCaseFile(p)).rejects.toThrow(/failed validation/);
  });

  it("rejects bad case id pattern (uppercase)", async () => {
    const p = await write(
      "bad-id.json",
      JSON.stringify({
        version: "1.0.0",
        cases: [{ id: "Case1", question: "Q" }],
      }),
    );
    await expect(loadCaseFile(p)).rejects.toThrow(/kebab\/snake_case/);
  });

  it("rejects duplicate case ids", async () => {
    const p = await write(
      "dup.json",
      JSON.stringify({
        version: "1.0.0",
        cases: [
          { id: "c1", question: "Q1" },
          { id: "c1", question: "Q2" },
        ],
      }),
    );
    await expect(loadCaseFile(p)).rejects.toThrow(/duplicate case id "c1"/);
  });

  it("rejects extra unknown fields at top level (strict mode)", async () => {
    const p = await write(
      "extra.json",
      JSON.stringify({
        version: "1.0.0",
        extraField: "nope",
        cases: [{ id: "c1", question: "Q" }],
      }),
    );
    await expect(loadCaseFile(p)).rejects.toThrow(/failed validation/);
  });

  it("rejects extra unknown fields on a case (strict mode)", async () => {
    const p = await write(
      "extra-case.json",
      JSON.stringify({
        version: "1.0.0",
        cases: [{ id: "c1", question: "Q", surprise: 42 }],
      }),
    );
    await expect(loadCaseFile(p)).rejects.toThrow(/failed validation/);
  });
});

describe("parseCaseFile — inline parsing", () => {
  it("parses valid JSON string", () => {
    const file = parseCaseFile(
      JSON.stringify({
        version: "1.0.0",
        cases: [{ id: "c1", question: "Q" }],
      }),
    );
    expect(file.cases).toHaveLength(1);
  });

  it("throws on malformed JSON with the source label in the message", () => {
    expect(() => parseCaseFile("{ bad", "test-source")).toThrow(/test-source/);
  });
});
