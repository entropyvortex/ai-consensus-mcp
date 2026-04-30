// ─────────────────────────────────────────────────────────────
// Resolve a preset's panel against the user's configured participants
// ─────────────────────────────────────────────────────────────
// A preset declares its panel by persona id. The user, in their config,
// declares their participants — each carrying a persona. This module is
// the join: it walks the preset's panel, finds matching configured
// participants (or fallbacks), and mints fresh Participant objects with
// task-specific suffixes baked into their system prompts.
//
// The original `LoadedConfig.participants` and global `PERSONAS` are not
// mutated. Specialised personas live only on the per-call participants.

import type { Participant, Persona } from "ai-consensus-core";
import type { LoadedConfig } from "../config.js";
import type { Preset, PresetRunnability } from "./types.js";

export interface ResolvedPanel {
  participants: Participant[];
  /** Provider routing for the resolved participants — superset of LoadedConfig's. */
  providerByParticipant: Record<string, string>;
}

/**
 * Decide whether a preset can run against a user's configured panel.
 * Used at ListTools time to mark presets as currently-runnable in their
 * description, and at CallTool time as a clearer error than letting
 * `resolvePresetPanel` fail.
 */
export function checkRunnability(preset: Preset, config: LoadedConfig): PresetRunnability {
  const configured = new Set(config.participants.map((p) => p.persona.id));
  const missing: string[] = [];

  for (const entry of preset.panel) {
    if (!entry.required) continue;
    if (configured.has(entry.personaId)) continue;
    if (entry.fallbackPersonaIds?.some((id) => configured.has(id))) continue;
    missing.push(entry.personaId);
  }

  return missing.length === 0
    ? { runnable: true }
    : { runnable: false, missingPersonaIds: missing };
}

/**
 * Resolve a preset's panel into concrete Participants ready to hand to
 * `ConsensusEngine.run`. Returns an Error (rather than throwing) so call-site
 * code can convert it into an MCP tool-error response with no stack noise.
 *
 * Resolution rules:
 *   • For each panel entry, prefer `personaId`; fall through to `fallbackPersonaIds` in order.
 *   • A configured persona can satisfy at most one panel entry per run — if a
 *     fallback would land on a persona already used by an earlier entry, skip it.
 *   • Required entries that can't resolve produce a descriptive error.
 *   • Optional entries that can't resolve are silently dropped.
 *   • The resulting panel must contain at least 2 participants (engine minimum).
 */
export function resolvePresetPanel(preset: Preset, config: LoadedConfig): ResolvedPanel | Error {
  const byPersonaId = new Map<string, ConfiguredEntry>();
  for (const cp of config.participants) {
    // First-wins: if a user configured two participants sharing the same
    // personaId (unusual), the first one anchors that persona slot.
    if (!byPersonaId.has(cp.persona.id)) {
      const providerId = config.providerByParticipant[cp.id];
      if (!providerId) {
        return new Error(`internal: configured participant "${cp.id}" has no provider mapping.`);
      }
      byPersonaId.set(cp.persona.id, { participant: cp, providerId });
    }
  }

  const participants: Participant[] = [];
  const providerByParticipant: Record<string, string> = {};
  const usedPersonaIds = new Set<string>();

  for (const entry of preset.panel) {
    const candidates = [entry.personaId, ...(entry.fallbackPersonaIds ?? [])];
    const resolvedPersonaId = candidates.find(
      (id) => byPersonaId.has(id) && !usedPersonaIds.has(id),
    );

    if (resolvedPersonaId === undefined) {
      if (entry.required) {
        return new Error(
          buildMissingError(preset.id, entry.personaId, entry.fallbackPersonaIds, byPersonaId),
        );
      }
      continue;
    }

    const matched = byPersonaId.get(resolvedPersonaId);
    if (!matched) {
      // Defensive — already filtered for has().
      continue;
    }
    usedPersonaIds.add(resolvedPersonaId);

    const specialised: Persona = {
      ...matched.participant.persona,
      systemPrompt: appendTaskSuffix(
        matched.participant.persona.systemPrompt,
        entry.taskSystemSuffix,
      ),
    };

    const newParticipant: Participant = {
      id: matched.participant.id,
      modelId: matched.participant.modelId,
      persona: specialised,
      ...(matched.participant.label !== undefined ? { label: matched.participant.label } : {}),
    };

    participants.push(newParticipant);
    providerByParticipant[newParticipant.id] = matched.providerId;
  }

  if (participants.length < 2) {
    return new Error(
      `preset "${preset.id}" resolved to ${participants.length} participant(s); need at least 2. ` +
        `Available personas in your config: ${[...byPersonaId.keys()].join(", ") || "(none)"}.`,
    );
  }

  // Carry over the judge mapping if the user configured one.
  if (config.providerByParticipant["judge"] !== undefined) {
    providerByParticipant["judge"] = config.providerByParticipant["judge"];
  }

  return { participants, providerByParticipant };
}

function appendTaskSuffix(base: string, suffix: string): string {
  return `${base.trimEnd()}\n\n${suffix.trimStart()}`;
}

function buildMissingError(
  presetId: string,
  primary: string,
  fallbacks: readonly string[] | undefined,
  byPersonaId: Map<string, ConfiguredEntry>,
): string {
  const requested =
    fallbacks && fallbacks.length > 0 ? `${primary} (or ${fallbacks.join(", ")})` : primary;
  const available = [...byPersonaId.keys()].join(", ") || "(none)";
  return (
    `preset "${presetId}" requires personaId ${requested}, but none are configured. ` +
    `Available personas: ${available}. ` +
    `Add a participant with personaId "${primary}" to your config or pick a different preset.`
  );
}

interface ConfiguredEntry {
  participant: Participant;
  providerId: string;
}
