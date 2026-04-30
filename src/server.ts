// ─────────────────────────────────────────────────────────────
// MCP server — exposes the `consensus` tool plus one tool per preset
// ─────────────────────────────────────────────────────────────
// The generic `consensus` tool still takes a fully free-form prompt with
// every engine knob exposed. On top of that, each preset (code review,
// architecture debate, etc.) is registered as its own MCP tool —
// `consensus_<preset_id>` — with a curated panel and tuned defaults.
// Hosts surface preset tools in autocomplete; users invoke them with
// one command without needing to know about the underlying knobs.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ConsensusEngine,
  type ConsensusOptions,
  type ConsensusResult,
  type Participant,
} from "ai-consensus-core";
import type { LoadedConfig, ResolvedDefaults } from "./config.js";
import { createOpenAICompatibleCaller } from "./adapter.js";
import { wireEngineProgress } from "./progress.js";
import { BUILT_IN_PRESETS } from "./presets/definitions/index.js";
import { createRegistry, type PresetRegistry } from "./presets/registry.js";
import {
  buildPresetJsonSchema,
  buildPresetZodSchema,
  type PresetInputZodSchema,
} from "./presets/build-input-schema.js";
import { resolvePresetPanel, checkRunnability } from "./presets/resolve-panel.js";
import { formatPresetResult } from "./presets/format.js";
import type { Preset } from "./presets/types.js";

export { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

// ── Generic `consensus` tool input schema ────────────────────

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
      description: "Confidence-delta threshold for disagreement detection. Default: 20.",
    },
    blindFirstRound: {
      type: "boolean",
      description: "If true, round 1 runs in parallel with no cross-visibility. Default: true.",
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

  // Phase 1 ships built-in presets only. Phase 1.7+ will layer
  // user-supplied overrides from `LoadedConfig.presets` here.
  const presets: PresetRegistry = createRegistry(BUILT_IN_PRESETS);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "consensus",
        description: buildGenericToolDescription(config),
        inputSchema: CONSENSUS_INPUT_JSON_SCHEMA,
      },
      ...presets.list().map((preset) => ({
        name: preset.toolName,
        description: buildPresetToolDescription(preset, config),
        inputSchema: buildPresetJsonSchema(preset),
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;

    if (toolName === "consensus") {
      return runGenericConsensus({
        config,
        request,
        extra,
      });
    }

    const preset = presets.byToolName(toolName);
    if (preset) {
      return runPresetConsensus({
        preset,
        config,
        request,
        extra,
      });
    }

    return toolError(`Unknown tool: ${toolName}`);
  });

  return server;
}

// ── Generic `consensus` dispatch (unchanged behaviour) ───────

interface DispatchArgs {
  config: LoadedConfig;
  request: { params: { arguments?: unknown; _meta?: { progressToken?: string | number } } };
  extra: { signal?: AbortSignal; sendNotification?: unknown } | undefined;
}

