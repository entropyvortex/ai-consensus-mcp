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

// A key that only means something on a CLI provider. On the HTTP arm it
// signals a block that was meant to be `transport: "cli"`, so it is rejected
// with that hint instead of being stripped.
function cliOnlyKey(key: string) {
  return z
    .never({
      message: `"${key}" is only valid on a CLI provider; add "transport": "cli" or remove "${key}"`,
    })
    .optional();
}

// The HTTP arm is not strict: like main, it strips unknown keys so existing
// files that carry e.g. "name" or "$comment" keep loading. Omitted `transport`
// stays HTTP and no default is injected, so files round-trip unchanged.
const HttpProviderConfigSchema = z.object({
  transport: z.literal("http").optional(),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  driver: cliOnlyKey("driver"),
  bin: cliOnlyKey("bin"),
  timeoutMs: cliOnlyKey("timeoutMs"),
  authPath: cliOnlyKey("authPath"),
});

// The CLI arm is new, so it is strict: a typo beside `driver` fails instead of
// being stripped.

const CliProviderConfigSchema = z
  .object({
    transport: z.literal("cli"),
    driver: z.enum(["grok", "claude", "codex"]),
    bin: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    authPath: z.string().min(1).optional(),
  })
  .strict();

// The arm is chosen by `transport` ("cli" → CLI arm, omitted or "http" → HTTP
// arm), so a broken block reports only the issues of the arm it targets.
const ProviderConfigSchema = z.discriminatedUnion(
  "transport",
  [CliProviderConfigSchema, HttpProviderConfigSchema],
  {
    errorMap: (issue, ctx) =>
      issue.code === "invalid_union_discriminator"
        ? { message: 'transport must be "cli" or "http" (omit it for HTTP)' }
        : { message: ctx.defaultError },
  },
);

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
    /** In-flight cap for CLI seats. Ignored by HTTP-only panels. Gate lands in a later PR. */
    cliMaxInFlight: z.number().int().min(1).max(4).optional(),
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
  HttpProviderConfigSchema,
  CliProviderConfigSchema,
  ParticipantConfigSchema,
  ProviderParticipantConfigSchema,
  JudgeConfigSchema,
  DefaultsSchema,
};

// ── Resolved / runtime shape ─────────────────────────────────

export type ResolvedProvider = ResolvedHttpProvider | ResolvedCliProvider;

export interface ResolvedHttpProvider {
  id: string;
  transport: "http";
  baseUrl: string;
  apiKey: string;
  extraHeaders: Record<string, string>;
}

