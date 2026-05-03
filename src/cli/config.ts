// ─────────────────────────────────────────────────────────────
// `config` subcommand — interactive editor for consensus.config.json
// ─────────────────────────────────────────────────────────────
// Loads (or bootstraps) the raw JSON config and lets the user edit
// every section — providers, participants, judge, defaults — through
// a series of @inquirer/prompts menus. Validates the whole file with
// the Zod schema before writing it back atomically.
//
// All output goes to stderr (consistent with the rest of the CLI).
// The bin's stdout is reserved for MCP traffic when `serve` runs;
// this command is interactive but still keeps that contract so it
// can be safely composed inside terminal multiplexers.
//
// Library choice: @inquirer/prompts (the modular function-per-prompt
// API maintained by the Inquirer.js project). It's the modern,
// ESM-first replacement for the classic `inquirer.prompt(...)`
// builder, has proper TypeScript types out of the box, and matches
// our `verbatimModuleSyntax` build setting cleanly.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { checkbox, confirm, input, number, select, Separator } from "@inquirer/prompts";
import {
  type RawConfig,
  type RawJudgeConfig,
  type RawParticipantConfig,
  type RawProviderConfig,
  RawConfigSchema,
  formatZodError,
  readRawConfig,
  writeRawConfig,
} from "../config.js";
import { PERSONAS } from "../personas.js";
import { SERVER_NAME } from "../version.js";

// ── CLI args ─────────────────────────────────────────────────

interface ConfigArgs {
  configPath: string | undefined;
  help: boolean;
}

const CONFIG_HELP = `
${SERVER_NAME} config — interactive editor for your consensus.config.json

Usage:
  ai-consensus-mcp config [--config <path>]
  ai-consensus-mcp configure [--config <path>]    # alias

Flags:
  -c, --config <path>    Path to a JSON config file. Defaults to
                         ~/.consensus.config.json. Created if missing.
  -h, --help             Show this help.

The editor walks you through every section — providers, participants,
judge, defaults — with inline help and validation. The whole config is
checked against the Zod schema before saving; you can quit without
saving at any time.
`;