async function runGenericConsensus(args: DispatchArgs) {
  const { config, request, extra } = args;
  const parsed = ConsensusInputSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return toolError(formatZodIssues(parsed.error));
  }
  const input = parsed.data;

  const selectedParticipants = resolveGenericParticipants(config, input);
  if (selectedParticipants instanceof Error) {
    return toolError(selectedParticipants.message);
  }

  const judgeEnabled = input.judge ?? config.defaults.useJudge;
  if (judgeEnabled && !config.judge) {
    return toolError("Judge was requested but the server config does not declare a `judge` entry.");
  }

  const options = buildEngineOptions({
    question: input.prompt,
    participants: selectedParticipants,
    presetDefaults: undefined,
    inputOverrides: input,
    configDefaults: config.defaults,
    judgeEnabled,
    judgeConfig: config.judge,
    judgeSystemPrompt: undefined,
    signal: extra?.signal,
  });

  const caller = createOpenAICompatibleCaller({
    providers: config.providers,
    providerByParticipant: config.providerByParticipant,
  });

  const engine = new ConsensusEngine(caller);
  const detachProgress = attachProgress({ engine, request, extra, options });

  try {
    const result = await engine.run(options);
    return {
      content: [{ type: "text", text: formatGenericResultSummary(result) }],
      structuredContent: serializeResult(result),
    };
  } catch (err) {
    return toolError(`Consensus run failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    detachProgress();
  }
}

// ── Preset dispatch ──────────────────────────────────────────

interface PresetDispatchArgs extends DispatchArgs {
  preset: Preset;
}

async function runPresetConsensus(args: PresetDispatchArgs) {
  const { preset, config, request, extra } = args;

  const schema: PresetInputZodSchema = buildPresetZodSchema(preset);
  const parsed = schema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return toolError(formatZodIssues(parsed.error));
  }
  const parsedInput = parsed.data as Record<string, unknown>;
  const prompt = parsedInput["prompt"] as string;

  // Pre-flight runnability check — gives a cleaner error than letting
  // resolvePresetPanel fail with the same info but more noise.
  const runnability = checkRunnability(preset, config);
  if (!runnability.runnable) {
    return toolError(
      `Preset "${preset.id}" cannot run with the current config: missing required personas ${runnability.missingPersonaIds
        .map((p) => `"${p}"`)
        .join(", ")}. Configured personas: ${config.participants
        .map((p) => `"${p.persona.id}"`)
        .join(", ")}.`,
    );
  }

  const resolved = resolvePresetPanel(preset, config);
  if (resolved instanceof Error) {
    return toolError(resolved.message);
  }

  const judgeEnabled = (parsedInput["judge"] as boolean | undefined) ?? config.defaults.useJudge;
  // Preset runs don't *require* a judge — they degrade gracefully to raw panel
  // output when none is configured. The formatter notes the absence.

  const options = buildEngineOptions({
    question: prompt,
    participants: resolved.participants,
    presetDefaults: preset.defaults,
    inputOverrides: parsedInput,
    configDefaults: config.defaults,
    judgeEnabled,
    judgeConfig: config.judge,
    judgeSystemPrompt: preset.judgeSystemPrompt,
    signal: extra?.signal,
  });

  const caller = createOpenAICompatibleCaller({
    providers: config.providers,
    providerByParticipant: resolved.providerByParticipant,
  });

  const engine = new ConsensusEngine(caller);
  const detachProgress = attachProgress({ engine, request, extra, options });

  try {
    const result = await engine.run(options);
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsedInput)) {
      if (k !== "prompt" && !PRESET_BASE_KEY_SET.has(k)) extras[k] = v;
    }
    return {
      content: [
        {
          type: "text",
          text: formatPresetResult(preset, result, { prompt, extras }),
        },
      ],
      structuredContent: serializeResult(result),
    };
  } catch (err) {
    return toolError(
      `Preset "${preset.id}" run failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    detachProgress();
  }
}

// ── Shared engine-options builder ────────────────────────────

interface BuildEngineOptionsArgs {
  question: string;
  participants: Participant[];
  presetDefaults: Partial<ResolvedDefaults> | undefined;
  inputOverrides: Record<string, unknown>;
  configDefaults: ResolvedDefaults;
  judgeEnabled: boolean;
  judgeConfig: LoadedConfig["judge"];
  judgeSystemPrompt: string | undefined;
  signal: AbortSignal | undefined;
}

function buildEngineOptions(args: BuildEngineOptionsArgs): ConsensusOptions {
  const {
    question,
    participants,
    presetDefaults,
    inputOverrides: i,
    configDefaults: c,
    judgeEnabled,
    judgeConfig,
    judgeSystemPrompt,
    signal,
  } = args;
  const p = presetDefaults;

  // Resolution order: tool input → preset defaults → config defaults → engine defaults.
  const options: ConsensusOptions = {
    question,
    participants,
    maxRounds: pickNumber(i["maxRounds"], p?.maxRounds, c.maxRounds, 4),
    earlyStop: pickBool(i["earlyStop"], p?.earlyStop, c.earlyStop, true),
    convergenceDelta: pickNumber(i["convergenceDelta"], p?.convergenceDelta, c.convergenceDelta, 3),
    disagreementThreshold: pickNumber(
      i["disagreementThreshold"],
      p?.disagreementThreshold,
      c.disagreementThreshold,
      20,
    ),
    blindFirstRound: pickBool(i["blindFirstRound"], p?.blindFirstRound, c.blindFirstRound, true),
    randomizeOrder: pickBool(i["randomizeOrder"], p?.randomizeOrder, c.randomizeOrder, true),
    participantTemperature: pickNumber(
      i["participantTemperature"],
      p?.participantTemperature,
      c.participantTemperature,
      0.7,
    ),
    maxOutputTokens: pickNumber(i["maxOutputTokens"], p?.maxOutputTokens, c.maxOutputTokens, 1500),
  };
  if (typeof i["randomSeed"] === "number") options.randomSeed = i["randomSeed"];
  if (signal) options.signal = signal;
  if (judgeEnabled && judgeConfig) {
    options.judge = {
      modelId: judgeConfig.modelId,
      ...(judgeConfig.temperature !== undefined ? { temperature: judgeConfig.temperature } : {}),
      ...(judgeConfig.maxOutputTokens !== undefined
        ? { maxOutputTokens: judgeConfig.maxOutputTokens }
        : {}),
      ...(judgeSystemPrompt !== undefined ? { systemPrompt: judgeSystemPrompt } : {}),
    };
  }
  return options;
}

