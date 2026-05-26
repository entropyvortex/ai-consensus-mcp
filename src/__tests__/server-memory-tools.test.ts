// Contract tests for memory tools advertised by the MCP server.
// Locks down: tools are gated on `config.memory.enabled` (premortem F10);
// recall returns a non-error empty response when nothing is stored;
// what_we_decided validates required input.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ConsensusResult } from "ai-consensus-core";
import { PERSONAS } from "../personas.js";
import { createMcpServer } from "../server.js";
import type { LoadedConfig } from "../config.js";

function makeConfig(memoryRoot: string, enabled: boolean): LoadedConfig {
  return {
    sourcePath: "/fake",
    providers: {
      test: { id: "test", baseUrl: "https://test.local", apiKey: "k", extraHeaders: {} },
    },
    participants: [
      { id: "p1", modelId: "m-a", persona: PERSONAS[0]! },
      { id: "p2", modelId: "m-b", persona: PERSONAS[1]! },
    ],
    providerByParticipant: { p1: "test", p2: "test" },

    memory: {
      enabled,
      storageRoot: memoryRoot,
      maxResults: 100,
      maxAgeDays: 365,
      raw: enabled
        ? { enabled: true, storagePath: memoryRoot, projectPath: "/fake/proj" }
        : undefined,
    },
    judge: undefined,
    defaults: {
      maxRounds: 4,
      earlyStop: true,
      convergenceDelta: 3,
      disagreementThreshold: 20,
      blindFirstRound: true,
      randomizeOrder: true,
      participantTemperature: 0.7,
      maxOutputTokens: 1500,
      useJudge: false,
    },
  };
}

async function connect(config: LoadedConfig): Promise<{
  server: Server;
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer(config);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "memtools-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("memory tools — premortem F10 (off-by-default gating)", () => {
  it("memory tools are NOT advertised when memory.enabled is false", async () => {
    const env = await connect(makeConfig(workdir, false));
    const tools = await env.client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).not.toContain("consensus_recall");
    expect(names).not.toContain("consensus_project_memory");
    expect(names).not.toContain("consensus_what_we_decided");
    await env.close();
  });

  it("memory tools ARE advertised when memory.enabled is true", async () => {
    const env = await connect(makeConfig(workdir, true));
    const tools = await env.client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("consensus_recall");
    expect(names).toContain("consensus_project_memory");
    expect(names).toContain("consensus_what_we_decided");
    await env.close();
  });

  it("calling a memory tool when memory is disabled returns 'unknown tool'", async () => {
    const env = await connect(makeConfig(workdir, false));
    const result = await env.client.callTool({
      name: "consensus_recall",
      arguments: { query: "anything" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/unknown tool/i);
    await env.close();
  });
});

