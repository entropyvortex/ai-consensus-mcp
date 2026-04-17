// ─────────────────────────────────────────────────────────────
// MCP server — exposes the `consensus` tool over stdio
// ─────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ConsensusEngine,
  PERSONAS,
  type ConsensusOptions,
  type ConsensusResult,
  type Participant,
} from "@entropyvortex/ai-consensus-core";
import type { LoadedConfig } from "./config.js";
import { createOpenAICompatibleCaller } from "./adapter.js";
import { wireEngineProgress, type SendNotification } from "./progress.js";

export const SERVER_NAME = "ai-consensus-mcp";
export const SERVER_VERSION = "0.9.0";

// ── Tool input schema ────────────────────────────────────────

const ConsensusInputSchema = z.object({
  prompt: z.string().min(1),
  participantIds: z.array(z.string().min(1)).min(2).optional(),
  maxRounds: z.number().int().min(1).max(10).optional(),
  earlyStop: z.boolean().optional(),
  convergenceDelta: z.number().min(0).optional(),
  disagreementThreshold: z.number().min(0).optional(),
  blindFirstRound: z.boolean().optional(),
  randomizeOrder: z.boolean().optional(),
  participantTemperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  judge: z.boolean().optional(),
  randomSeed: z.number().int().nonnegative().optional(),
});

type ConsensusInput = z.infer<typeof ConsensusInputSchema>;

// JSON Schema mirror of the zod schema, for MCP tool advertisement.
// Kept hand-written (no zod-to-json-schema dep) so the advertised shape
// is exactly what the server enforces and nothing more.
const CONSENSUS_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      description: "The question or topic to run consensus on.",
    },
    participantIds: {
      type: "array",
      minItems: 2,
      items: { type: "string", minLength: 1 },
      description:
        "Subset of participant ids from the server's config to include in this run. Defaults to ALL configured participants.",
    },
    maxRounds: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description: "Maximum CVP rounds. Default: 4 (or config.defaults.maxRounds).",
    },
    earlyStop: {
      type: "boolean",
      description:
        "Stop early when |Δscore| ≤ convergenceDelta between consecutive rounds. Default: true.",
    },
    convergenceDelta: {
      type: "number",
      minimum: 0,
      description: "Convergence threshold on the consensus-score delta. Default: 3.",
    },
    disagreementThreshold: {
      type: "number",
      minimum: 0,
      description:
        "Confidence-delta threshold for disagreement detection. Default: 20.",
    },
    blindFirstRound: {
      type: "boolean",
      description:
        "If true, round 1 runs in parallel with no cross-visibility. Default: true.",
    },
    randomizeOrder: {
      type: "boolean",
      description: "Shuffle speaking order on rounds 2+. Default: true.",
    },
    participantTemperature: {
      type: "number",
      minimum: 0,
      maximum: 2,
      description: "Sampling temperature for participants. Default: 0.7.",
    },
    maxOutputTokens: {
      type: "integer",
      minimum: 1,
      description: "Max output tokens per participant call. Default: 1500.",
    },
    judge: {
      type: "boolean",
      description:
        "Run the non-voting Judge synthesizer after the final round. Default: true if the config declares a judge, else false.",
    },
    randomSeed: {
      type: "integer",
      minimum: 0,
      description: "If set, seeds the round-order shuffle for deterministic replay.",
    },
  },
} as const;

// ── Factory ──────────────────────────────────────────────────

export function createMcpServer(config: LoadedConfig): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const caller = createOpenAICompatibleCaller(config);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "consensus",
        description: buildToolDescription(config),
        inputSchema: CONSENSUS_INPUT_JSON_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== "consensus") {
      return toolError(`Unknown tool: ${request.params.name}`);
    }

    const parsed = ConsensusInputSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return toolError(
        `Invalid input:\n${parsed.error.errors
          .map((e) => `  • ${e.path.join(".") || "<root>"}: ${e.message}`)
          .join("\n")}`,
      );
    }
    const input = parsed.data;

    const selectedParticipants = resolveParticipants(config, input);
    if (selectedParticipants instanceof Error) {
      return toolError(selectedParticipants.message);
    }

    const judgeEnabled = input.judge ?? config.defaults.useJudge;
    if (judgeEnabled && !config.judge) {
      return toolError(
        "Judge was requested but the server config does not declare a `judge` entry.",
      );
    }

    const options = buildEngineOptions({
      config,
      input,
      participants: selectedParticipants,
      judgeEnabled,
      signal: extra?.signal,
    });

    const engine = new ConsensusEngine(caller);

    const progressToken = request.params._meta?.progressToken;
    const detachProgress =
      progressToken !== undefined && extra?.sendNotification
        ? wireEngineProgress({
            engine,
            sendNotification: extra.sendNotification as unknown as SendNotification,
            progressToken,
            maxRounds: options.maxRounds ?? 4,
            judgeEnabled: Boolean(options.judge),
          })
        : () => undefined;

    try {
      const result = await engine.run(options);
      return {
        content: [
          { type: "text", text: formatResultSummary(result) },
        ],
        structuredContent: serializeResult(result),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toolError(`Consensus run failed: ${message}`);
    } finally {
      detachProgress();
    }
  });

  return server;
}

// ── Helpers ─────────────────────────────────────────────────

