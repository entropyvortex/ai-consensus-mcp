// ─────────────────────────────────────────────────────────────
// MCP server — exposes the `consensus` tool plus one tool per preset
// ─────────────────────────────────────────────────────────────
// The generic `consensus` tool still takes a fully free-form prompt with
// every engine knob exposed. On top of that, each preset (code review,
// architecture debate, etc.) is registered as its own MCP tool —
// `consensus_<preset_id>` — with a curated panel and tuned defaults.
// Hosts surface preset tools in autocomplete; users invoke them with
// one command without needing to know about the underlying knobs.

import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
import { createMemoryStore, type MemoryStore } from "./memory/store.js";
import { projectKeyForPath } from "./memory/project-key.js";
import { join as joinPath } from "node:path";

export { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

// ── Generic `consensus` tool input schema ────────────────────

const ConsensusInputSchema = z.object({
  prompt: z.string().min(1),
  participantIds: z.array(z.string().min(1)).min(2).optional(),
  /**
   * Optional expert-panel id (e.g. "architecture_v2"). When set, the panel's
   * persona panel and tuned defaults are applied to this run — equivalent to
   * calling the panel's dedicated `consensus_<id>` tool, but accessible via
   * the generic `consensus` interface so hosts that don't enumerate per-panel
   * tools can still target a specific panel.
   *
   * Mutually exclusive with `participantIds` — the panel owns the panel.
   */
  panel: z.string().min(1).optional(),
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
        "Subset of participant ids from the server's config to include in this run. Defaults to ALL configured participants. Mutually exclusive with `panel`.",
    },
    panel: {
      type: "string",
      minLength: 1,
      description:
        'Expert-panel id (e.g. "architecture_v2", "security_redteam"). When set, applies that panel\'s persona panel and tuned defaults — equivalent to calling the panel\'s dedicated tool. Mutually exclusive with `participantIds`.',
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

  // Memory layer is opt-in (premortem F10). Set up the lazy store accessor
  // when enabled; otherwise the recall tools are never advertised.
  const memoryContext = resolveMemoryContext(config);

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
      ...(memoryContext ? buildMemoryToolDescriptors(memoryContext) : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;

    if (toolName === "consensus") {
      return runGenericConsensus({
        config,
        server,
        presets,
        memoryContext,
        request,
        extra,
      });
    }

    const preset = presets.byToolName(toolName);
    if (preset) {
      return runPresetConsensus({
        preset,
        config,
        server,
        presets,
        memoryContext,
        request,
        extra,
      });
    }

    if (memoryContext) {
      if (toolName === "consensus_recall") {
        return runRecall({ memoryContext, request });
      }
      if (toolName === "consensus_project_memory") {
        return runProjectMemory({ memoryContext, request });
      }
      if (toolName === "consensus_what_we_decided") {
        return runWhatWeDecided({ memoryContext, request });
      }
    }

    return toolError(`Unknown tool: ${toolName}`);
  });

  return server;
}



// ── Generic `consensus` dispatch (unchanged behaviour) ───────

interface DispatchArgs {
  config: LoadedConfig;
  /** Active MCP server instance. */
  server: Server;
  /** Panel/preset registry — used by `panel` arg resolution on the generic tool. */
  presets: PresetRegistry;
  /** Memory layer context (project identity + lazy store). `undefined` when memory is disabled. */
  memoryContext: MemoryContext | undefined;
  request: { params: { arguments?: unknown; _meta?: { progressToken?: string | number } } };
  extra: { signal?: AbortSignal; sendNotification?: unknown } | undefined;
}

async function runGenericConsensus(args: DispatchArgs) {
  const { config, server, request, extra } = args;
  const parsed = ConsensusInputSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return toolError(formatZodIssues(parsed.error));
  }
  const input = parsed.data;

  // `panel` and `participantIds` are mutually exclusive — both targeting the
  // composition of the panel from different angles. Pick one.
  if (input.panel && input.participantIds && input.participantIds.length > 0) {
    return toolError(
      "`panel` and `participantIds` are mutually exclusive — a panel id selects the panel composition; participantIds picks raw participants.",
    );
  }

  // When `panel` is set, dispatch through the same resolver presets use.
  // The panel's persona panel, task suffixes, defaults, and judge prompt
  // are applied automatically; the user's other engine-knob overrides still win.
  const panelOverlay = input.panel ? args.presets.get(input.panel) : undefined;
  if (input.panel && !panelOverlay) {
    const available = args.presets
      .list()
      .map((p) => p.id)
      .join(", ");
    return toolError(`Unknown panel id "${input.panel}". Available: ${available}.`);
  }

  let selectedParticipants: Participant[];
  let providerByParticipant: Record<string, string>;
  let presetDefaultsForOptions: Preset["defaults"] | undefined;
  let judgeSystemPromptForOptions: string | undefined;

  if (panelOverlay) {
    const runnability = checkRunnability(panelOverlay, config);
    if (!runnability.runnable) {
      return toolError(
        `Panel "${panelOverlay.id}" cannot run with the current config: missing required personas ${runnability.missingPersonaIds
          .map((p) => `"${p}"`)
          .join(", ")}. Configured personas: ${config.participants
          .map((p) => `"${p.persona.id}"`)
          .join(", ")}.`,
      );
    }
    const resolved = resolvePresetPanel(panelOverlay, config);
    if (resolved instanceof Error) {
      return toolError(resolved.message);
    }
    selectedParticipants = resolved.participants;
    providerByParticipant = resolved.providerByParticipant;
    presetDefaultsForOptions = panelOverlay.defaults;
    judgeSystemPromptForOptions = panelOverlay.judgeSystemPrompt;
  } else {
    const generic = resolveGenericParticipants(config, input);
    if (generic instanceof Error) {
      return toolError(generic.message);
    }
    selectedParticipants = generic;
    providerByParticipant = config.providerByParticipant;
    presetDefaultsForOptions = undefined;
    judgeSystemPromptForOptions = undefined;
  }

  const judgeEnabled = input.judge ?? config.defaults.useJudge;
  if (judgeEnabled && !config.judge) {
    return toolError("Judge was requested but the server config does not declare a `judge` entry.");
  }

  const options = buildEngineOptions({
    question: input.prompt,
    participants: selectedParticipants,
    presetDefaults: presetDefaultsForOptions,
    inputOverrides: input,
    configDefaults: config.defaults,
    judgeEnabled,
    judgeConfig: config.judge,
    judgeSystemPrompt: judgeSystemPromptForOptions,
    signal: extra?.signal,
  });

  const caller = createOpenAICompatibleCaller({
    providers: config.providers,
    providerByParticipant,
  });

  const engine = new ConsensusEngine(caller);
  const detachProgress = attachProgress({ engine, request, extra, options });

  try {
    const result = await engine.run(options);
    await maybeStoreResult({
      memoryContext: args.memoryContext,
      panelId: panelOverlay?.id ?? "consensus",
      question: input.prompt,
      tags: collectStoreTagsForPanel(panelOverlay),
      result,
    });
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
  const { preset, config, server, request, extra } = args;

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
    await maybeStoreResult({
      memoryContext: args.memoryContext,
      panelId: preset.id,
      question: prompt,
      tags: collectStoreTagsForPanel(preset),
      result,
    });
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

// ─────────────────────────────────────────────────────────────
// Memory layer integration
// ─────────────────────────────────────────────────────────────
// `MemoryContext` carries the project identity and a lazy store handle
// through the dispatch closure. The store is created on first use so
// server startup remains synchronous — opening fs and ensuring the
// index file at startup would force `createMcpServer` to become async.

interface MemoryContext {
  storageRoot: string;
  projectKey: string;
  projectPath: string;
  getStore: () => Promise<MemoryStore>;
}

function resolveMemoryContext(config: LoadedConfig): MemoryContext | undefined {
  if (!config.memory.enabled) return undefined;

  const rawProjectPath = config.memory.raw?.projectPath ?? process.cwd();
  const absolute = resolvePath(rawProjectPath);
  // Resolve symlinks at startup — F4. realpathSync may throw if the path
  // does not exist; fall back to the absolute-but-not-resolved form so
  // a misconfigured project path doesn't crash the server.
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    /* keep `absolute` */
  }
  const projectKey = projectKeyForPath(canonical);
  const storageRoot = joinPath(config.memory.storageRoot, projectKey);

  let cached: Promise<MemoryStore> | undefined;
  const getStore = (): Promise<MemoryStore> => {
    cached ??= createMemoryStore({
      storageRoot,
      projectKey,
      projectPath: canonical,
      maxResults: config.memory.maxResults,
      maxAgeDays: config.memory.maxAgeDays,
    });
    return cached;
  };

  return { storageRoot, projectKey, projectPath: canonical, getStore };
}

function buildMemoryToolDescriptors(ctx: MemoryContext): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}[] {
  return [
    {
      name: "consensus_recall",
      description: [
        "Recall stored consensus runs from this project.",
        "",
        `Project: ${ctx.projectPath} (key ${ctx.projectKey})`,
        "Storage:",
        `  ${ctx.storageRoot}`,
        "",
        "Free-form `query` is matched as whole-token, case-insensitive against the",
        "stored question + tags. Filter by `panelId`, `tags`, or `sinceDays`.",
        "Results carry an `ageDays` field and the matched fragments so the caller",
        "can sanity-check relevance before reusing the content.",
        "",
        "⚠ Freshness note: recalled content is historical context, not current truth.",
        "A panel decision made 90 days ago may be invalidated by later context — check",
        "the age tag and any tripwire conditions named in the stored synthesis before",
        "treating recalled material as authoritative.",
      ].join("\n"),
      inputSchema: RECALL_INPUT_JSON_SCHEMA,
    },
    {
      name: "consensus_project_memory",
      description: [
        "List every stored consensus run in this project.",
        "",
        "Returns a chronological digest of past runs — panel, question, when,",
        "final score, judge confidence — without loading the full result bodies.",
        "Use this to get oriented before recalling a specific decision.",
      ].join("\n"),
      inputSchema: PROJECT_MEMORY_INPUT_JSON_SCHEMA,
    },
    {
      name: "consensus_what_we_decided",
      description: [
        "Find prior decisions matching a topic, scoped to this project.",
        "",
        "Shorthand for `consensus_recall` with sane defaults for decision-archaeology:",
        "filters to decision-support panels (`architecture_*`, `decision_*`, `product_strategy`),",
        "returns the judge synthesis verbatim, and includes the timestamp prominently",
        "so a caller can spot a stale decision before re-applying it.",
      ].join("\n"),
      inputSchema: WHAT_WE_DECIDED_INPUT_JSON_SCHEMA,
    },
  ];
}