describe("memory tools — recall against an empty store", () => {
  it("consensus_recall returns a non-error response with a 'no stored runs' message", async () => {
    const env = await connect(makeConfig(workdir, true));
    const result = await env.client.callTool({
      name: "consensus_recall",
      arguments: { query: "anything" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/no stored runs/i);
    await env.close();
  });

  it("consensus_project_memory returns a non-error response with empty-project message", async () => {
    const env = await connect(makeConfig(workdir, true));
    const result = await env.client.callTool({
      name: "consensus_project_memory",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/project memory is empty/i);
    await env.close();
  });

  it("consensus_what_we_decided returns 'no decisions found' when nothing stored", async () => {
    const env = await connect(makeConfig(workdir, true));
    const result = await env.client.callTool({
      name: "consensus_what_we_decided",
      arguments: { topic: "auth architecture" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/no decisions found/i);
    expect(text).toContain("auth architecture");
    await env.close();
  });

  it("consensus_what_we_decided rejects a missing `topic` field", async () => {
    const env = await connect(makeConfig(workdir, true));
    const result = await env.client.callTool({
      name: "consensus_what_we_decided",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    await env.close();
  });
});

describe("memory tools — F7 freshness disclaimer surfaces in tool description", () => {
  it("consensus_recall description warns about staleness", async () => {
    const env = await connect(makeConfig(workdir, true));
    const tools = await env.client.listTools();
    const recall = tools.tools.find((t) => t.name === "consensus_recall");
    expect(recall?.description).toMatch(/historical context|freshness|stale/i);
    await env.close();
  });
});

// End-to-end contract: pre-populated entries must surface through every
// memory tool, with project scoping enforced and matched fragments
// preserved. Locks the integration between server.ts → store.ts → query.ts
// so a regression in any layer breaks this single test.
describe("memory tools — end-to-end recall against a pre-populated store", () => {
  /**
   * Pre-populate a project-scoped store by computing the same project key
   * the server would derive (sha256-of-realpath, first 12 hex). We use the
   * SAME projectPath the server resolves so projectKey lines up.
   */
  async function seed(memoryRoot: string, projectPath: string) {
    const { createMemoryStore } = await import("../memory/store.js");
    const { projectKeyForPath } = await import("../memory/project-key.js");
    const projectKey = projectKeyForPath(projectPath);
    const store = await createMemoryStore({
      storageRoot: join(memoryRoot, projectKey),
      projectKey,
      projectPath,
      maxResults: 100,
      maxAgeDays: 365,
    });
    const synth = {
      modelId: "judge",
      content:
        "Recommendation: start as a modular monolith. Tripwires that flip the call: write QPS sustains >5k for 24h.",
      majorityPosition: "monolith",
      minorityPositions: "microservices",
      unresolvedDisputes: "",
      judgeConfidence: 85,
      startedAt: Date.now(),
      completedAt: Date.now() + 100,
      durationMs: 100,
    };
    const baseResult: ConsensusResult = {
      question: "Should we adopt microservices on day one?",
      participants: [],
      rounds: [],
      roundsCompleted: 3,
      finalScore: 78,
      finalAverageConfidence: 80,
      finalStddev: 6,
      stopReason: "converged",
      startedAt: Date.now(),
      completedAt: Date.now() + 1000,
      durationMs: 1000,
      synthesis: synth,
    };
    await store.store({
      projectKey,
      projectPath,
      panelId: "architecture_v2",
      question: "Should we adopt microservices on day one?",
      result: baseResult,
      tags: ["architecture", "v2.0.0"],
    });
    await store.store({
      projectKey,
      projectPath,
      panelId: "decision_making_v2",
      question: "Hire a staff engineer or two seniors?",
      result: { ...baseResult, question: "Hire a staff engineer or two seniors?" },
      tags: ["hiring", "decision-support"],
    });
    return { projectKey };
  }

  it("consensus_recall returns the seeded architecture run with matched fragments", async () => {
    const projectPath = "/tmp/fake-project-recall";
    const env = await connect(makeConfig(workdir, true));
    await seed(workdir, projectPath);
    // Reconfigure to use the same projectPath the seed used.
    await env.close();
    const cfg = makeConfig(workdir, true);
    cfg.memory.raw = { enabled: true, storagePath: workdir, projectPath };
    const env2 = await connect(cfg);
    const result = await env2.client.callTool({
      name: "consensus_recall",
      arguments: { query: "microservices" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/architecture_v2/);
    expect(text).toMatch(/microservices/i);
    expect(text).toMatch(/Matched:/);
    await env2.close();
  });

  it("consensus_project_memory lists every seeded run", async () => {
    const projectPath = "/tmp/fake-project-summary";
    await seed(workdir, projectPath);
    const cfg = makeConfig(workdir, true);
    cfg.memory.raw = { enabled: true, storagePath: workdir, projectPath };
    const env = await connect(cfg);
    const result = await env.client.callTool({
      name: "consensus_project_memory",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/architecture_v2/);
    expect(text).toMatch(/decision_making_v2/);
    expect(text).toMatch(/microservices/i);
    expect(text).toMatch(/staff engineer/i);
    await env.close();
  });

  it("consensus_what_we_decided finds the architecture decision but skips non-decision panels", async () => {
    const projectPath = "/tmp/fake-project-decided";
    const { createMemoryStore } = await import("../memory/store.js");
    const { projectKeyForPath } = await import("../memory/project-key.js");
    const projectKey = projectKeyForPath(projectPath);
    const store = await createMemoryStore({
      storageRoot: join(workdir, projectKey),
      projectKey,
      projectPath,
      maxResults: 100,
      maxAgeDays: 365,
    });
    const baseResult: ConsensusResult = {
      question: "Should we adopt microservices on day one?",
      participants: [],
      rounds: [],
      roundsCompleted: 3,
      finalScore: 78,
      finalAverageConfidence: 80,
      finalStddev: 6,
      stopReason: "converged",
      startedAt: Date.now(),
      completedAt: Date.now() + 1000,
      durationMs: 1000,
      synthesis: {
        modelId: "j",
        content: "Monolith first.",
        majorityPosition: "monolith",
        minorityPositions: "",
        unresolvedDisputes: "",
        judgeConfidence: 85,
        startedAt: Date.now(),
        completedAt: Date.now() + 10,
        durationMs: 10,
      },
    };
    // Decision-related panel (matches DECISION_PANEL_IDS).
    await store.store({
      projectKey,
      projectPath,
      panelId: "architecture_v2",
      question: "Should we adopt microservices on day one?",
      result: baseResult,
      tags: ["architecture"],
    });
    // Non-decision panel — same query terms, but what_we_decided should NOT include it.
    await store.store({
      projectKey,
      projectPath,
      panelId: "code_review_v2",
      question: "Review microservices boilerplate diff.",
      result: { ...baseResult, question: "Review microservices boilerplate diff." },
      tags: ["code-review"],
    });

    const cfg = makeConfig(workdir, true);
    cfg.memory.raw = { enabled: true, storagePath: workdir, projectPath };
    const env = await connect(cfg);
    const result = await env.client.callTool({
      name: "consensus_what_we_decided",
      arguments: { topic: "microservices" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/architecture_v2/);
    // Decision-archaeology must NOT bubble up code-review results — that's the
    // contract that makes the tool useful in the first place.
    expect(text).not.toMatch(/code_review_v2/);
    await env.close();
  });
});