export interface ResolvedCliProvider {
  id: string;
  transport: "cli";
  driver: "grok" | "claude" | "codex";
  bin: string;
  timeoutMs: number;
  authPath: string | undefined;
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
  /**
   * Set when configured, or defaulted to 2 when any provider is transport cli.
   * Undefined for HTTP-only configs that omit the key. No gate reads it yet.
   */
  cliMaxInFlight?: number;
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

export interface ResolveConfigOptions {
  /** Default true on Node. Worker entry passes false. */
  allowCli?: boolean;
  /**
   * Where each HTTP provider's `apiKeyEnv` is looked up. Defaults to
   * `process.env`. Replaces it rather than merging, so a Worker can pass its
   * `env` binding.
   */
  env?: Record<string, string | undefined>;
}

/**
 * True when any raw provider uses the CLI transport. The wizard uses this
 * to refuse the HTTP edit form before it can rewrite a subscription seat.
 */
export function configHasCliProvider(raw: RawConfig): boolean {
  return Object.values(raw.providers).some((provider) => provider.transport === "cli");
}

/**
 * Stderr note for `serve` after a CLI provider resolves. Does not spawn.
 * Empty string when every provider is HTTP.
 */
export function formatCliProviderStartupNote(config: LoadedConfig): string {
  const lines: string[] = [];
  for (const provider of Object.values(config.providers)) {
    if (provider.transport !== "cli") continue;
    lines.push(
      `ai-consensus-mcp: CLI provider "${provider.id}" (driver ${provider.driver}) resolved. No process is spawned. Calls fail until a driver is registered; HTTP providers are unaffected.`,
    );
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export async function loadConfig(
  path: string,
  options?: ResolveConfigOptions,
): Promise<LoadedConfig> {
  const absolute = resolvePath(path);
  const raw = await readRawConfig(absolute);
  return resolveConfigFromRaw(raw, absolute, options);
}

/**
 * Load config from a JSON string (e.g. `CONSENSUS_CONFIG_JSON` on Workers).
 * `sourceLabel` is recorded as `LoadedConfig.sourcePath` for logging only.
 */
export function loadConfigFromJson(
  text: string,
  sourceLabel = "CONSENSUS_CONFIG_JSON",
  options?: ResolveConfigOptions,
): LoadedConfig {
  const raw = parseRawConfigJson(text, sourceLabel);
  return resolveConfigFromRaw(raw, sourceLabel, options);
}

/**
 * Parse and validate a raw config object into a fully-resolved `LoadedConfig`.
 * Does not read from disk and does not stat CLI binaries. HTTP providers still
 * require their apiKeyEnv to be set in `options.env` (default `process.env`).
 * CLI providers do not.
 */
export function resolveConfigFromRaw(
  raw: RawConfig,
  sourcePath: string,
  options?: ResolveConfigOptions,
): LoadedConfig {
  // Reject a CLI provider before any API key is looked up, so the Workers
  // error does not depend on where the CLI block sits in the file.
  if (!resolveAllowCli(options)) {
    const cliId = Object.keys(raw.providers).find((id) => raw.providers[id]?.transport === "cli");
    if (cliId !== undefined) throw new Error(workersCliError(cliId));
  }
  const env = options?.env ?? process.env;
  const providers: Record<string, ResolvedProvider> = {};
  for (const [id, cfg] of Object.entries(raw.providers)) {
    if (cfg.transport === "cli") {
      providers[id] = {
        id,
        transport: "cli",
        driver: cfg.driver,
        bin: cfg.bin ?? cfg.driver,
        timeoutMs: cfg.timeoutMs ?? 120_000,
        authPath: cfg.authPath,
      };
      continue;
    }
    const apiKey = env[cfg.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `ai-consensus-mcp: provider "${id}" requires env var ${cfg.apiKeyEnv} but it is not set.`,
      );
    }
    providers[id] = {
      id,
      transport: "http",
      baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
      apiKey,
      extraHeaders: cfg.extraHeaders ?? {},
    };
  }

  // Resolve personas + materialize participants (provider-backed only)
  const participants: Participant[] = [];
  const providerByParticipant: Record<string, string> = {};
  const participantIds = new Set<string>();

  for (const participant of raw.participants) {
    if (participantIds.has(participant.id)) {
      throw new Error(`ai-consensus-mcp: duplicate participant id "${participant.id}".`);
    }
    participantIds.add(participant.id);

    const persona = getPersonaById(participant.personaId);
    if (!persona) {
      throw new Error(
        `ai-consensus-mcp: participant "${participant.id}" references unknown persona id "${participant.personaId}". Known: ${PERSONAS.map(
          (x) => x.id,
        ).join(", ")}.`,
      );
    }

    // Provider-backed only (kind defaults to "provider" for backwards compat).
    if (!providers[participant.provider]) {
      throw new Error(
        `ai-consensus-mcp: participant "${participant.id}" references unknown provider "${participant.provider}". Known: ${Object.keys(providers).join(", ") || "(none)"}.`,
      );
    }

    participants.push(
      buildParticipant(participant.id, participant.modelId, persona, participant.label),
    );
    providerByParticipant[participant.id] = participant.provider;
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

  const anyCli = Object.values(providers).some((provider) => provider.transport === "cli");
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
    cliMaxInFlight: raw.defaults?.cliMaxInFlight ?? (anyCli ? 2 : undefined),
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

function resolveAllowCli(options: ResolveConfigOptions | undefined): boolean {
  if (options?.allowCli !== undefined) return options.allowCli;
  return !cloudflareWorkersUserAgent();
}

function cloudflareWorkersUserAgent(): boolean {
  const nav = (globalThis as { navigator?: { userAgent?: unknown } }).navigator;
  const ua = nav?.userAgent;
  return typeof ua === "string" && ua.includes("Cloudflare-Workers");
}

function workersCliError(id: string): string {
  return (
    `ai-consensus-mcp: provider "${id}" uses transport "cli", which cannot spawn a local process on Cloudflare Workers. ` +
    "Remove CLI providers from CONSENSUS_CONFIG_JSON, or run `ai-consensus-mcp serve` on a machine with the grok, claude, or codex CLI installed. " +
    "HTTP providers in this file were not loaded because the config is rejected as a whole."
  );
}

function parseRawConfigJson(jsonText: string, label: string): RawConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
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
  return flattenZodIssues(err.issues)
    .map((issue) => `  • ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");
}

// Nested union issues already carry their full path from the root, so they
// are emitted as-is rather than prefixed with the union's own path.
function flattenZodIssues(issues: z.ZodIssue[]): { path: (string | number)[]; message: string }[] {
  const out: { path: (string | number)[]; message: string }[] = [];
  for (const issue of issues) {
    if (issue.code === "invalid_union") {
      for (const nested of issue.unionErrors) {
        out.push(...flattenZodIssues(nested.issues));
      }
      continue;
    }
    out.push({ path: issue.path, message: issue.message });
  }
  return out;
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
