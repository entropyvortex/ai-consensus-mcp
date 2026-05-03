import { describe, expect, it } from "vitest";
import type { Persona } from "ai-consensus-core";
import { PERSONAS } from "../../personas.js";
import type { LoadedConfig } from "../../config.js";
import { checkRunnability, resolvePresetPanel } from "../resolve-panel.js";
import type { Preset } from "../types.js";

function persona(id: string): Persona {
  const p = PERSONAS.find((x) => x.id === id);
  if (!p) throw new Error(`test fixture missing persona "${id}"`);
  return p;
}

function makeConfig(personaIds: string[], hasJudge = false): LoadedConfig {
  const participants = personaIds.map((pid, i) => ({
    id: `p${i}`,
    modelId: `model-${pid}`,
    persona: persona(pid),
  }));
  const providerByParticipant = Object.fromEntries(participants.map((p) => [p.id, "test"]));
  if (hasJudge) providerByParticipant["judge"] = "test";
  return {
    sourcePath: "/fake",
    providers: {
      test: { id: "test", baseUrl: "https://test.local", apiKey: "k", extraHeaders: {} },
    },
    participants,
    providerByParticipant,
    hostSampleParticipants: {},
    judge: hasJudge
      ? {
          providerId: "test",
          modelId: "judge-m",
          temperature: undefined,
          maxOutputTokens: undefined,
        }
      : undefined,
    defaults: {
      maxRounds: 4,
      earlyStop: true,
      convergenceDelta: 3,
      disagreementThreshold: 20,
      blindFirstRound: true,
      randomizeOrder: true,
      participantTemperature: 0.7,
      maxOutputTokens: 1500,
      useJudge: hasJudge,
    },
  };
}

const TEST_PRESET: Preset = {
  id: "test_preset",
  toolName: "consensus_test_preset",
  title: "T",
  description: "D",
  panel: [
    { personaId: "pessimist", required: true, taskSystemSuffix: "RISK_TASK" },
    { personaId: "domain-expert", required: true, taskSystemSuffix: "DOMAIN_TASK" },
    {
      personaId: "vc-specialist",
      required: false,
      fallbackPersonaIds: ["optimistic-futurist"],
      taskSystemSuffix: "VC_TASK",
    },
    { personaId: "first-principles", required: false, taskSystemSuffix: "FP_TASK" },
  ],
  defaults: { maxRounds: 3 },
};

describe("checkRunnability", () => {
  it("reports runnable=true when all required personas are configured", () => {
    const config = makeConfig(["pessimist", "domain-expert"]);
    expect(checkRunnability(TEST_PRESET, config)).toEqual({ runnable: true });
  });

  it("ignores optional missing personas", () => {
    const config = makeConfig(["pessimist", "domain-expert"]);
    expect(checkRunnability(TEST_PRESET, config)).toEqual({ runnable: true });
    // vc-specialist is optional, first-principles is optional — both missing OK.
  });

  it("reports missing required personas with their canonical id", () => {
    const config = makeConfig(["pessimist", "vc-specialist"]);
    const result = checkRunnability(TEST_PRESET, config);
    expect(result.runnable).toBe(false);
    if (result.runnable === false) {
      expect(result.missingPersonaIds).toContain("domain-expert");
      expect(result.missingPersonaIds).not.toContain("pessimist");
    }
  });

  it("counts a configured fallback as satisfying the entry", () => {
    const ALT_PRESET: Preset = {
      ...TEST_PRESET,
      panel: [
        ...TEST_PRESET.panel.slice(0, 2),
        {
          personaId: "vc-specialist",
          required: true,
          fallbackPersonaIds: ["optimistic-futurist"],
          taskSystemSuffix: "X",
        },
      ],
    };
    const config = makeConfig(["pessimist", "domain-expert", "optimistic-futurist"]);
    expect(checkRunnability(ALT_PRESET, config)).toEqual({ runnable: true });
  });
});

