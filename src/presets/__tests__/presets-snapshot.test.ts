// Golden-snapshot tests for the built-in preset slate.
//
// What these lock down: the *resolved* shape of each preset against a
// fully-populated config — every persona present — so a careless edit to a
// persona base prompt or to a preset's task suffix surfaces as a snapshot
// diff. Reviewers see exactly which prompts changed.
//
// To intentionally update a preset prompt: run `npm test -- -u`. Read the
// diff carefully — operator-visible behaviour is changing.

import { describe, expect, it } from "vitest";
import { PERSONAS } from "../../personas.js";
import type { LoadedConfig } from "../../config.js";
import { BUILT_IN_PRESETS } from "../definitions/index.js";
import { createRegistry } from "../registry.js";
import { resolvePresetPanel, checkRunnability } from "../resolve-panel.js";
import { buildPresetJsonSchema } from "../build-input-schema.js";

function makeFullConfig(): LoadedConfig {
  const participants = PERSONAS.map((p, i) => ({
    id: `p_${p.id}`,
    modelId: `model-${i}`,
    persona: p,
  }));
  const providerByParticipant = Object.fromEntries(participants.map((p) => [p.id, "test"]));
  return {
    sourcePath: "/fake",
    providers: {
      test: { id: "test", baseUrl: "https://test.local", apiKey: "k", extraHeaders: {} },
    },
    participants,
    providerByParticipant,
    hostSampleParticipants: {},
    judge: undefined,
    defaults: {
      maxRounds: 4,
      earlyStop: true,
      convergenceDelta: 3,
      disagreementThreshold: 20,
      blindFirstRound: true,
      randomizeOrder: true,
      participantTemperature: 0.7,
      maxOutputTokens: 1500,
      useJudge: false,
    },
  };
}

describe("BUILT_IN_PRESETS — structural invariants", () => {
  it("registers without errors (validatePresets is happy)", () => {
    expect(() => createRegistry(BUILT_IN_PRESETS)).not.toThrow();
  });

  it("ships exactly the five v1 presets the plan promised", () => {
    const ids = BUILT_IN_PRESETS.map((p) => p.id).sort();
    expect(ids).toEqual([
      "architecture_debate",
      "code_review",
      "debug_postmortem",
      "decision_making",
      "research_synthesis",
    ]);
  });

  it("each preset is runnable when the user has configured every persona", () => {
    const config = makeFullConfig();
    for (const preset of BUILT_IN_PRESETS) {
      const r = checkRunnability(preset, config);
      expect(r, `preset ${preset.id}`).toEqual({ runnable: true });
    }
  });

  it("each preset's input JSON Schema is valid MCP tool shape", () => {
    for (const preset of BUILT_IN_PRESETS) {
      const schema = buildPresetJsonSchema(preset);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toContain("prompt");
      expect((schema.properties as Record<string, unknown>).prompt).toBeDefined();
    }
  });
});

describe("BUILT_IN_PRESETS — resolved-prompt snapshots", () => {
  // The snapshot we lock is the per-preset, per-panel-seat composition of
  // (persona base prompt + "\n\n" + taskSystemSuffix). If a base persona
  // prompt drifts, every preset's snapshot diffs — which is exactly the
  // signal we want.
  it.each(BUILT_IN_PRESETS.map((p) => [p.id, p] as const))(
    "preset %s resolved prompts match snapshot",
    (_id, preset) => {
      const config = makeFullConfig();
      const resolved = resolvePresetPanel(preset, config);
      if (resolved instanceof Error) throw resolved;

      const summary = resolved.participants.map((p) => ({
        id: p.id,
        modelId: p.modelId,
        personaId: p.persona.id,
        systemPrompt: p.persona.systemPrompt,
      }));

      expect(summary).toMatchSnapshot();
    },
  );

  it("preset metadata (defaults, judge prompt) match snapshot", () => {
    const meta = BUILT_IN_PRESETS.map((p) => ({
      id: p.id,
      toolName: p.toolName,
      title: p.title,
      defaults: p.defaults,
      judgeSystemPrompt: p.judgeSystemPrompt,
    }));
    expect(meta).toMatchSnapshot();
  });
});
