// ─────────────────────────────────────────────────────────────
// Config loader
// ─────────────────────────────────────────────────────────────
// Parses a JSON config file into a fully-validated, fully-resolved
// shape: provider credentials substituted, personas looked up,
// participants materialised, defaults in place.

import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { Participant, Persona } from "ai-consensus-core";
import { PERSONAS, getPersonaById } from "./personas.js";
import { MemoryConfigSchema, type MemoryConfig } from "./memory/types.js";

// ── Raw config shape (what lives on disk) ────────────────────

const ProviderConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

// Participant config (provider-backed only).
// Existing configs that omit `kind` resolve to "provider" for backwards
// compatibility.

const ParticipantConfigBaseSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  label: z.string().optional(),
});

const ProviderParticipantConfigSchema = ParticipantConfigBaseSchema.extend({
  kind: z.literal("provider").optional(),
  provider: z.string().min(1),
  modelId: z.string().min(1),
}).strict();

const ParticipantConfigSchema = ProviderParticipantConfigSchema;

const JudgeConfigSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

const DefaultsSchema = z
  .object({
    maxRounds: z.number().int().min(1).max(10).optional(),
    earlyStop: z.boolean().optional(),
    convergenceDelta: z.number().min(0).optional(),
    disagreementThreshold: z.number().min(0).optional(),
    blindFirstRound: z.boolean().optional(),
    randomizeOrder: z.boolean().optional(),
    participantTemperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    useJudge: z.boolean().optional(),
  })
  .strict();