describe("resolvePresetPanel", () => {
  it("returns participants with task-suffixed system prompts", () => {
    const config = makeConfig(["pessimist", "domain-expert"]);
    const result = resolvePresetPanel(TEST_PRESET, config);
    if (result instanceof Error) throw result;
    expect(result.participants).toHaveLength(2);
    const risk = result.participants.find((p) => p.persona.id === "pessimist");
    expect(risk).toBeDefined();
    expect(risk?.persona.systemPrompt).toContain("RISK_TASK");
    expect(risk?.persona.systemPrompt).toContain("Risk Analyst"); // base persona prompt preserved
  });

  it("does not mutate the global PERSONAS table", () => {
    const before = PERSONAS.find((p) => p.id === "pessimist")!.systemPrompt;
    const config = makeConfig(["pessimist", "domain-expert"]);
    const result = resolvePresetPanel(TEST_PRESET, config);
    if (result instanceof Error) throw result;
    const after = PERSONAS.find((p) => p.id === "pessimist")!.systemPrompt;
    expect(after).toBe(before);
  });

  it("returns Error when a required persona is missing", () => {
    const config = makeConfig(["pessimist", "vc-specialist"]); // missing domain-expert
    const result = resolvePresetPanel(TEST_PRESET, config);
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toMatch(/domain-expert/);
      expect(result.message).toMatch(/Available personas/);
    }
  });

  it("uses fallbackPersonaIds when the primary persona isn't configured", () => {
    const config = makeConfig([
      "pessimist",
      "domain-expert",
      "optimistic-futurist", // fallback for vc-specialist in TEST_PRESET
    ]);
    const result = resolvePresetPanel(TEST_PRESET, config);
    if (result instanceof Error) throw result;
    const futurist = result.participants.find((p) => p.persona.id === "optimistic-futurist");
    expect(futurist).toBeDefined();
    expect(futurist?.persona.systemPrompt).toContain("VC_TASK");
  });

  it("does not double-use a configured persona across panel slots via fallback", () => {
    // Construct a preset where the second entry's fallback could also resolve to the first.
    const COLLIDING_PRESET: Preset = {
      ...TEST_PRESET,
      panel: [
        { personaId: "pessimist", required: true, taskSystemSuffix: "FIRST" },
        {
          personaId: "vc-specialist",
          required: false,
          fallbackPersonaIds: ["pessimist"],
          taskSystemSuffix: "SECOND",
        },
      ],
    };
    const config = makeConfig(["pessimist", "domain-expert"]);
    const result = resolvePresetPanel(COLLIDING_PRESET, config);
    // Either it returns Error (only one participant after dedup → <2), or skips
    // the optional second entry. Both behaviours are acceptable and documented.
    // We assert: pessimist appears at most once.
    if (!(result instanceof Error)) {
      const pessimistCount = result.participants.filter((p) => p.persona.id === "pessimist").length;
      expect(pessimistCount).toBe(1);
    }
  });

  it("carries over the judge provider mapping when one is configured", () => {
    const config = makeConfig(["pessimist", "domain-expert"], true);
    const result = resolvePresetPanel(TEST_PRESET, config);
    if (result instanceof Error) throw result;
    expect(result.providerByParticipant["judge"]).toBe("test");
  });

  it("threads host-sample participants through panel resolution", () => {
    // Manually wire a config where one persona slot is filled by a host-sample
    // participant. The resolved panel must split routing: provider for the
    // provider-backed persona, host-sample for the other.
    const pessimistP = persona("pessimist");
    const domainP = persona("domain-expert");
    const config: LoadedConfig = {
      sourcePath: "/fake",
      providers: {
        test: { id: "test", baseUrl: "https://test.local", apiKey: "k", extraHeaders: {} },
      },
      participants: [
        { id: "p_pess", modelId: "model-pessimist", persona: pessimistP },
        { id: "p_self", modelId: "host-sample", persona: domainP },
      ],
      providerByParticipant: { p_pess: "test" },
      hostSampleParticipants: { p_self: { modelHint: undefined } },
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
    const result = resolvePresetPanel(TEST_PRESET, config);
    if (result instanceof Error) throw result;
    expect(result.providerByParticipant["p_pess"]).toBe("test");
    expect(result.providerByParticipant["p_self"]).toBeUndefined();
    expect(result.hostSampleParticipants["p_self"]).toBeDefined();
    expect(result.hostSampleParticipants["p_pess"]).toBeUndefined();
    // Task suffix still applied — host-sample participants honour the preset's
    // persona specialisation just like provider-backed ones.
    const self = result.participants.find((p) => p.id === "p_self");
    expect(self?.persona.systemPrompt).toContain("DOMAIN_TASK");
  });

  it("returns Error when fewer than 2 participants resolve", () => {
    const SOLO_PRESET: Preset = {
      ...TEST_PRESET,
      panel: [
        { personaId: "pessimist", required: true, taskSystemSuffix: "X" },
        { personaId: "vc-specialist", required: false, taskSystemSuffix: "Y" },
      ],
    };
    const config = makeConfig(["pessimist"]); // only one persona configured, vc-specialist optional and absent
    const result = resolvePresetPanel(SOLO_PRESET, config);
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toMatch(/need at least 2/);
    }
  });
});
