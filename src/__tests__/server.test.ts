import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PERSONAS } from "../personas.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "../server.js";
import type { LoadedConfig } from "../config.js";
import { BUILT_IN_PRESETS } from "../presets/definitions/index.js";

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
    hostSampleParticipants: {},
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

/** Config that's deliberately too narrow for `code_review` to run — only
 *  pessimist + vc-specialist, neither domain-expert nor first-principles. */
function makeUnrunnableForCodeReviewConfig(): LoadedConfig {
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
    hostSampleParticipants: {},
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

/** Config with all 7 personas wired so every preset is runnable. */
function makeFullPanelConfig(): LoadedConfig {
  const participants = PERSONAS.map((p, i) => ({
    id: `p_${p.id}`,
    modelId: `model-${i}`,
    persona: p,
  }));
  const providerByParticipant = Object.fromEntries(participants.map((p) => [p.id, "test"]));
  return {
    sourcePath: "/fake",
    providers: {
      test: { id: "test", baseUrl: "https://api.test.local", apiKey: "k", extraHeaders: {} },
    },
    participants,
    providerByParticipant,
    hostSampleParticipants: {},
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
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
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

  it("lists the generic `consensus` tool plus one tool per built-in preset", async () => {
    const result = await env.client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("consensus");
    for (const preset of BUILT_IN_PRESETS) {
      expect(names).toContain(preset.toolName);
    }
    expect(result.tools).toHaveLength(1 + BUILT_IN_PRESETS.length);
  });

  it("the consensus tool input schema marks `prompt` as required", async () => {
    const result = await env.client.listTools();
    const tool = result.tools.find((t) => t.name === "consensus");
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toContain("prompt");
    expect(schema.properties).toHaveProperty("prompt");
    expect(schema.properties).toHaveProperty("maxRounds");
    expect(schema.properties).toHaveProperty("judge");
  });

  it("each preset tool advertises a valid input schema with `prompt` required", async () => {
    const result = await env.client.listTools();
    for (const preset of BUILT_IN_PRESETS) {
      const tool = result.tools.find((t) => t.name === preset.toolName);
      expect(tool, `preset ${preset.id} not registered`).toBeDefined();
      const schema = tool!.inputSchema as {
        type?: string;
        required?: string[];
        properties?: Record<string, unknown>;
      };
      expect(schema.type).toBe("object");
      expect(schema.required).toContain("prompt");
      expect(schema.properties).toHaveProperty("prompt");
      // Preset tools deliberately don't expose `participantIds` — the panel is
      // the preset's responsibility.
      expect(schema.properties).not.toHaveProperty("participantIds");
    }
  });

  it("the consensus tool description surfaces configured participants and personas", async () => {
    const result = await env.client.listTools();
    const tool = result.tools.find((t) => t.name === "consensus");
    const desc = tool?.description ?? "";
    expect(desc).toContain("p1");
    expect(desc).toContain("p2");
    expect(desc).toContain("Risk Analyst");
    expect(desc).toContain("First-Principles Engineer");
    expect(desc).toMatch(/judge:\s*none configured/i);
  });

  it("preset tool descriptions list the panel personas and required/optional status", async () => {
    const result = await env.client.listTools();
    for (const preset of BUILT_IN_PRESETS) {
      const tool = result.tools.find((t) => t.name === preset.toolName);
      const desc = tool?.description ?? "";
      for (const entry of preset.panel) {
        expect(desc, `preset ${preset.id} desc must mention persona ${entry.personaId}`).toContain(
          entry.personaId,
        );
      }
      expect(desc).toMatch(/\[required\]|\[optional\]/);
    }
  });
});

describe("createMcpServer — runnability flagging", () => {
  it("preset tool description flags NOT RUNNABLE when required personas are missing", async () => {
    // Configure pessimist + vc-specialist only — code_review needs
    // pessimist + (domain-expert OR first-principles), so it cannot run.
    const env = await connect(makeUnrunnableForCodeReviewConfig());
    const result = await env.client.listTools();
    const codeReview = result.tools.find((t) => t.name === "consensus_code_review");
    expect(codeReview?.description).toMatch(/NOT RUNNABLE/);
    expect(codeReview?.description).toContain("domain-expert");
    await env.close();
  });
});

describe("createMcpServer — preset registration with full panel", () => {
  it("preset descriptions don't show NOT RUNNABLE when all personas are configured", async () => {
    const env = await connect(makeFullPanelConfig());
    const result = await env.client.listTools();
    for (const preset of BUILT_IN_PRESETS) {
      const tool = result.tools.find((t) => t.name === preset.toolName);
      expect(tool?.description ?? "", `preset ${preset.id}`).not.toMatch(/NOT RUNNABLE/);
    }
    await env.close();
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
    const content = result.content as { type: string; text?: string }[];
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
    const content = result.content as { type: string; text?: string }[];
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

  it("returns an isError result when invoking a preset whose required personas aren't configured", async () => {
    // pessimist + vc-specialist only — code_review needs domain-expert or first-principles.
    const env = await connect(makeUnrunnableForCodeReviewConfig());
    const result = await env.client.callTool({
      name: "consensus_code_review",
      arguments: { prompt: "review this diff" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text?: string }[];
    expect(content[0]?.text ?? "").toMatch(/missing required personas/i);
    expect(content[0]?.text ?? "").toContain("domain-expert");
    await env.close();
  });

  it("returns an isError result for an empty prompt on a preset tool", async () => {
    const env = await connect(makeFullPanelConfig());
    const result = await env.client.callTool({
      name: "consensus_code_review",
      arguments: { prompt: "" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text?: string }[];
    expect(content[0]?.text ?? "").toMatch(/invalid input/i);
    await env.close();
  });

  it("rejects a run that includes a host-sample participant when the host did not advertise the sampling capability", async () => {
    // Default test client (above) connects without `capabilities.sampling`.
    // A run that pulls in a host-sample participant must fail fast with a
    // clear message instead of hanging forever waiting for a reply.
    const config = makeConfig({
      participants: [
        { id: "p1", modelId: "model-a", persona: PERSONAS[0]! },
        // host-sample participant — uses synthetic modelId, no provider mapping.
        { id: "p_self", modelId: "host-sample", persona: PERSONAS[1]! },
      ],
      providerByParticipant: { p1: "test" },
      hostSampleParticipants: { p_self: { modelHint: undefined } },
    });
    const env = await connect(config);
    const result = await env.client.callTool({
      name: "consensus",
      arguments: { prompt: "hello" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text?: string }[];
    const text = content[0]?.text ?? "";
    expect(text).toMatch(/sampling/i);
    expect(text).toContain("p_self");
    await env.close();
  });
});