const RawConfigSchema = z
  .object({
    $schema: z.string().optional(),
    providers: z.record(z.string(), ProviderConfigSchema),
    participants: z.array(ParticipantConfigSchema).min(2),
    judge: JudgeConfigSchema.optional(),
    defaults: DefaultsSchema.optional(),
    /**
     * Optional memory-layer config. Off by default — every field opt-in.
     * See docs/memory-layer.md + PREMORTEM-memory-layer.md.
     */
    memory: MemoryConfigSchema.optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof RawConfigSchema>;
export type RawProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type RawParticipantConfig = z.infer<typeof ParticipantConfigSchema>;
export type RawProviderParticipantConfig = z.infer<typeof ProviderParticipantConfigSchema>;
export type RawJudgeConfig = z.infer<typeof JudgeConfigSchema>;
export type RawDefaults = z.infer<typeof DefaultsSchema>;

export {
  RawConfigSchema,
  ProviderConfigSchema,
  ParticipantConfigSchema,
  ProviderParticipantConfigSchema,
  JudgeConfigSchema,
  DefaultsSchema,
};

// ── Resolved / runtime shape ─────────────────────────────────

export interface ResolvedProvider {
  id: string;
  baseUrl: string;
  apiKey: string;
  extraHeaders: Record<string, string>;
}

export interface ResolvedJudge {
  providerId: string;
  modelId: string;
  temperature: number | undefined;
  maxOutputTokens: number | undefined;
}

export interface ResolvedDefaults {
  maxRounds: number | undefined;
  earlyStop: boolean | undefined;
  convergenceDelta: number | undefined;
  disagreementThreshold: number | undefined;
  blindFirstRound: boolean | undefined;
  randomizeOrder: boolean | undefined;
  participantTemperature: number | undefined;
  maxOutputTokens: number | undefined;
  useJudge: boolean;
}

export interface LoadedConfig {
  /** Absolute path of the config file this was loaded from. */
  sourcePath: string;
  /** Provider id → resolved provider (with api key looked up from env). */
  providers: Record<string, ResolvedProvider>;
  /** Fully materialised participants, ready to pass to ConsensusEngine. */
  participants: Participant[];
  /** Participant id → provider id (used by the adapter for routing). */
  providerByParticipant: Record<string, string>;
  /** Optional judge. `providerByParticipant["judge"]` is set when present. */
  judge: ResolvedJudge | undefined;
  /** Defaults to apply when the tool input omits a field. */
  defaults: ResolvedDefaults;
  /**
   * Resolved memory-layer config. `enabled === false` skips wiring memory
   * tools and never touches disk.
   */
  memory: ResolvedMemoryRuntime;
}

export interface ResolvedMemoryRuntime {
  enabled: boolean;
  /**
   * Absolute storage root. When `memory.storagePath` is set in the config,
   * it's taken verbatim. Otherwise defaults to `~/.consensus/memory/`.
   * The project-key suffix is applied at store-construction time, not here.
   */
  storageRoot: string;
  maxResults: number;
  maxAgeDays: number;
  /** Raw config block, for inspection / round-tripping. */
  raw: MemoryConfig | undefined;
}

// ── Loader ───────────────────────────────────────────────────

/**
 * Parse and validate a raw config object into a fully-resolved `LoadedConfig`.
 * Does not read from disk — use `loadConfig` for file-based loading, or call
 * this directly in serverless runtimes (e.g. Cloudflare Workers) that receive
 * config from an environment variable or KV store.
 */
export function resolveConfigFromRaw(raw: RawConfig, sourcePath: string): LoadedConfig {
  // Resolve providers (env var → api key)
  const providers: Record<string, ResolvedProvider> = {};
  for (const [id, cfg] of Object.entries(raw.providers)) {
    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `ai-consensus-mcp: provider "${id}" requires env var ${cfg.apiKeyEnv} but it is not set.`,
      );
    }
    providers[id] = {
      id,
      baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
      apiKey,
      extraHeaders: cfg.extraHeaders ?? {},
    };
  }

  // Resolve personas + materialize participants (provider-backed only)
  const participants: Participant[] = [];
  const providerByParticipant: Record<string, string> = {};
  const participantIds = new Set<string>();

  for (const p of raw.participants) {
    if (participantIds.has(p.id)) {
      throw new Error(`ai-consensus-mcp: duplicate participant id "${p.id}".`);
    }
    participantIds.add(p.id);

    const persona = getPersonaById(p.personaId);
    if (!persona) {
      throw new Error(
        `ai-consensus-mcp: participant "${p.id}" references unknown persona id "${p.personaId}". Known: ${PERSONAS.map(
          (x) => x.id,
        ).join(", ")}.`,
      );
    }

    // Provider-backed only (kind defaults to "provider" for backwards compat).
    if (!providers[p.provider]) {
      throw new Error(
        `ai-consensus-mcp: participant "${p.id}" references unknown provider "${p.provider}". Known: ${Object.keys(providers).join(", ") || "(none)"}.`,
      );
    }

    participants.push(buildParticipant(p.id, p.modelId, persona, p.label));
    providerByParticipant[p.id] = p.provider;
  }

  // Optional judge
  let judge: ResolvedJudge | undefined;
  if (raw.judge) {
    if (!providers[raw.judge.provider]) {
      throw new Error(
        `ai-consensus-mcp: judge references unknown provider "${raw.judge.provider}".`,
      );
    }
    judge = {
      providerId: raw.judge.provider,
      modelId: raw.judge.modelId,
      temperature: raw.judge.temperature,
      maxOutputTokens: raw.judge.maxOutputTokens,
    };
    providerByParticipant["judge"] = raw.judge.provider;
  }

  const defaults: ResolvedDefaults = {
    maxRounds: raw.defaults?.maxRounds,
    earlyStop: raw.defaults?.earlyStop,
    convergenceDelta: raw.defaults?.convergenceDelta,
    disagreementThreshold: raw.defaults?.disagreementThreshold,
    blindFirstRound: raw.defaults?.blindFirstRound,
    randomizeOrder: raw.defaults?.randomizeOrder,
    participantTemperature: raw.defaults?.participantTemperature,
    maxOutputTokens: raw.defaults?.maxOutputTokens,
    useJudge: raw.defaults?.useJudge ?? Boolean(judge),
  };

  const memory = resolveMemoryRuntime(raw.memory);

  return {
    sourcePath,
    providers,
    participants,
    providerByParticipant,
    judge,
    defaults,
    memory,
  };
}