const RECALL_INPUT_SCHEMA = z.object({
  query: z.string().optional(),
  panelId: z.string().min(1).optional(),
  anyTag: z.array(z.string().min(1)).optional(),
  allTags: z.array(z.string().min(1)).optional(),
  sinceDays: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  acrossProjects: z.boolean().optional(),
});

const RECALL_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Free-form text. Tokens are whole-word matched." },
    panelId: { type: "string", minLength: 1, description: "Restrict to one panel id." },
    anyTag: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Match any of these tags.",
    },
    allTags: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Match all of these tags.",
    },
    sinceDays: { type: "integer", minimum: 1, description: "Only entries stored within N days." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Max results. Default 20." },
    acrossProjects: {
      type: "boolean",
      description: "Recall across all projects, not just this one. Default false.",
    },
  },
} as const;

const PROJECT_MEMORY_INPUT_SCHEMA = z.object({
  panelId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const PROJECT_MEMORY_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    panelId: { type: "string", minLength: 1, description: "Restrict to one panel id." },
    limit: { type: "integer", minimum: 1, maximum: 500, description: "Max rows. Default 100." },
  },
} as const;

const WHAT_WE_DECIDED_INPUT_SCHEMA = z.object({
  topic: z.string().min(1),
  sinceDays: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const WHAT_WE_DECIDED_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic"],
  properties: {
    topic: {
      type: "string",
      minLength: 1,
      description: "Topic to search for in stored decisions.",
    },
    sinceDays: { type: "integer", minimum: 1, description: "Only entries stored within N days." },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Max results. Default 10." },
  },
} as const;

/** Best-effort store. Memory failures are reported on stderr but never break a successful run. */
async function maybeStoreResult(args: {
  memoryContext: MemoryContext | undefined;
  panelId: string;
  question: string;
  tags: string[];
  result: ConsensusResult;
}): Promise<void> {
  if (!args.memoryContext) return;
  try {
    const store = await args.memoryContext.getStore();
    await store.store({
      projectKey: args.memoryContext.projectKey,
      projectPath: args.memoryContext.projectPath,
      panelId: args.panelId,
      question: args.question,
      result: args.result,
      tags: args.tags,
    });
  } catch (err) {
    process.stderr.write(
      `ai-consensus-mcp: memory store failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function collectStoreTagsForPanel(panel: Preset | undefined): string[] {
  if (!panel) return [];
  const tags = new Set<string>();
  if (panel.meta?.tags) {
    for (const t of panel.meta.tags) tags.add(t);
  }
  if (panel.meta?.version) tags.add(`v${panel.meta.version}`);
  return [...tags];
}

interface MemoryDispatchArgs {
  memoryContext: MemoryContext;
  request: DispatchArgs["request"];
}

async function runRecall(args: MemoryDispatchArgs) {
  const parsed = RECALL_INPUT_SCHEMA.safeParse(args.request.params.arguments ?? {});
  if (!parsed.success) return toolError(formatZodIssues(parsed.error));
  const store = await args.memoryContext.getStore();
  const queryArgs = {
    ...parsed.data,
    ...(parsed.data.query !== undefined ? { query: parsed.data.query } : {}),
  };
  const hits = await store.recall(queryArgs);
  return {
    content: [{ type: "text", text: formatRecallHits(hits, args.memoryContext) }],
    structuredContent: { hits } as unknown as Record<string, unknown>,
  };
}

async function runProjectMemory(args: MemoryDispatchArgs) {
  const parsed = PROJECT_MEMORY_INPUT_SCHEMA.safeParse(args.request.params.arguments ?? {});
  if (!parsed.success) return toolError(formatZodIssues(parsed.error));
  const store = await args.memoryContext.getStore();
  const limit = parsed.data.limit ?? 100;
  const hits = await store.recall({
    limit,
    ...(parsed.data.panelId ? { panelId: parsed.data.panelId } : {}),
  });
  return {
    content: [{ type: "text", text: formatProjectMemory(hits, args.memoryContext) }],
    structuredContent: { hits } as unknown as Record<string, unknown>,
  };
}

const DECISION_PANEL_IDS = [
  "architecture_debate",
  "architecture_v2",
  "decision_making",
  "decision_making_v2",
  "product_strategy",
];

async function runWhatWeDecided(args: MemoryDispatchArgs) {
  const parsed = WHAT_WE_DECIDED_INPUT_SCHEMA.safeParse(args.request.params.arguments ?? {});
  if (!parsed.success) return toolError(formatZodIssues(parsed.error));
  const store = await args.memoryContext.getStore();
  const limit = parsed.data.limit ?? 10;
  // Run the recall once per decision-related panel id and merge. Cheap —
  // each call is a single index scan.
  const merged = new Map<string, Awaited<ReturnType<typeof store.recall>>[number]>();
  for (const panelId of DECISION_PANEL_IDS) {
    const hits = await store.recall({
      query: parsed.data.topic,
      panelId,
      limit,
      ...(parsed.data.sinceDays !== undefined ? { sinceDays: parsed.data.sinceDays } : {}),
    });
    for (const h of hits) merged.set(h.id, h);
  }
  const all = [...merged.values()].sort((a, b) => b.score - a.score || b.storedAt - a.storedAt);
  const top = all.slice(0, limit);
  return {
    content: [
      { type: "text", text: formatWhatWeDecided(top, parsed.data.topic, args.memoryContext) },
    ],
    structuredContent: { hits: top } as unknown as Record<string, unknown>,
  };
}

// ── Memory rendering ─────────────────────────────────────────

type RecallHit = Awaited<ReturnType<MemoryStore["recall"]>>[number];

function formatRecallHits(hits: readonly RecallHit[], ctx: MemoryContext): string {
  if (hits.length === 0) {
    return [
      "# No stored runs matched",
      "",
      `Project: \`${ctx.projectPath}\``,
      "",
      "_(Tip: this tool is scoped to the current project by default. Use `acrossProjects: true` to search the whole memory store.)_",
    ].join("\n");
  }
  const lines: string[] = [];
  lines.push(`# Recall (${hits.length} match${hits.length === 1 ? "" : "es"})`);
  lines.push("");
  lines.push(`_Project: \`${ctx.projectPath}\`_`);
  lines.push("");
  for (const h of hits) {
    lines.push(`## ${h.panelId} — ${ageLabel(h.ageDays)} (score ${h.score.toFixed(2)})`);
    lines.push("");
    lines.push(`**Question:** ${h.question}`);
    lines.push("");
    lines.push(
      `**Final score:** ${h.finalScore >= 0 ? h.finalScore : "—"}  •  ` +
        `**Judge confidence:** ${h.judgeConfidence >= 0 ? h.judgeConfidence : "—"}  •  ` +
        `**Tags:** ${h.tags.length > 0 ? h.tags.join(", ") : "(none)"}  •  ` +
        `**Id:** \`${h.id}\``,
    );
    if (h.matchedFragments.length > 0) {
      lines.push(`**Matched:** ${h.matchedFragments.map((f) => `\`${f}\``).join(" • ")}`);
    }
    lines.push("");
    lines.push("**Synthesis preview:**");
    lines.push("");
    lines.push(h.summary);
    lines.push("");
  }
  return lines.join("\n");
}

function formatProjectMemory(hits: readonly RecallHit[], ctx: MemoryContext): string {
  if (hits.length === 0) {
    return [
      "# Project memory is empty",
      "",
      `Project: \`${ctx.projectPath}\``,
      "",
      "_No consensus runs have been stored for this project yet._",
    ].join("\n");
  }
  // Sort by stored-at descending (recency).
  const byRecency = hits.slice().sort((a, b) => b.storedAt - a.storedAt);
  const lines: string[] = [];
  lines.push(`# Project memory (${hits.length} stored run${hits.length === 1 ? "" : "s"})`);
  lines.push("");
  lines.push(`_Project: \`${ctx.projectPath}\`_`);
  lines.push("");
  lines.push("| When | Panel | Score | Judge | Question |");
  lines.push("| ---- | ----- | ----- | ----- | -------- |");
  for (const h of byRecency) {
    const truncatedQ = h.question.length > 80 ? `${h.question.slice(0, 79)}…` : h.question;
    lines.push(
      `| ${ageLabel(h.ageDays)} | ${h.panelId} | ${h.finalScore >= 0 ? h.finalScore : "—"} | ${
        h.judgeConfidence >= 0 ? h.judgeConfidence : "—"
      } | ${escapeTablePipe(truncatedQ)} |`,
    );
  }
  return lines.join("\n");
}