function parseConfigArgs(argv: readonly string[]): ConfigArgs | Error {
  const out: ConfigArgs = { configPath: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (!next) return new Error(`Missing value for ${arg}`);
      out.configPath = next;
      i++;
    } else if (arg.startsWith("--config=")) {
      out.configPath = arg.slice("--config=".length);
    } else {
      return new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

// ── Known providers ──────────────────────────────────────────
// Curated presets surfaced in the "+ Add provider" picker so the
// common OpenAI-compatible endpoints are one keystroke away. Order
// here is the order they appear in the menu.

interface ProviderPreset {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
}

const KNOWN_PROVIDERS: readonly ProviderPreset[] = [
  {
    id: "xai",
    displayName: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "GROK_API_KEY",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    // Namespaced to avoid colliding with Claude Code's own ANTHROPIC_API_KEY
    // detection — that conflicts with users on a Claude Max subscription.
    apiKeyEnv: "CONSENSUS_ANTHROPIC_API_KEY",
  },
  {
    id: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
  },
];

// ── Default starter config ───────────────────────────────────
// Used when the editor is launched against a path that doesn't
// exist yet. Same shape as consensus.config.example.json, but
// embedded so the editor doesn't depend on the example file
// being shipped at a particular relative path.

function starterConfig(): RawConfig {
  return {
    providers: {
      xai: {
        baseUrl: "https://api.x.ai/v1",
        apiKeyEnv: "GROK_API_KEY",
      },
      anthropic: {
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyEnv: "CONSENSUS_ANTHROPIC_API_KEY",
      },
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    },
    participants: [
      {
        id: "grok",
        provider: "xai",
        modelId: "grok-4",
        personaId: "pessimist",
      },
      {
        id: "domain",
        provider: "anthropic",
        modelId: "claude-opus-4-5",
        personaId: "domain-expert",
      },
      {
        id: "first-principles",
        provider: "openai",
        modelId: "gpt-4o",
        personaId: "first-principles",
      },
    ],
  };
}

// ── Entry point ──────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = resolvePath(homedir(), ".consensus.config.json");

export async function runConfig(argv: readonly string[]): Promise<number> {
  const parsed = parseConfigArgs(argv);
  if (parsed instanceof Error) {
    process.stderr.write(`${SERVER_NAME}: ${parsed.message}\n${CONFIG_HELP}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stderr.write(`${CONFIG_HELP}\n`);
    return 0;
  }

  const path = resolvePath(parsed.configPath ?? DEFAULT_CONFIG_PATH);
  let config: RawConfig;
  let isNew = false;

  if (existsSync(path)) {
    try {
      config = await readRawConfig(path);
      process.stderr.write(`Loaded config from ${path}\n`);
    } catch (err) {
      process.stderr.write(
        `\n${err instanceof Error ? err.message : String(err)}\n\n` +
          `Fix the file by hand or pass --config <other-path> to start fresh.\n`,
      );
      return 1;
    }
  } else {
    process.stderr.write(`No config at ${path} — starting from a template.\n`);
    config = starterConfig();
    isNew = true;
  }

  try {
    return await runMainMenu(config, path, isNew);
  } catch (err) {
    if (isPromptCancelled(err)) {
      process.stderr.write(`\nAborted. No changes saved.\n`);
      return 130;
    }
    throw err;
  }
}

// `@inquirer/prompts` throws an `ExitPromptError` when the user hits
// Ctrl-C. We treat that as "discard and quit" rather than a crash.
function isPromptCancelled(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "ExitPromptError") return true;
    if (err.message.includes("force closed")) return true;
  }
  return false;
}

// ── Top-level menu ───────────────────────────────────────────

async function runMainMenu(initial: RawConfig, path: string, isNew: boolean): Promise<number> {
  let config: RawConfig = structuredClone(initial);
  let dirty = isNew;

  for (;;) {
    const summary = configSummary(config);
    process.stderr.write(`\n${summary}\n`);

    const action = await select<MenuAction>({
      message: `What would you like to do?${dirty ? " (unsaved changes)" : ""}`,
      choices: [
        { name: "Edit providers", value: "providers" },
        { name: "Edit participants (AIs)", value: "participants" },
        { name: "Edit judge", value: "judge" },
        { name: "Edit defaults", value: "defaults" },
        new Separator(),
        { name: "View raw JSON", value: "view" },
        { name: "Validate now", value: "validate" },
        new Separator(),
        { name: "Save & exit", value: "save" },
        { name: "Discard & exit", value: "discard" },
      ],
    });

    if (action === "providers") {
      const next = await editProviders(config);
      if (next) {
        config = next;
        dirty = true;
      }
    } else if (action === "participants") {
      const next = await editParticipants(config);
      if (next) {
        config = next;
        dirty = true;
      }
    } else if (action === "judge") {
      const next = await editJudge(config);
      if (next) {
        config = next;
        dirty = true;
      }
    } else if (action === "defaults") {
      const next = await editDefaults(config);
      if (next) {
        config = next;
        dirty = true;
      }
    } else if (action === "view") {
      process.stderr.write(`\n${JSON.stringify(config, null, 2)}\n`);
    } else if (action === "validate") {
      const result = RawConfigSchema.safeParse(config);
      if (result.success) {
        process.stderr.write(`\n✓ Config validates cleanly.\n`);
      } else {
        process.stderr.write(`\n✗ Validation failed:\n${formatZodError(result.error)}\n`);
      }
    } else if (action === "save") {
      const result = RawConfigSchema.safeParse(config);
      if (!result.success) {
        process.stderr.write(
          `\n✗ Cannot save — config is invalid:\n${formatZodError(result.error)}\n`,
        );
        const proceed = await confirm({
          message: "Continue editing? (No exits without saving.)",
          default: true,
        });
        if (!proceed) return 1;
        continue;
      }
      try {
        await writeRawConfig(path, result.data);
      } catch (err) {
        process.stderr.write(
          `\n✗ Failed to save: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
      process.stderr.write(`\n✓ Saved ${path}\n`);
      return 0;
    } else if (action === "discard") {
      if (dirty) {
        const ok = await confirm({
          message: "Discard all unsaved changes?",
          default: false,
        });
        if (!ok) continue;
      }
      process.stderr.write(`\nNo changes saved.\n`);
      return 0;
    }
  }
}

type MenuAction =
  | "providers"
  | "participants"
  | "judge"
  | "defaults"
  | "view"
  | "validate"
  | "save"
  | "discard";

function configSummary(c: RawConfig): string {
  const providerCount = Object.keys(c.providers).length;
  const participantCount = c.participants.length;
  const judgeBit = c.judge ? `, judge=${c.judge.modelId}` : ", no judge";
  return (
    `Current: ${providerCount} provider(s), ${participantCount} participant(s)${judgeBit}\n` +
    `         providers: ${Object.keys(c.providers).join(", ") || "(none)"}\n` +
    `         participants: ${c.participants.map((p) => p.id).join(", ") || "(none)"}`
  );
}

// ── Providers ────────────────────────────────────────────────

async function editProviders(config: RawConfig): Promise<RawConfig | undefined> {
  const next = structuredClone(config);
  let touched = false;

  for (;;) {
    const ids = Object.keys(next.providers);
    const action = await select<string>({
      message: "Providers",
      choices: [
        { name: "+ Add provider", value: "__add__" },
        ...(ids.length > 0 ? [new Separator(), ...ids.map((id) => ({ name: id, value: id }))] : []),
        new Separator(),
        { name: "← Back", value: "__back__" },
      ],
    });

    if (action === "__back__") {
      return touched ? next : undefined;
    }

    if (action === "__add__") {
      const created = await editProviderForm(next, undefined);
      if (created) {
        next.providers[created.id] = created.cfg;
        touched = true;
      }
      continue;
    }

    // Existing provider — submenu.
    const sub = await select<"edit" | "remove" | "back">({
      message: `Provider "${action}"`,
      choices: [
        { name: "Edit", value: "edit" },
        { name: "Remove", value: "remove" },
        { name: "← Back", value: "back" },
      ],
    });

    if (sub === "edit") {
      const updated = await editProviderForm(next, action);
      if (updated) {
        if (updated.id !== action) delete next.providers[action];
        next.providers[updated.id] = updated.cfg;
        touched = true;
      }
    } else if (sub === "remove") {
      const ok = await confirm({
        message: `Remove provider "${action}"? Participants referencing it will become invalid.`,
        default: false,
      });
      if (ok) {
        delete next.providers[action];
        touched = true;
      }
    }
  }
}

async function editProviderForm(
  config: RawConfig,
  existingId: string | undefined,
): Promise<{ id: string; cfg: RawProviderConfig } | undefined> {
  const existing = existingId ? config.providers[existingId] : undefined;

  // When adding (no existingId), offer one-keystroke presets for the
  // best-known OpenAI-compatible providers. The picker just pre-fills
  // defaults for id/baseUrl/apiKeyEnv — every value is still confirmable
  // in the prompts below.
  let preset: ProviderPreset | undefined;
  if (existingId === undefined) {
    const choice = await select<string>({
      message: "Provider preset",
      choices: [
        ...KNOWN_PROVIDERS.map((p) => ({
          name: `${p.displayName}  [${p.id}]`,
          value: p.id,
          description: `${p.baseUrl}  · key from $${p.apiKeyEnv}`,
        })),
        new Separator(),
        { name: "Custom (enter values manually)", value: "__custom__" },
      ],
      default: KNOWN_PROVIDERS[0]!.id,
    });
    if (choice !== "__custom__") {
      preset = KNOWN_PROVIDERS.find((p) => p.id === choice);
    }
  }

  const id = await input({
    message: "Provider id (key under `providers`, e.g. `xai`, `anthropic`, `openai`)",
    default: existingId ?? preset?.id ?? "",
    validate: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return "Required";
      if (trimmed !== existingId && config.providers[trimmed]) {
        return `Provider "${trimmed}" already exists`;
      }
      return true;
    },
  });

  const baseUrl = await input({
    message: "Base URL (OpenAI-compatible, no trailing /chat/completions)",
    default: existing?.baseUrl ?? preset?.baseUrl ?? "https://api.openai.com/v1",
    validate: (v) => {
      try {
        new URL(v);
        return true;
      } catch {
        return "Must be a valid URL";
      }
    },
  });

  const apiKeyEnv = await input({
    message: "Env var holding the API key (e.g. `GROK_API_KEY`, `OPENAI_API_KEY`)",
    default: existing?.apiKeyEnv ?? preset?.apiKeyEnv ?? "",
    validate: (v) => (v.trim() ? true : "Required"),
  });

  const editHeaders = await confirm({
    message: "Configure extraHeaders? (rarely needed)",
    default: existing?.extraHeaders !== undefined,
  });

  let extraHeaders: Record<string, string> | undefined;
  if (editHeaders) {
    extraHeaders = await editHeadersMap(existing?.extraHeaders);
  }

  const cfg: RawProviderConfig = {
    baseUrl: baseUrl.trim(),
    apiKeyEnv: apiKeyEnv.trim(),
    ...(extraHeaders && Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
  };

  return { id: id.trim(), cfg };
}

async function editHeadersMap(
  initial: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(initial ?? {}) };

  for (;;) {
    const keys = Object.keys(headers);
    const choice = await select<string>({
      message: "Extra headers",
      choices: [
        { name: "+ Add header", value: "__add__" },
        ...(keys.length > 0
          ? [new Separator(), ...keys.map((k) => ({ name: `${k}=${headers[k] ?? ""}`, value: k }))]
          : []),
        new Separator(),
        { name: "← Done", value: "__done__" },
      ],
    });

    if (choice === "__done__") return headers;

    if (choice === "__add__") {
      const name = await input({
        message: "Header name",
        validate: (v) => (v.trim() ? true : "Required"),
      });
      const value = await input({ message: "Header value" });
      headers[name.trim()] = value;
      continue;
    }

    const sub = await select<"edit" | "remove" | "back">({
      message: `Header "${choice}"`,
      choices: [
        { name: "Edit value", value: "edit" },
        { name: "Remove", value: "remove" },
        { name: "← Back", value: "back" },
      ],
    });
    if (sub === "edit") {
      const value = await input({
        message: `Value for ${choice}`,
        default: headers[choice] ?? "",
      });
      headers[choice] = value;
    } else if (sub === "remove") {
      delete headers[choice];
    }
  }
}

// ── Participants ─────────────────────────────────────────────

async function editParticipants(config: RawConfig): Promise<RawConfig | undefined> {
  // host-sample participants don't need a provider, so the participant menu
  // is reachable even with zero providers configured. Provider-backed entries
  // still validate that a provider exists at form time.
  const next = structuredClone(config);
  let touched = false;

  for (;;) {
    const action = await select<string>({
      message: `Participants (${next.participants.length}; min 2 required)`,
      choices: [
        { name: "+ Add participant", value: "__add__" },
        ...(next.participants.length > 0
          ? [
              new Separator(),
              ...next.participants.map((p, i) => ({
                name: `${p.id}  [${describeParticipantBackend(p)}, persona=${p.personaId}]`,
                value: `__idx__${i}`,
              })),
            ]
          : []),
        new Separator(),
        { name: "← Back", value: "__back__" },
      ],
    });

    if (action === "__back__") {
      return touched ? next : undefined;
    }

    if (action === "__add__") {
      const created = await editParticipantForm(next, undefined);
      if (created) {
        next.participants.push(created);
        touched = true;
      }
      continue;
    }

    const idx = Number(action.slice("__idx__".length));
    const target = next.participants[idx];
    if (!target) continue;

    const sub = await select<"edit" | "remove" | "back">({
      message: `Participant "${target.id}"`,
      choices: [
        { name: "Edit", value: "edit" },
        { name: "Remove", value: "remove" },
        { name: "← Back", value: "back" },
      ],
    });

    if (sub === "edit") {
      const updated = await editParticipantForm(next, idx);
      if (updated) {
        next.participants[idx] = updated;
        touched = true;
      }
    } else if (sub === "remove") {
      if (next.participants.length <= 2) {
        const ok = await confirm({
          message: `A consensus run requires at least 2 participants — removing "${target.id}" leaves ${next.participants.length - 1}. Continue anyway?`,
          default: false,
        });
        if (!ok) continue;
      }
      next.participants.splice(idx, 1);
      // If the judge referenced this participant by index, no impact —
      // the judge keys off provider id, not participant id.
      touched = true;
    }
  }
}

function describeParticipantBackend(p: RawParticipantConfig): string {
  if (p.kind === "host-sample") {
    return p.modelHint ? `host-sample (hint: ${p.modelHint})` : "host-sample";
  }
  return `${p.provider}/${p.modelId}`;
}

async function editParticipantForm(
  config: RawConfig,
  editingIdx: number | undefined,
): Promise<RawParticipantConfig | undefined> {
  const existing = editingIdx !== undefined ? config.participants[editingIdx] : undefined;
  const providerIds = Object.keys(config.providers);

  const id = await input({
    message: "Participant id (stable, appears in events + progress)",
    default: existing?.id ?? "",
    validate: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return "Required";
      const dup = config.participants.findIndex((p) => p.id === trimmed);
      if (dup !== -1 && dup !== editingIdx) {
        return `Participant id "${trimmed}" already in use`;
      }
      return true;
    },
  });

  // Pick the backend: a configured provider, or the calling MCP host (sampling).
  const kindChoices: { name: string; value: "provider" | "host-sample"; description?: string }[] = [
    {
      name: "Configured provider (HTTP, requires API key)",
      value: "provider",
      description: "OpenAI, Anthropic, xAI, Groq, etc.",
    },
    {
      name: "MCP host sampling (the calling agent answers)",
      value: "host-sample",
      description: "The host (Claude Code, Cursor, …) responds with whatever model it is running.",
    },
  ];
  const kind = await select<"provider" | "host-sample">({
    message: "Backend",
    choices: kindChoices,
    default: existing?.kind === "host-sample" ? "host-sample" : "provider",
  });

  const personaId = await select<string>({
    message: "Persona",
    choices: PERSONAS.map((p) => ({
      name: `${p.emoji} ${p.id} — ${p.name}`,
      value: p.id,
      description: p.description,
    })),
    default: existing?.personaId ?? PERSONAS[0]!.id,
  });

  const wantsLabel = await confirm({
    message: "Add an optional display label?",
    default: existing?.label !== undefined,
  });

  let label: string | undefined;
  if (wantsLabel) {
    const labelInput = await input({
      message: "Label",
      default: existing?.label ?? "",
    });
    const trimmed = labelInput.trim();
    label = trimmed.length > 0 ? trimmed : undefined;
  }

  if (kind === "host-sample") {
    const wantsHint = await confirm({
      message: "Provide an optional modelHint for the host's sampler? (most users skip this)",
      default: existing?.kind === "host-sample" && existing.modelHint !== undefined,
    });
    let modelHint: string | undefined;
    if (wantsHint) {
      const hintInput = await input({
        message: "modelHint (e.g. `claude-sonnet`, `gpt-5`)",
        default: existing?.kind === "host-sample" ? (existing.modelHint ?? "") : "",
      });
      const trimmed = hintInput.trim();
      modelHint = trimmed.length > 0 ? trimmed : undefined;
    }
    return {
      kind: "host-sample",
      id: id.trim(),
      personaId,
      ...(label !== undefined ? { label } : {}),
      ...(modelHint !== undefined ? { modelHint } : {}),
    };
  }

  // kind === "provider" — need provider + modelId.
  if (providerIds.length === 0) {
    process.stderr.write(
      `\n⚠ No providers configured yet. Add at least one provider before using a provider-backed participant.\n`,
    );
    return undefined;
  }

  const provider = await select<string>({
    message: "Provider",
    choices: providerIds.map((p) => ({ name: p, value: p })),
    default:
      existing?.kind !== "host-sample" ? (existing?.provider ?? providerIds[0]!) : providerIds[0]!,
  });

  const modelId = await input({
    message: "Model id (opaque string the provider accepts)",
    default: existing?.kind !== "host-sample" ? (existing?.modelId ?? "") : "",
    validate: (v) => (v.trim() ? true : "Required"),
  });

  return {
    id: id.trim(),
    provider,
    modelId: modelId.trim(),
    personaId,
    ...(label !== undefined ? { label } : {}),
  };
}

