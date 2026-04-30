// ─────────────────────────────────────────────────────────────
// Preset registry
// ─────────────────────────────────────────────────────────────
// Pure data structure over a list of presets. Validates structural
// invariants on construction and exposes lookup by id / tool name.
//
// User-supplied overrides (from `LoadedConfig.presets`) are layered
// on top of the built-in slate by `mergePresets` — built-in fields
// remain unless explicitly overridden.

import type { Preset, PresetDefaults, PresetPanelEntry } from "./types.js";

export interface PresetRegistry {
  list(): readonly Preset[];
  get(id: string): Preset | undefined;
  byToolName(toolName: string): Preset | undefined;
}

/**
 * Build a registry from a list of preset definitions. Throws on structural
 * problems — duplicate ids, mismatched tool names, empty panels — so a typo
 * in a definition is caught at server start, not on first tool call.
 */
export function createRegistry(presets: readonly Preset[]): PresetRegistry {
  validatePresets(presets);
  const byId = new Map<string, Preset>(presets.map((p) => [p.id, p]));
  const byToolName = new Map<string, Preset>(presets.map((p) => [p.toolName, p]));
  return {
    list: () => presets,
    get: (id) => byId.get(id),
    byToolName: (name) => byToolName.get(name),
  };
}

/**
 * Layer per-preset overrides on top of the built-in slate. Overrides are
 * keyed by preset id. Each override is a `Partial<Preset>`-style patch:
 *   • Scalar fields (`title`, `description`, `judgeSystemPrompt`) replace.
 *   • `defaults` is shallow-merged so users can tweak one knob.
 *   • `panel` either fully replaces the built-in panel or, when omitted,
 *      leaves it untouched. (No deep panel merging — too easy to silently
 *      reorder voices and break expectations.)
 *
 * A user override may also introduce a *new* preset (id not present in the
 * built-in slate) by providing a complete `Preset` shape; the validator
 * enforces that.
 */
export type PresetOverride = Partial<Omit<Preset, "id" | "toolName">> & {
  /** A new preset (not in built-ins) must declare these. */
  panel?: readonly PresetPanelEntry[];
};

export function mergePresets(
  builtIns: readonly Preset[],
  overrides: Readonly<Record<string, PresetOverride>> | undefined,
  newPresets: readonly Preset[] | undefined,
): readonly Preset[] {
  const merged = builtIns.map<Preset>((preset) => {
    const patch = overrides?.[preset.id];
    if (!patch) return preset;
    const next: Preset = {
      ...preset,
      ...patch,
      defaults: mergeDefaults(preset.defaults, patch.defaults),
      panel: patch.panel ?? preset.panel,
    };
    return next;
  });
  if (newPresets && newPresets.length > 0) {
    return [...merged, ...newPresets];
  }
  return merged;
}

function mergeDefaults(base: PresetDefaults, patch: PresetDefaults | undefined): PresetDefaults {
  if (!patch) return base;
  return { ...base, ...patch };
}

// ── Validation ───────────────────────────────────────────────

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export function validatePresets(presets: readonly Preset[]): void {
  const ids = new Set<string>();
  const toolNames = new Set<string>();

  for (const p of presets) {
    if (!ID_PATTERN.test(p.id)) {
      throw new Error(`preset id "${p.id}" must match ${String(ID_PATTERN)} (snake_case, ascii).`);
    }
    if (p.toolName !== `consensus_${p.id}`) {
      throw new Error(`preset "${p.id}" toolName "${p.toolName}" must equal "consensus_${p.id}".`);
    }
    if (ids.has(p.id)) {
      throw new Error(`duplicate preset id "${p.id}".`);
    }
    if (toolNames.has(p.toolName)) {
      throw new Error(`duplicate preset toolName "${p.toolName}".`);
    }
    if (!p.title || p.title.length === 0) {
      throw new Error(`preset "${p.id}" must have a non-empty title.`);
    }
    if (!p.description || p.description.length === 0) {
      throw new Error(`preset "${p.id}" must have a non-empty description.`);
    }
    if (p.panel.length < 2) {
      throw new Error(`preset "${p.id}" panel must have at least 2 entries.`);
    }
    const seenPanelIds = new Set<string>();
    for (const entry of p.panel) {
      if (!entry.personaId || entry.personaId.length === 0) {
        throw new Error(`preset "${p.id}" panel has an entry with empty personaId.`);
      }
      if (seenPanelIds.has(entry.personaId)) {
        throw new Error(
          `preset "${p.id}" panel lists personaId "${entry.personaId}" more than once.`,
        );
      }
      if (!entry.taskSystemSuffix || entry.taskSystemSuffix.length === 0) {
        throw new Error(
          `preset "${p.id}" panel entry "${entry.personaId}" has empty taskSystemSuffix.`,
        );
      }
      seenPanelIds.add(entry.personaId);
    }

    ids.add(p.id);
    toolNames.add(p.toolName);
  }
}
