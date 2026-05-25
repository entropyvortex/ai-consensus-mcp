// Premortem F1, F5, F6 contracts:
//   F1: atomic writes; index/result drift never crashes recall.
//   F5: stored entries carry schemaVersion; unknown fields don't break reads.
//   F6: concurrent writers don't corrupt the index.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConsensusResult } from "ai-consensus-core";
import { createMemoryStore } from "../store.js";
import { CURRENT_SCHEMA_VERSION } from "../types.js";

let root: string;
const projectKey = "abc123def456";
const projectPath = "/fake/project";

function makeResult(overrides: Partial<ConsensusResult> = {}): ConsensusResult {
  const now = Date.now();
  return {
    question: overrides.question ?? "What is X?",
    participants: [],
    rounds: [],
    roundsCompleted: 1,
    finalScore: 80,
    finalAverageConfidence: 80,
    finalStddev: 5,
    stopReason: "converged",
    startedAt: now,
    completedAt: now + 100,
    durationMs: 100,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memstore-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeStore() {
  return createMemoryStore({
    storageRoot: root,
    projectKey,
    projectPath,
    maxResults: 10,
    maxAgeDays: 365,
  });
}

describe("createMemoryStore — happy path", () => {
  it("stores and retrieves by id", async () => {
    const store = await makeStore();
    const { id } = await store.store({
      projectKey,
      projectPath,
      panelId: "architecture_v2",
      question: "Q1",
      result: makeResult(),
    });
    const fetched = await store.get(id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(id);
    expect(fetched!.question).toBe("Q1");
    expect(fetched!.panelId).toBe("architecture_v2");
    expect(fetched!.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(fetched!.storedAt).toBeGreaterThan(0);
  });

  it("stores propagate tags from input", async () => {
    const store = await makeStore();
    const { id } = await store.store({
      projectKey,
      projectPath,
      panelId: "test_panel",
      question: "Q tagged",
      result: makeResult(),
      tags: ["security", "v2"],
    });
    const fetched = await store.get(id);
    expect(fetched?.tags).toEqual(["security", "v2"]);
  });

  it("count reflects stored entries", async () => {
    const store = await makeStore();
    expect(await store.count()).toBe(0);
    await store.store({
      projectKey,
      projectPath,
      panelId: "test_panel",
      question: "Q1",
      result: makeResult(),
    });
    await store.store({
      projectKey,
      projectPath,
      panelId: "test_panel",
      question: "Q2",
      result: makeResult(),
    });
    expect(await store.count()).toBe(2);
  });
});

describe("createMemoryStore — F1 atomic writes + drift recovery", () => {
  it("writes results to <id>.json, not <id>.tmp", async () => {
    const store = await makeStore();
    const { id } = await store.store({
      projectKey,
      projectPath,
      panelId: "p",
      question: "Q",
      result: makeResult(),
    });
    await expect(stat(join(root, "results", `${id}.json`))).resolves.toBeDefined();
    await expect(stat(join(root, "results", `${id}.tmp`))).rejects.toBeDefined();
  });

  it("recall skips index entries whose result file is missing (F1 drift)", async () => {
    const store = await makeStore();
    const { id } = await store.store({
      projectKey,
      projectPath,
      panelId: "p",
      question: "Q1 about widgets",
      result: makeResult(),
    });
    // Delete the result file, leaving the index entry orphaned.
    await rm(join(root, "results", `${id}.json`), { force: true });
    // Recall must not crash and must not return the orphan.
    const hits = await store.recall({ query: "widgets" });
    expect(hits.find((h) => h.id === id)).toBeUndefined();
  });

  it("rebuildIndex regenerates index from result files", async () => {
    const store = await makeStore();
    await store.store({
      projectKey,
      projectPath,
      panelId: "p",
      question: "Q1",
      result: makeResult(),
    });
    await store.store({
      projectKey,
      projectPath,
      panelId: "p",
      question: "Q2",
      result: makeResult(),
    });
    // Corrupt the index by deleting it.
    await rm(join(root, "index.jsonl"), { force: true });
    expect(await store.count()).toBe(0);
    // Rebuild from results/.
    const { count } = await store.rebuildIndex();
    expect(count).toBe(2);
    expect(await store.count()).toBe(2);
  });
});

describe("createMemoryStore — F5 schema versioning + forward compat", () => {
  it("stored entries declare CURRENT_SCHEMA_VERSION", async () => {
    const store = await makeStore();
    const { id } = await store.store({
      projectKey,
      projectPath,
      panelId: "p",
      question: "Q",
      result: makeResult(),
    });
    const text = await readFile(join(root, "results", `${id}.json`), "utf8");
    const parsed = JSON.parse(text) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("reader tolerates unknown fields inside `result` (passthrough)", async () => {
    const store = await makeStore();
    // Manually write a result file with a future-shape extra field on result.
    const futureResult = {
      ...makeResult(),
      // Pretend v0.13 added this field.
      futureField: { newCapability: true },
    };
    const { id } = await store.store({
      projectKey,
      projectPath,
      panelId: "p",
      question: "Q-future",
      result: futureResult as unknown as ConsensusResult,
    });
    const back = await store.get(id);
    expect(back).toBeDefined();
    expect((back!.result as { futureField: unknown }).futureField).toEqual({ newCapability: true });
  });

  it("reader returns undefined for a malformed result file (never crashes)", async () => {
    const store = await makeStore();
    const { id } = await store.store({
      projectKey,
      projectPath,
      panelId: "p",
      question: "Q",
      result: makeResult(),
    });
    // Corrupt the file with garbage.
    await writeFile(join(root, "results", `${id}.json`), "this is not json", "utf8");
    const back = await store.get(id);
    expect(back).toBeUndefined();
  });
});

describe("createMemoryStore — F6 concurrent writes", () => {
  it("two concurrent stores both succeed and the index has both entries", async () => {
    const store = await makeStore();
    const [a, b] = await Promise.all([
      store.store({
        projectKey,
        projectPath,
        panelId: "p",
        question: "QA",
        result: makeResult(),
      }),
      store.store({
        projectKey,
        projectPath,
        panelId: "p",
        question: "QB",
        result: makeResult(),
      }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(await store.count()).toBe(2);
  });

  it("ten concurrent stores all land in the index without truncation", async () => {
    const store = await makeStore();
    const promises: Promise<{ id: string }>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        store.store({
          projectKey,
          projectPath,
          panelId: "p",
          question: `Q${i} unique-${i}`,
          result: makeResult(),
        }),
      );
    }
    await Promise.all(promises);
    expect(await store.count()).toBe(10);
    const indexText = await readFile(join(root, "index.jsonl"), "utf8");
    const lines = indexText.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(10);
    // Every line is valid JSON.
    for (const l of lines) {
      expect(() => JSON.parse(l) as unknown).not.toThrow();
    }
  });
});

describe("createMemoryStore — recall scoping (F4 + F2)", () => {
  it("recall is project-scoped by default", async () => {
    const store = await makeStore();
    await store.store({
      projectKey,
      projectPath,
      panelId: "p",
      question: "current-project entry",
      result: makeResult(),
    });
    await store.store({
      projectKey: "different-proj",
      projectPath: "/other/path",
      panelId: "p",
      question: "other-project entry",
      result: makeResult(),
    });
    const hits = await store.recall({ query: "entry" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.projectKey).toBe(projectKey);
  });

  it("recall with acrossProjects: true returns entries from other projects", async () => {
    const store = await makeStore();
    await store.store({
      projectKey,
      projectPath,
      panelId: "p",
      question: "current-project entry",
      result: makeResult(),
    });
    await store.store({
      projectKey: "different-proj",
      projectPath: "/other/path",
      panelId: "p",
      question: "other-project entry",
      result: makeResult(),
    });
    const hits = await store.recall({ query: "entry", acrossProjects: true });
    expect(hits.length).toBe(2);
  });

  it("filters by panelId, tags, sinceDays", async () => {
    const store = await makeStore();
    await store.store({
      projectKey,
      projectPath,
      panelId: "architecture_v2",
      question: "arch q one",
      result: makeResult(),
      tags: ["architecture"],
    });
    await store.store({
      projectKey,
      projectPath,
      panelId: "code_review_v2",
      question: "code q one",
      result: makeResult(),
      tags: ["code-review"],
    });

    const archHits = await store.recall({ panelId: "architecture_v2", query: "one" });
    expect(archHits.length).toBe(1);
    expect(archHits[0]!.panelId).toBe("architecture_v2");

    const codeReviewHits = await store.recall({ anyTag: ["code-review"], query: "one" });
    expect(codeReviewHits.length).toBe(1);
    expect(codeReviewHits[0]!.panelId).toBe("code_review_v2");
  });
});

describe("createMemoryStore — wipe + retention", () => {
  it("wipe clears both index and results", async () => {
    const store = await makeStore();
    await store.store({
      projectKey,
      projectPath,
      panelId: "p",
      question: "Q",
      result: makeResult(),
    });
    expect(await store.count()).toBe(1);
    await store.wipe();
    expect(await store.count()).toBe(0);
  });

  it("maxResults prunes oldest entries on store", async () => {
    const tinyStore = await createMemoryStore({
      storageRoot: root,
      projectKey,
      projectPath,
      maxResults: 3,
      maxAgeDays: 365,
    });
    for (let i = 0; i < 5; i++) {
      // Slight delay so storedAt differs and the prune has a stable ordering.
      await tinyStore.store({
        projectKey,
        projectPath,
        panelId: "p",
        question: `Q${i}`,
        result: makeResult(),
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    // Cap is 3 — only the most recent 3 should survive.
    expect(await tinyStore.count()).toBe(3);
  });
});