// ── Judge ────────────────────────────────────────────────────

async function editJudge(config: RawConfig): Promise<RawConfig | undefined> {
  if (Object.keys(config.providers).length === 0) {
    process.stderr.write(
      `\n⚠ No providers configured yet. Add at least one provider before configuring a judge.\n`,
    );
    return undefined;
  }

  const next = structuredClone(config);

  if (!next.judge) {
    const enable = await confirm({
      message: "No judge configured. Add one?",
      default: true,
    });
    if (!enable) return undefined;
    const created = await editJudgeForm(next, undefined);
    if (!created) return undefined;
    next.judge = created;
    return next;
  }

  const action = await select<"edit" | "remove" | "back">({
    message: `Judge (${next.judge.provider}/${next.judge.modelId})`,
    choices: [
      { name: "Edit", value: "edit" },
      { name: "Remove", value: "remove" },
      { name: "← Back", value: "back" },
    ],
  });

  if (action === "back") return undefined;

  if (action === "remove") {
    const ok = await confirm({
      message: "Remove the judge? defaults.useJudge will fall back to false.",
      default: false,
    });
    if (!ok) return undefined;
    delete next.judge;
    return next;
  }

  const updated = await editJudgeForm(next, next.judge);
  if (!updated) return undefined;
  next.judge = updated;
  return next;
}

