import { describe, expect, it } from "vitest";
import { createRegistry, mergePresets, validatePresets, type PresetOverride } from "../registry.js";
import type { Preset } from "../types.js";

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "demo",
    toolName: "consensus_demo",
    title: "Demo preset",
    description: "A preset used only by tests.",
    panel: [
      { personaId: "alpha", required: true, taskSystemSuffix: "task: alpha" },
      { personaId: "beta", required: false, taskSystemSuffix: "task: beta" },
    ],
    defaults: { maxRounds: 2 },
    ...overrides,
  };
}

describe("validatePresets", () => {
  it("accepts a well-formed preset", () => {
    expect(() => validatePresets([makePreset()])).not.toThrow();
  });

  it("rejects non-snake_case ids", () => {
    expect(() => validatePresets([makePreset({ id: "Demo-Preset" })])).toThrow(
      /must match.*snake_case/i,
    );
  });

  it("rejects toolName that doesn't match `consensus_${id}`", () => {
    expect(() =>
      validatePresets([makePreset({ id: "demo", toolName: "consensus_other" })]),
    ).toThrow(/must equal "consensus_demo"/);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      validatePresets([
        makePreset({ id: "demo" }),
        makePreset({ id: "demo", toolName: "consensus_demo" }),
      ]),
    ).toThrow(/duplicate preset id "demo"/);
  });

  it("rejects empty title", () => {
    expect(() => validatePresets([makePreset({ title: "" })])).toThrow(/non-empty title/);
  });

  it("rejects empty description", () => {
    expect(() => validatePresets([makePreset({ description: "" })])).toThrow(
      /non-empty description/,
    );
  });

  it("rejects panel with fewer than 2 entries", () => {
    expect(() =>
      validatePresets([
        makePreset({
          panel: [{ personaId: "alpha", required: true, taskSystemSuffix: "task" }],
        }),
      ]),
    ).toThrow(/at least 2 entries/);
  });

  it("rejects duplicate personaIds within a panel", () => {
    expect(() =>
      validatePresets([
        makePreset({
          panel: [
            { personaId: "alpha", required: true, taskSystemSuffix: "a" },
            { personaId: "alpha", required: false, taskSystemSuffix: "b" },
          ],
        }),
      ]),
    ).toThrow(/lists personaId "alpha" more than once/);
  });

  it("rejects empty taskSystemSuffix", () => {
    expect(() =>
      validatePresets([
        makePreset({
          panel: [
            { personaId: "alpha", required: true, taskSystemSuffix: "" },
            { personaId: "beta", required: false, taskSystemSuffix: "ok" },
          ],
        }),
      ]),
    ).toThrow(/empty taskSystemSuffix/);
  });
});

describe("createRegistry", () => {
  it("exposes list, get, byToolName lookups", () => {
    const reg = createRegistry([makePreset()]);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get("demo")?.id).toBe("demo");
    expect(reg.get("nope")).toBeUndefined();
    expect(reg.byToolName("consensus_demo")?.id).toBe("demo");
    expect(reg.byToolName("consensus_nope")).toBeUndefined();
  });

  it("validates on construction (rejects bad shapes loudly)", () => {
    expect(() => createRegistry([makePreset({ id: "BAD" })])).toThrow();
  });
});

describe("mergePresets", () => {
  const base = makePreset({
    id: "demo",
    title: "Demo preset",
    defaults: { maxRounds: 4, participantTemperature: 0.5 },
    judgeSystemPrompt: "default judge",
  });

  it("returns the built-in slate untouched when no overrides given", () => {
    const merged = mergePresets([base], undefined, undefined);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(base); // reference-equal — no churn
  });

  it("replaces scalar fields when overridden", () => {
    const overrides: Record<string, PresetOverride> = {
      demo: { title: "User title", judgeSystemPrompt: "user judge" },
    };
    const merged = mergePresets([base], overrides, undefined);
    expect(merged[0]?.title).toBe("User title");
    expect(merged[0]?.judgeSystemPrompt).toBe("user judge");
    // Untouched fields preserved
    expect(merged[0]?.description).toBe(base.description);
  });

  it("shallow-merges defaults so users can tweak one knob", () => {
    const merged = mergePresets([base], { demo: { defaults: { maxRounds: 7 } } }, undefined);
    expect(merged[0]?.defaults.maxRounds).toBe(7);
    expect(merged[0]?.defaults.participantTemperature).toBe(0.5); // preserved
  });

  it("replaces panel entirely when overridden (no deep merging)", () => {
    const newPanel = [
      { personaId: "x", required: true, taskSystemSuffix: "x" },
      { personaId: "y", required: true, taskSystemSuffix: "y" },
    ] as const;
    const merged = mergePresets([base], { demo: { panel: newPanel } }, undefined);
    expect(merged[0]?.panel).toEqual(newPanel);
  });

  it("appends user-supplied new presets", () => {
    const extra = makePreset({ id: "extra", toolName: "consensus_extra" });
    const merged = mergePresets([base], undefined, [extra]);
    expect(merged).toHaveLength(2);
    expect(merged[1]?.id).toBe("extra");
  });

  it("does not mutate the original built-in slate", () => {
    const originalDefaults = { ...base.defaults };
    mergePresets([base], { demo: { defaults: { maxRounds: 99 } } }, undefined);
    expect(base.defaults).toEqual(originalDefaults);
  });
});