function formatWhatWeDecided(
  hits: readonly RecallHit[],
  topic: string,
  ctx: MemoryContext,
): string {
  if (hits.length === 0) {
    return [
      `# No decisions found for "${topic}"`,
      "",
      `Project: \`${ctx.projectPath}\``,
      "",
      `_Tried decision panels: ${DECISION_PANEL_IDS.join(", ")}. None of them returned a match for "${topic}". Try \`consensus_recall\` to search beyond decision panels._`,
    ].join("\n");
  }
  const lines: string[] = [];
  lines.push(`# Decisions matching "${topic}"`);
  lines.push("");
  lines.push(
    `_Project: \`${ctx.projectPath}\` — ${hits.length} match${hits.length === 1 ? "" : "es"}_`,
  );
  lines.push("");
  for (const h of hits) {
    lines.push(
      `## ${h.panelId} — ${new Date(h.storedAt).toISOString().slice(0, 10)} (${ageLabel(h.ageDays)})`,
    );
    lines.push("");
    lines.push(`**Question:** ${h.question}`);
    lines.push("");
    lines.push(
      `**Score:** ${h.finalScore >= 0 ? h.finalScore : "—"}  •  **Judge confidence:** ${h.judgeConfidence >= 0 ? h.judgeConfidence : "—"}`,
    );
    if (h.matchedFragments.length > 0) {
      lines.push(`**Matched on:** ${h.matchedFragments.map((f) => `\`${f}\``).join(" • ")}`);
    }
    lines.push("");
    lines.push(`**Synthesis:**`);
    lines.push("");
    lines.push(h.summary);
    lines.push("");
  }
  return lines.join("\n");
}

function ageLabel(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  return `${(days / 365).toFixed(1)} yr ago`;
}

function escapeTablePipe(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