function buildToolDescription(config: LoadedConfig): string {
  const participantLines = config.participants.map(
    (p) => `    • ${p.id} — ${p.persona.name} on ${p.modelId}`,
  );
  const judgeLine = config.judge
    ? `  Judge: ${config.judge.modelId} (provider: ${config.judge.providerId})\n`
    : "  Judge: none configured\n";
  return [
    "Run the Consensus Validation Protocol over the configured panel of models.",
    "",
    "Each participant adopts one of seven structured personas (Risk Analyst,",
    "First-Principles Engineer, VC Specialist, Scientific Skeptic, Optimistic",
    "Futurist, Devil's Advocate, Domain Expert). Round 1 is blind and parallel;",
    "later rounds are sequential with full history. Each response ends with a",
    "CONFIDENCE: 0-100 marker. The consensus score is avg − 0.5·stddev over those.",
    "",
    "Configured participants:",
    ...participantLines,
    "",
    judgeLine.trimEnd(),
  ].join("\n");
}

function resolveParticipants(
  config: LoadedConfig,
  input: ConsensusInput,
): Participant[] | Error {
  if (!input.participantIds || input.participantIds.length === 0) {
    return config.participants;
  }
  const byId = new Map(config.participants.map((p) => [p.id, p]));
  const selected: Participant[] = [];
  for (const id of input.participantIds) {
    const p = byId.get(id);
    if (!p) {
      return new Error(
        `Unknown participantId "${id}". Available: ${config.participants
          .map((x) => x.id)
          .join(", ")}.`,
      );
    }
    selected.push(p);
  }
  if (selected.length < 2) {
    return new Error("At least 2 participantIds are required.");
  }
  return selected;
}

function buildEngineOptions(args: {
  config: LoadedConfig;
  input: ConsensusInput;
  participants: Participant[];
  judgeEnabled: boolean;
  signal: AbortSignal | undefined;
}): ConsensusOptions {
  const { config, input, participants, judgeEnabled, signal } = args;
  const d = config.defaults;

  const options: ConsensusOptions = {
    question: input.prompt,
    participants,
    maxRounds: input.maxRounds ?? d.maxRounds ?? 4,
    earlyStop: input.earlyStop ?? d.earlyStop ?? true,
    convergenceDelta: input.convergenceDelta ?? d.convergenceDelta ?? 3,
    disagreementThreshold:
      input.disagreementThreshold ?? d.disagreementThreshold ?? 20,
    blindFirstRound: input.blindFirstRound ?? d.blindFirstRound ?? true,
    randomizeOrder: input.randomizeOrder ?? d.randomizeOrder ?? true,
    participantTemperature:
      input.participantTemperature ?? d.participantTemperature ?? 0.7,
    maxOutputTokens: input.maxOutputTokens ?? d.maxOutputTokens ?? 1500,
  };
  if (input.randomSeed !== undefined) options.randomSeed = input.randomSeed;
  if (signal) options.signal = signal;
  if (judgeEnabled && config.judge) {
    options.judge = {
      modelId: config.judge.modelId,
      ...(config.judge.temperature !== undefined
        ? { temperature: config.judge.temperature }
        : {}),
      ...(config.judge.maxOutputTokens !== undefined
        ? { maxOutputTokens: config.judge.maxOutputTokens }
        : {}),
    };
  }
  return options;
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

// ── Result formatting ───────────────────────────────────────

function formatResultSummary(result: ConsensusResult): string {
  const lines: string[] = [];
  lines.push(`# Consensus Result`);
  lines.push("");
  lines.push(`**Question:** ${result.question}`);
  lines.push("");
  lines.push(
    `**Final score:** ${result.finalScore} (avg=${result.finalAverageConfidence.toFixed(
      1,
    )}, σ=${result.finalStddev.toFixed(1)})`,
  );
  lines.push(
    `**Rounds:** ${result.roundsCompleted} / ${result.rounds.length === 0 ? "?" : result.rounds[0]!.round}  •  **Stop reason:** ${result.stopReason}`,
  );
  if (result.earlyStop) {
    lines.push(
      `**Early stop:** round ${result.earlyStop.round}, Δ=${result.earlyStop.delta.toFixed(1)}`,
    );
  }
  lines.push(`**Duration:** ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push("");

  lines.push(`## Per-round scores`);
  lines.push("");
  lines.push("| Round | Phase | Label | Score | Avg | σ | Disagreements |");
  lines.push("| ----- | ----- | ----- | ----- | --- | - | ------------- |");
  for (const r of result.rounds) {
    lines.push(
      `| ${r.round} | ${r.phase} | ${r.label} | ${r.score} | ${r.averageConfidence.toFixed(1)} | ${r.stddev.toFixed(1)} | ${r.disagreements.length} |`,
    );
  }
  lines.push("");

  const lastRound = result.rounds[result.rounds.length - 1];
  if (lastRound) {
    lines.push(`## Final-round responses`);
    lines.push("");
    for (const resp of lastRound.responses) {
      const participant = result.participants.find((p) => p.id === resp.participantId);
      const heading = participant
        ? `${participant.persona.name} (${resp.modelId}) — ${resp.error ? "ERROR" : `confidence ${resp.confidence}`}`
        : `${resp.participantId} — confidence ${resp.confidence}`;
      lines.push(`### ${heading}`);
      lines.push("");
      lines.push(resp.content.trim());
      lines.push("");
    }
  }

  if (result.synthesis) {
    lines.push(`## Judge synthesis (${result.synthesis.modelId})`);
    lines.push("");
    lines.push(`_Self-reported synthesis confidence: ${result.synthesis.judgeConfidence}_`);
    lines.push("");
    lines.push(result.synthesis.content.trim());
    lines.push("");
  }

  return lines.join("\n");
}

function serializeResult(result: ConsensusResult): Record<string, unknown> {
  // Already JSON-safe (primitives, arrays, plain objects). Cast without
  // rebuilding to preserve field order for consumers diffing snapshots.
  return result as unknown as Record<string, unknown>;
}
