// ─────────────────────────────────────────────────────────────
// Preset result formatter
// ─────────────────────────────────────────────────────────────
// The generic `consensus` tool's summary leads with the score table.
// For presets the structured task output is the judge synthesis, so
// preset summaries lead with that, then panel responses, then the
// score table at the bottom for "show your work."
//
// Individual presets can override via `Preset.formatResult`. Phase 1
// ships with no preset overriding the default — every preset uses
// `defaultPresetFormatter` here. Per-preset formatters can be added
// when a preset needs a structurally different summary (e.g. a future
// `consensus_test_generation` that emits runnable test code blocks).

import type { ConsensusResult } from "ai-consensus-core";
import type { Preset, PresetCallInput } from "./types.js";

/**
 * Format a consensus result for a preset's tool response. Delegates to
 * `Preset.formatResult` if one is defined; otherwise uses the default.
 */
export function formatPresetResult(
  preset: Preset,
  result: ConsensusResult,
  input: PresetCallInput,
): string {
  if (preset.formatResult) return preset.formatResult(result, input);
  return defaultPresetFormatter(preset, result);
}

function defaultPresetFormatter(preset: Preset, result: ConsensusResult): string {
  const lines: string[] = [];

  lines.push(`# ${preset.title}`);
  lines.push("");
  lines.push(`**Question:** ${result.question}`);
  lines.push(
    `**Final score:** ${result.finalScore} (avg=${result.finalAverageConfidence.toFixed(
      1,
    )}, σ=${result.finalStddev.toFixed(1)}) • ` +
      `**Rounds:** ${result.roundsCompleted} • ` +
      `**Stop reason:** ${result.stopReason} • ` +
      `**Duration:** ${(result.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push("");

  // Lead with the judge synthesis — that's the structured task output for a
  // preset run. If the judge wasn't enabled, fall back to a human-readable
  // pointer so users know what's missing without digging into structuredContent.
  if (result.synthesis) {
    lines.push(`## ${preset.title} — synthesis`);
    lines.push("");
    lines.push(result.synthesis.content.trim());
    lines.push("");
    lines.push(
      `_Judge model: ${result.synthesis.modelId}, self-reported confidence: ${result.synthesis.judgeConfidence}_`,
    );
    lines.push("");
    lines.push("---");
    lines.push("");
  } else {
    lines.push(
      "_(No judge synthesis — enable the judge in your config or pass `judge: true` for a synthesised output. Raw panel responses follow.)_",
    );
    lines.push("");
  }

  // Final-round panel responses — the substance behind the synthesis.
  const lastRound = result.rounds[result.rounds.length - 1];
  if (lastRound) {
    lines.push("## Panel responses (final round)");
    lines.push("");
    for (const resp of lastRound.responses) {
      const participant = result.participants.find((p) => p.id === resp.participantId);
      const personaName = participant?.persona.name ?? resp.participantId;
      const tag = resp.error ? `ERROR: ${resp.error}` : `confidence ${resp.confidence}`;
      lines.push(`### ${personaName} (${resp.modelId}) — ${tag}`);
      lines.push("");
      lines.push(resp.content.trim());
      lines.push("");
    }
  }

  // Score progression at the bottom — "show your work" for users who care.
  if (result.rounds.length > 0) {
    lines.push("## Score progression");
    lines.push("");
    lines.push("| Round | Phase | Label | Score | Avg | σ | Disagreements |");
    lines.push("| ----- | ----- | ----- | ----- | --- | - | ------------- |");
    for (const r of result.rounds) {
      lines.push(
        `| ${r.round} | ${r.phase} | ${r.label} | ${r.score} | ${r.averageConfidence.toFixed(1)} | ${r.stddev.toFixed(1)} | ${r.disagreements.length} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
