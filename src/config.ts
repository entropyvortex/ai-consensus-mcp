// ─────────────────────────────────────────────────────────────
// Config loader
// ─────────────────────────────────────────────────────────────
// Parses a JSON config file into a fully-validated, fully-resolved
// shape: provider credentials substituted, personas looked up,
// participants materialised, defaults in place.

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import {
  PERSONAS,
  getPersonaById,
  type Participant,
  type Persona,
} from "@entropyvortex/ai-consensus-core";

// ── Raw config shape (what lives on disk) ────────────────────

const ProviderConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

const ParticipantConfigSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  personaId: z.string().min(1),
  label: z.string().optional(),
});

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
  })
  .strict();

export type RawConfig = z.infer<typeof RawConfigSchema>;
export type RawProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type RawParticipantConfig = z.infer<typeof ParticipantConfigSchema>;
export type RawJudgeConfig = z.infer<typeof JudgeConfigSchema>;
export type RawDefaults = z.infer<typeof DefaultsSchema>;

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
  /** Participant id → provider id, used by the adapter to route calls. */
  providerByParticipant: Record<string, string>;
  /** Optional judge. `providerByParticipant["judge"]` is set when present. */
  judge: ResolvedJudge | undefined;
  /** Defaults to apply when the tool input omits a field. */
  defaults: ResolvedDefaults;
}

// ── Loader ───────────────────────────────────────────────────

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
  const raw = validated.data;

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

  // Resolve personas + materialize participants
  const participants: Participant[] = [];
  const providerByParticipant: Record<string, string> = {};
  const participantIds = new Set<string>();

  for (const p of raw.participants) {
    if (participantIds.has(p.id)) {
      throw new Error(`ai-consensus-mcp: duplicate participant id "${p.id}".`);
    }
    participantIds.add(p.id);

    if (!providers[p.provider]) {
      throw new Error(
        `ai-consensus-mcp: participant "${p.id}" references unknown provider "${p.provider}". Known: ${Object.keys(providers).join(", ") || "(none)"}.`,
      );
    }

    const persona = getPersonaById(p.personaId);
    if (!persona) {
      throw new Error(
        `ai-consensus-mcp: participant "${p.id}" references unknown persona id "${p.personaId}". Known: ${PERSONAS.map(
          (x) => x.id,
        ).join(", ")}.`,
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

  return {
    sourcePath: absolute,
    providers,
    participants,
    providerByParticipant,
    judge,
    defaults,
  };
}

function buildParticipant(
  id: string,
  modelId: string,
  persona: Persona,
  label: string | undefined,
): Participant {
  return label === undefined
    ? { id, modelId, persona }
    : { id, modelId, persona, label };
}

function formatZodError(err: z.ZodError): string {
  return err.errors
    .map((e) => `  • ${e.path.join(".") || "<root>"}: ${e.message}`)
    .join("\n");
}
