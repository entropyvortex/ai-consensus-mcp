import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PERSONAS } from "../personas.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "../server.js";
import type { LoadedConfig } from "../config.js";

function makeConfig(overrides: Partial<LoadedConfig> = {}): LoadedConfig {
  const base: LoadedConfig = {
    sourcePath: "/fake/path",
    providers: {
      test: {
        id: "test",
        baseUrl: "https://api.test.local",
        apiKey: "k",
        extraHeaders: {},
      },
    },
    participants: [
      { id: "p1", modelId: "model-a", persona: PERSONAS[0]! },
      { id: "p2", modelId: "model-b", persona: PERSONAS[1]! },
    ],
    providerByParticipant: { p1: "test", p2: "test" },
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
  return { ...base, ...overrides };
}

async function connect(config: LoadedConfig): Promise<{
  server: Server;
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer(config);
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("createMcpServer — registration", () => {
  let env: Awaited<ReturnType<typeof connect>>;

  beforeEach(async () => {
    env = await connect(makeConfig());
  });

  afterEach(async () => {
    await env.close();
  });

  it("advertises the expected server name and version", () => {
    const info = env.client.getServerVersion();
    expect(info?.name).toBe(SERVER_NAME);
    expect(info?.version).toBe(SERVER_VERSION);
  });

  it("declares the tools capability", () => {
    const caps = env.client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
  });

  it("lists exactly one tool named 'consensus'", async () => {
    const result = await env.client.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("consensus");
  });

  it("the consensus tool input schema marks `prompt` as required", async () => {
    const result = await env.client.listTools();
    const schema = result.tools[0]!.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toContain("prompt");
    expect(schema.properties).toHaveProperty("prompt");
    expect(schema.properties).toHaveProperty("maxRounds");
    expect(schema.properties).toHaveProperty("judge");
  });

  it("the tool description surfaces configured participants and personas", async () => {
    const result = await env.client.listTools();
    const desc = result.tools[0]!.description ?? "";
    // Operators debugging their setup rely on this description telling them
    // which participants are actually wired up. Keep it useful.
    expect(desc).toContain("p1");
    expect(desc).toContain("p2");
    expect(desc).toContain("Risk Analyst");
    expect(desc).toContain("First-Principles Engineer");
    // When no judge is configured the description must say so explicitly —
    // operators debugging an "expected judge but didn't get one" issue look here.
    expect(desc).toMatch(/judge:\s*none configured/i);
  });
});

describe("createMcpServer — with judge configured", () => {
  it("tool description mentions the configured judge model", async () => {
    const env = await connect(
      makeConfig({
        judge: {
          providerId: "test",
          modelId: "judge-model-xyz",
          temperature: undefined,
          maxOutputTokens: undefined,
        },
        providerByParticipant: { p1: "test", p2: "test", judge: "test" },
      }),
    );
    const result = await env.client.listTools();
    const desc = result.tools[0]!.description ?? "";
    expect(desc).toContain("judge-model-xyz");
    await env.close();
  });
});

describe("createMcpServer — input validation via tool calls", () => {
  it("returns an isError result for unknown tool names", async () => {
    const env = await connect(makeConfig());
    const result = await env.client.callTool({
      name: "not-a-real-tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    await env.close();
  });

  it("returns an isError result for an empty prompt", async () => {
    const env = await connect(makeConfig());
    const result = await env.client.callTool({
      name: "consensus",
      arguments: { prompt: "" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text ?? "").toMatch(/invalid input/i);
    await env.close();
  });

  it("returns an isError result for an unknown participantId", async () => {
    const env = await connect(makeConfig());
    const result = await env.client.callTool({
      name: "consensus",
      arguments: {
        prompt: "test prompt",
        participantIds: ["p1", "ghost"],
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text ?? "").toMatch(/unknown participantid/i);
    await env.close();
  });

  it("returns an isError result when judge:true but no judge is configured", async () => {
    const env = await connect(makeConfig()); // judge=undefined
    const result = await env.client.callTool({
      name: "consensus",
      arguments: { prompt: "test prompt", judge: true },
    });
    expect(result.isError).toBe(true);
    await env.close();
  });
});
