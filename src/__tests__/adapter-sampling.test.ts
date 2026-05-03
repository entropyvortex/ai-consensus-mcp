// Focused unit tests for the sampling-backed ModelCaller. Wires a real
// MCP Server <-> Client pair through the in-memory transport, has the
// client respond to `sampling/createMessage`, and asserts that
// createSamplingCaller turns those replies into proper ModelCallResponses.
//
// Full-stack coverage of the sampling routing through tool calls is
// expensive (the engine loops, blind rounds, judge etc.), so we test the
// adapter unit directly. server.test.ts covers the capability-gate and
// dispatch wiring.

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ModelCallRequest } from "ai-consensus-core";
import { createSamplingCaller } from "../adapter.js";

function buildModelCallRequest(over: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    participantId: "p_self",
    modelId: "host-sample",
    round: 1,
    phase: "initial-analysis",
    system: "you are a Risk Analyst.",
    user: "Should we ship microservices on day one?",
    temperature: 0.7,
    maxOutputTokens: 1500,
    ...over,
  };
}

async function withConnectedPair<T>(
  clientCaps: { sampling?: Record<string, never> } | undefined,
  registerHandler: (client: Client) => void,
  fn: (server: Server) => Promise<T>,
): Promise<T> {
  const server = new Server(
    { name: "test-sampling-server", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  const client = new Client(
    { name: "test-sampling-client", version: "0.0.0" },
    { capabilities: clientCaps ?? {} },
  );
  registerHandler(client);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    return await fn(server);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("createSamplingCaller", () => {
  it("returns content from a host that handles sampling/createMessage", async () => {
    let receivedSystem: string | undefined;
    let receivedUserText: string | undefined;
    const result = await withConnectedPair(
      { sampling: {} },
      (client) => {
        client.setRequestHandler(CreateMessageRequestSchema, (req) => {
          receivedSystem = req.params.systemPrompt;
          const first = req.params.messages[0];
          if (first?.content && "text" in first.content) {
            receivedUserText = first.content.text;
          }
          return {
            model: "test-host-model",
            role: "assistant" as const,
            content: { type: "text" as const, text: "i think it's risky.\nCONFIDENCE: 60" },
          };
        });
      },
      async (server) => {
        const caller = createSamplingCaller({
          server,
          hostSampleParticipants: { p_self: { modelHint: undefined } },
        });
        return caller(buildModelCallRequest());
      },
    );
    expect(result.content).toContain("CONFIDENCE: 60");
    expect(receivedSystem).toBe("you are a Risk Analyst.");
    expect(receivedUserText).toBe("Should we ship microservices on day one?");
  });

  it("forwards modelHint as a model preference to the host", async () => {
    let receivedHint: string | undefined;
    await withConnectedPair(
      { sampling: {} },
      (client) => {
        client.setRequestHandler(CreateMessageRequestSchema, (req) => {
          const hints = req.params.modelPreferences?.hints;
          if (hints && hints.length > 0) receivedHint = hints[0]?.name;
          return {
            model: "x",
            role: "assistant" as const,
            content: { type: "text" as const, text: "ok" },
          };
        });
      },
      async (server) => {
        const caller = createSamplingCaller({
          server,
          hostSampleParticipants: { p_self: { modelHint: "claude-sonnet" } },
        });
        await caller(buildModelCallRequest());
      },
    );
    expect(receivedHint).toBe("claude-sonnet");
  });

  it("surfaces a clear error when the host returns a non-text content block", async () => {
    await withConnectedPair(
      { sampling: {} },
      (client) => {
        client.setRequestHandler(CreateMessageRequestSchema, () => ({
          model: "x",
          role: "assistant" as const,
          content: { type: "image" as const, data: "Zg==", mimeType: "image/png" },
        }));
      },
      async (server) => {
        const caller = createSamplingCaller({
          server,
          hostSampleParticipants: { p_self: { modelHint: undefined } },
        });
        await expect(caller(buildModelCallRequest())).rejects.toThrow(/only text is supported/);
      },
    );
  });

  it("wraps host-side errors with the participant id for easier diagnosis", async () => {
    await withConnectedPair(
      { sampling: {} },
      (client) => {
        client.setRequestHandler(CreateMessageRequestSchema, () => {
          throw new Error("user denied");
        });
      },
      async (server) => {
        const caller = createSamplingCaller({
          server,
          hostSampleParticipants: { p_self: { modelHint: undefined } },
        });
        await expect(caller(buildModelCallRequest())).rejects.toThrow(/p_self/);
      },
    );
  });

  it("rejects routing for a participant id that has no host-sample entry", async () => {
    await withConnectedPair(
      { sampling: {} },
      () => undefined,
      async (server) => {
        const caller = createSamplingCaller({
          server,
          hostSampleParticipants: {},
        });
        await expect(caller(buildModelCallRequest())).rejects.toThrow(/no host-sample entry/);
      },
    );
  });
});