function pickNumber(...candidates: readonly unknown[]): number {
  for (const c of candidates) {
    if (typeof c === "number") return c;
  }
  // Call sites always include a literal-number final fallback — this is a
  // programming-error guard, not a runtime path.
  throw new Error("internal: pickNumber called without a numeric default");
}

function pickBool(...candidates: readonly unknown[]): boolean {
  for (const c of candidates) {
    if (typeof c === "boolean") return c;
  }
  throw new Error("internal: pickBool called without a boolean default");
}

// ── Progress wiring ──────────────────────────────────────────

function attachProgress(args: {
  engine: ConsensusEngine;
  request: DispatchArgs["request"];
  extra: DispatchArgs["extra"];
  options: ConsensusOptions;
}): () => void {
  const { engine, request, extra, options } = args;
  const progressToken = request.params._meta?.progressToken;
  if (progressToken === undefined || !extra?.sendNotification) return () => undefined;

  return wireEngineProgress({
    engine,
    sendNotification: extra.sendNotification as Parameters<
      typeof wireEngineProgress
    >[0]["sendNotification"],
    progressToken,
    maxRounds: options.maxRounds ?? 4,
    judgeEnabled: Boolean(options.judge),
  });
}

// ── Generic-tool helpers ─────────────────────────────────────

function buildGenericToolDescription(config: LoadedConfig): string {
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
    "",
    "For task-specific defaults (code review, architecture debates, etc.),",
    "see the dedicated `consensus_<preset>` tools.",
  ].join("\n");
}

function resolveGenericParticipants(
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

// ── Preset-tool helpers ──────────────────────────────────────

function buildPresetToolDescription(preset: Preset, config: LoadedConfig): string {
  const runnability = checkRunnability(preset, config);
  const panelLines = preset.panel.map((entry) => {
    const required = entry.required ? "[required]" : "[optional]";
    const fallback =
      entry.fallbackPersonaIds && entry.fallbackPersonaIds.length > 0
        ? ` (fallbacks: ${entry.fallbackPersonaIds.join(", ")})`
        : "";
    return `    • ${entry.personaId} ${required}${fallback}`;
  });

  const lines: string[] = [];
  lines.push(preset.description);
  lines.push("");
  lines.push("Panel:");
  lines.push(...panelLines);
  if (!runnability.runnable) {
    lines.push("");
    lines.push(
      `⚠ Currently NOT RUNNABLE — your config is missing required personas: ${runnability.missingPersonaIds.join(", ")}. Add them or switch to a different preset.`,
    );
  }
  return lines.join("\n");
}

const PRESET_BASE_KEY_SET = new Set([
  "prompt",
  "maxRounds",
  "earlyStop",
  "convergenceDelta",
  "disagreementThreshold",
  "blindFirstRound",
  "randomizeOrder",
  "participantTemperature",
  "maxOutputTokens",
  "judge",
  "randomSeed",
]);

// ── Result helpers ───────────────────────────────────────────

function formatZodIssues(error: z.ZodError): string {
  return `Invalid input:\n${error.errors
    .map((e) => `  • ${e.path.join(".") || "<root>"}: ${e.message}`)
    .join("\n")}`;
}

// Tool-response shape is intentionally not pinned to a custom type — the
// SDK's CallToolResult is broader (supports `task`, `_meta`, additional
// content blocks). Returning plain objects lets TS infer compatibility
// with the SDK without us tracking SDK-version churn here.
function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function formatGenericResultSummary(result: ConsensusResult): string {
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
  return result as unknown as Record<string, unknown>;
}