async function editJudgeForm(
  config: RawConfig,
  existing: RawJudgeConfig | undefined,
): Promise<RawJudgeConfig | undefined> {
  const providerIds = Object.keys(config.providers);

  const provider = await select<string>({
    message: "Judge provider",
    choices: providerIds.map((p) => ({ name: p, value: p })),
    default: existing?.provider ?? providerIds[0]!,
  });

  const modelId = await input({
    message: "Judge model id",
    default: existing?.modelId ?? "",
    validate: (v) => (v.trim() ? true : "Required"),
  });

  const wantsTemp = await confirm({
    message: "Override temperature? (default 0.3)",
    default: existing?.temperature !== undefined,
  });
  let temperature: number | undefined;
  if (wantsTemp) {
    const v = await number({
      message: "Temperature (0–2)",
      default: existing?.temperature ?? 0.3,
      min: 0,
      max: 2,
      required: true,
    });
    temperature = v ?? undefined;
  }

  const wantsTokens = await confirm({
    message: "Override maxOutputTokens? (default 1500)",
    default: existing?.maxOutputTokens !== undefined,
  });
  let maxOutputTokens: number | undefined;
  if (wantsTokens) {
    const v = await number({
      message: "maxOutputTokens (positive integer)",
      default: existing?.maxOutputTokens ?? 1500,
      min: 1,
      step: 1,
      required: true,
    });
    maxOutputTokens = v ?? undefined;
  }

  return {
    provider,
    modelId: modelId.trim(),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

// ── Defaults ─────────────────────────────────────────────────

async function editDefaults(config: RawConfig): Promise<RawConfig | undefined> {
  const next = structuredClone(config);
  const current = next.defaults ?? {};

  const fields = [
    { key: "maxRounds" as const, name: "maxRounds (1–10)" },
    { key: "earlyStop" as const, name: "earlyStop (boolean)" },
    { key: "convergenceDelta" as const, name: "convergenceDelta (number ≥ 0)" },
    { key: "disagreementThreshold" as const, name: "disagreementThreshold (number ≥ 0)" },
    { key: "blindFirstRound" as const, name: "blindFirstRound (boolean)" },
    { key: "randomizeOrder" as const, name: "randomizeOrder (boolean)" },
    { key: "participantTemperature" as const, name: "participantTemperature (0–2)" },
    { key: "maxOutputTokens" as const, name: "maxOutputTokens (positive int)" },
    { key: "useJudge" as const, name: "useJudge (boolean)" },
  ];

  const setKeys = await checkbox<DefaultKey>({
    message: "Which defaults do you want to set? (space to toggle, enter to confirm)",
    choices: fields.map((f) => ({
      name: f.name,
      value: f.key,
      checked: current[f.key] !== undefined,
    })),
  });

  const drafted: Record<string, unknown> = {};

  for (const key of setKeys) {
    if (
      key === "earlyStop" ||
      key === "blindFirstRound" ||
      key === "randomizeOrder" ||
      key === "useJudge"
    ) {
      drafted[key] = await confirm({
        message: key,
        default: current[key] ?? true,
      });
    } else if (key === "maxRounds") {
      const v = await number({
        message: "maxRounds (1–10)",
        default: current.maxRounds ?? 4,
        min: 1,
        max: 10,
        step: 1,
        required: true,
      });
      if (v !== undefined && v !== null) drafted[key] = v;
    } else if (key === "maxOutputTokens") {
      const v = await number({
        message: "maxOutputTokens",
        default: current.maxOutputTokens ?? 1500,
        min: 1,
        step: 1,
        required: true,
      });
      if (v !== undefined && v !== null) drafted[key] = v;
    } else if (key === "participantTemperature") {
      const v = await number({
        message: "participantTemperature (0–2)",
        default: current.participantTemperature ?? 0.7,
        min: 0,
        max: 2,
        required: true,
      });
      if (v !== undefined && v !== null) drafted[key] = v;
    } else if (key === "convergenceDelta") {
      const v = await number({
        message: "convergenceDelta (≥ 0)",
        default: current.convergenceDelta ?? 3,
        min: 0,
        required: true,
      });
      if (v !== undefined && v !== null) drafted[key] = v;
    } else if (key === "disagreementThreshold") {
      const v = await number({
        message: "disagreementThreshold (≥ 0)",
        default: current.disagreementThreshold ?? 20,
        min: 0,
        required: true,
      });
      if (v !== undefined && v !== null) drafted[key] = v;
    }
  }

  if (Object.keys(drafted).length === 0) {
    delete next.defaults;
  } else {
    next.defaults = drafted;
  }

  return next;
}

type DefaultKey =
  | "maxRounds"
  | "earlyStop"
  | "convergenceDelta"
  | "disagreementThreshold"
  | "blindFirstRound"
  | "randomizeOrder"
  | "participantTemperature"
  | "maxOutputTokens"
  | "useJudge";
