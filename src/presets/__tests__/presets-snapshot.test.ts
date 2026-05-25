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
    memory: { enabled: false, storageRoot: "/tmp/test-memory", maxResults: 1000, maxAgeDays: 365, raw: undefined },
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

  it("ships the five v1 presets (kept for backward compatibility)", () => {
    const ids = new Set(BUILT_IN_PRESETS.map((p) => p.id));
    // v1 — original five
    expect(ids.has("architecture_debate")).toBe(true);
    expect(ids.has("code_review")).toBe(true);
    expect(ids.has("debug_postmortem")).toBe(true);
    expect(ids.has("decision_making")).toBe(true);
    expect(ids.has("research_synthesis")).toBe(true);
  });

  it("ships the eight v2 expert panels promised by v0.12", () => {
    const ids = new Set(BUILT_IN_PRESETS.map((p) => p.id));
    // v2 — upgrades of the four v1 presets that warranted iteration
    expect(ids.has("architecture_v2")).toBe(true);
    expect(ids.has("code_review_v2")).toBe(true);
    expect(ids.has("research_synthesis_v2")).toBe(true);
    expect(ids.has("decision_making_v2")).toBe(true);
    expect(ids.has("incident_postmortem_v2")).toBe(true);
    // v2 — three brand-new panels
    expect(ids.has("security_redteam")).toBe(true);
    expect(ids.has("ml_research_2026")).toBe(true);
    expect(ids.has("product_strategy")).toBe(true);
  });

  it("every v2 panel declares full meta (version, rationale, expectedOutputShape)", () => {
    const v2Ids = new Set([
      "architecture_v2",
      "code_review_v2",
      "research_synthesis_v2",
      "decision_making_v2",
      "incident_postmortem_v2",
      "security_redteam",
      "ml_research_2026",
      "product_strategy",
    ]);
    for (const preset of BUILT_IN_PRESETS) {
      if (!v2Ids.has(preset.id)) continue;
      expect(preset.meta, `preset ${preset.id} meta`).toBeDefined();
      expect(preset.meta?.version, `${preset.id} version`).toMatch(/^\d+\.\d+\.\d+/);
      expect(preset.meta?.rationale, `${preset.id} rationale`).toBeTruthy();
      expect(preset.meta?.expectedOutputShape?.sections.length, `${preset.id} sections`).toBeGreaterThan(0);
      expect(preset.meta?.tags?.length, `${preset.id} tags`).toBeGreaterThan(0);
    }
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