function parseRawConfigJson(text: string, label: string): RawConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `ai-consensus-mcp: config at ${label} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const validated = RawConfigSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `ai-consensus-mcp: config at ${label} failed validation:\n${formatZodError(validated.error)}`,
    );
  }
  return validated.data;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const absolute = resolvePath(path);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (err) {
    throw new Error(
      `ai-consensus-mcp: could not read config at ${absolute}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const raw = parseRawConfigJson(text, absolute);
  return resolveConfigFromRaw(raw, absolute);
}

/**
 * Load config from a JSON string (e.g. `CONSENSUS_CONFIG_JSON` in Workers).
 * `sourceLabel` is recorded as `LoadedConfig.sourcePath` for logging only.
 */
export function loadConfigFromJson(
  text: string,
  sourceLabel = "CONSENSUS_CONFIG_JSON",
): LoadedConfig {
  const raw = parseRawConfigJson(text, sourceLabel);
  return resolveConfigFromRaw(raw, sourceLabel);
}

/**
 * Defaults the memory-layer's storage root to `~/.consensus/memory` when the
 * user didn't supply one. Pure (no I/O) so call sites can rely on it for
 * test scaffolding too.
 */
export function resolveMemoryRuntime(raw: MemoryConfig | undefined): ResolvedMemoryRuntime {
  const enabled = raw?.enabled ?? false;
  const defaultRoot = join(homedir(), ".consensus", "memory");
  const storageRoot = raw?.storagePath ? resolvePath(raw.storagePath) : defaultRoot;
  return {
    enabled,
    storageRoot,
    maxResults: raw?.retention?.maxResults ?? 1000,
    maxAgeDays: raw?.retention?.maxAgeDays ?? 365,
    raw,
  };
}

function buildParticipant(
  id: string,
  modelId: string,
  persona: Persona,
  label: string | undefined,
): Participant {
  return label === undefined ? { id, modelId, persona } : { id, modelId, persona, label };
}

export function formatZodError(err: z.ZodError): string {
  return err.errors.map((e) => `  • ${e.path.join(".") || "<root>"}: ${e.message}`).join("\n");
}

// ── Read/write helpers used by the interactive config editor ─────
// `loadConfig` above resolves env vars and personas, which the editor
// can't do (env vars may be unset on a fresh machine, and we want to
// edit by id, not materialised Persona objects). These two helpers
// operate on the raw on-disk shape only.

/**
 * Read a config file and validate it against the raw schema, without
 * resolving env vars or personas. Used by the TUI editor to load an
 * existing config for editing.
 */
export async function readRawConfig(path: string): Promise<RawConfig> {
  const absolute = resolvePath(path);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (err) {
    throw new Error(
      `ai-consensus-mcp: could not read config at ${absolute}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `ai-consensus-mcp: config at ${absolute} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const validated = RawConfigSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `ai-consensus-mcp: config at ${absolute} failed validation:\n${formatZodError(validated.error)}`,
    );
  }
  return validated.data;
}

/**
 * Validate a raw config and write it to disk as pretty JSON. The write
 * is atomic: contents go to a sibling `<name>.tmp` file first and then
 * `rename(2)` into place, so a crash mid-write can never leave the
 * config half-written.
 *
 * Throws if the input fails schema validation — callers should validate
 * before getting here, but this is the last-line safety net.
 */
export async function writeRawConfig(path: string, config: RawConfig): Promise<void> {
  const validated = RawConfigSchema.safeParse(config);
  if (!validated.success) {
    throw new Error(
      `ai-consensus-mcp: refusing to write invalid config:\n${formatZodError(validated.error)}`,
    );
  }
  const absolute = resolvePath(path);
  const tmpPath = `${absolute}.tmp`;
  const json = `${JSON.stringify(validated.data, null, 2)}\n`;
  await writeFile(tmpPath, json, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(tmpPath, absolute);
  } catch (err) {
    throw new Error(
      `ai-consensus-mcp: could not write config to ${absolute} (tmp at ${tmpPath} kept for inspection): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
