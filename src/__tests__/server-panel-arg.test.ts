// Contract tests for the `panel` argument on the generic `consensus` MCP tool.
// Locks down: schema advertisement, mutual exclusion with `participantIds`,
// unknown-panel error, unrunnable-panel error.
//
// These tests stop short of running the engine end-to-end — the existing
// server tests intentionally don't either, because doing so requires a
// real HTTP provider. We assert every pre-engine validation path here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PERSONAS } from "../personas.js";
import { createMcpServer } from "../server.js";
import type { LoadedConfig } from "../config.js";

function makeNarrowConfig(): LoadedConfig {
  const pessimist = PERSONAS.find((p) => p.id === "pessimist")!;
  const vc = PERSONAS.find((p) => p.id === "vc-specialist")!;
  return {
    sourcePath: "/fake",
    providers: {
      test: { id: "test", baseUrl: "https://api.test.local", apiKey: "k", extraHeaders: {} },
    },
    participants: [
      { id: "p_pessimist", modelId: "model-a", persona: pessimist },
      { id: "p_vc", modelId: "model-b", persona: vc },
    ],
    providerByParticipant: { p_pessimist: "test", p_vc: "test" },

    memory: {
      enabled: false,
      storageRoot: "/tmp/test-memory",
      maxResults: 1000,
      maxAgeDays: 365,
      raw: undefined,
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

function makeFullConfig(): LoadedConfig {
  const participants = PERSONAS.map((p, i) => ({
    id: `p_${p.id}`,
    modelId: `model-${i}`,
    persona: p,
  }));
  return {
    sourcePath: "/fake",
    providers: {
      test: { id: "test", baseUrl: "https://api.test.local", apiKey: "k", extraHeaders: {} },
    },
    participants,
    providerByParticipant: Object.fromEntries(participants.map((p) => [p.id, "test"])),

    memory: {
      enabled: false,
      storageRoot: "/tmp/test-memory",
      maxResults: 1000,
      maxAgeDays: 365,
      raw: undefined,
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

describe("generic consensus tool — `panel` arg schema", () => {
  let env: Awaited<ReturnType<typeof connect>>;

  beforeEach(async () => {
    env = await connect(makeFullConfig());
  });

  afterEach(async () => {
    await env.close();
  });

  it("advertises `panel` in the input schema with the right description", async () => {
    const tools = await env.client.listTools();
    const consensus = tools.tools.find((t) => t.name === "consensus");
    expect(consensus).toBeDefined();
    const schema = consensus!.inputSchema as {
      properties?: Record<string, { type?: string; description?: string }>;
    };
    expect(schema.properties).toHaveProperty("panel");
    expect(schema.properties!.panel!.type).toBe("string");
    expect(schema.properties!.panel!.description).toMatch(/panel/i);
  });
});

describe("generic consensus tool — `panel` validation", () => {
  it("rejects panel + participantIds simultaneously as mutually exclusive", async () => {
    const env = await connect(makeFullConfig());
    const result = await env.client.callTool({
      name: "consensus",
      arguments: {
        prompt: "Q?",
        panel: "architecture_v2",
        participantIds: ["p_pessimist", "p_first-principles"],
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/mutually exclusive/i);
    await env.close();
  });

  it("rejects an unknown panel id with the list of available ids", async () => {
    const env = await connect(makeFullConfig());
    const result = await env.client.callTool({
      name: "consensus",
      arguments: { prompt: "Q?", panel: "totally_not_a_panel" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/unknown panel id/i);
    expect(text).toContain("architecture_v2");
    await env.close();
  });

  it("rejects an unrunnable panel with missing personas listed", async () => {
    // Narrow config only has pessimist + vc-specialist; architecture_v2
    // requires first-principles, domain-expert, pessimist (and optionally vc).
    const env = await connect(makeNarrowConfig());
    const result = await env.client.callTool({
      name: "consensus",
      arguments: { prompt: "Q?", panel: "architecture_v2" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/missing required personas/i);
    expect(text).toContain("first-principles");
    await env.close();
  });
});
