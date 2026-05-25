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
    hostSampleParticipants: {},
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
    expect(names).not.toContain("consensus_project_summary");
    expect(names).not.toContain("consensus_what_we_decided");
    await env.close();
  });

  it("memory tools ARE advertised when memory.enabled is true", async () => {
    const env = await connect(makeConfig(workdir, true));
    const tools = await env.client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("consensus_recall");
    expect(names).toContain("consensus_project_summary");
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

  it("consensus_project_summary returns a non-error response with empty-project message", async () => {
    const env = await connect(makeConfig(workdir, true));
    const result = await env.client.callTool({
      name: "consensus_project_summary",
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
