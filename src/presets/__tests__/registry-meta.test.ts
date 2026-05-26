// Contract tests for `PanelMeta` validation in the preset registry.
//
// What these lock down: validatePresets rejects ill-formed `meta` so v2
// panels that ship to MCP clients are always well-formed. Each `expect.toThrow`
// asserts a specific invariant — semver shape, non-empty rationale, non-empty
// sections, unique headings, no empty tags. R6: tests encode contracts.

import { describe, expect, it } from "vitest";
import { createRegistry, validatePresets } from "../registry.js";
import type { Preset } from "../types.js";

function basePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "test_panel",
    toolName: "consensus_test_panel",
    title: "Test panel",
    description: "Test description.",
    panel: [
      { personaId: "pessimist", required: true, taskSystemSuffix: "do stuff" },
      { personaId: "first-principles", required: true, taskSystemSuffix: "more stuff" },
    ],
    defaults: { maxRounds: 3 },
    ...overrides,
  };
}

describe("PanelMeta validation — happy paths", () => {
  it("accepts a preset with no meta at all (v1 backward compat)", () => {
    expect(() => validatePresets([basePreset()])).not.toThrow();
  });

  it("accepts a fully-populated meta", () => {
    const preset = basePreset({
      meta: {
        version: "2.0.0",
        rationale: "Improves over v1 by …",
        expectedOutputShape: {
          sections: [
            { heading: "Summary", description: "What broke." },
            { heading: "Root cause", description: "Mechanism." },
          ],
          tags: ["HIGH", "LOW"],
        },
        tags: ["v2", "ops"],
      },
    });
    expect(() => validatePresets([preset])).not.toThrow();
  });

  it("accepts a meta with only some fields set", () => {
    expect(() => validatePresets([basePreset({ meta: { version: "2.0.0" } })])).not.toThrow();
    expect(() =>
      validatePresets([basePreset({ meta: { rationale: "Why this exists." } })]),
    ).not.toThrow();
  });
});

describe("PanelMeta validation — version", () => {
  it("rejects non-semver version", () => {
    const preset = basePreset({ meta: { version: "v2" } });
    expect(() => validatePresets([preset])).toThrow(/meta\.version/);
  });

  it("rejects empty version string", () => {
    const preset = basePreset({ meta: { version: "" } });
    expect(() => validatePresets([preset])).toThrow(/meta\.version/);
  });

  it("accepts semver with prerelease tag", () => {
    const preset = basePreset({ meta: { version: "2.0.0-rc.1" } });
    expect(() => validatePresets([preset])).not.toThrow();
  });
});

describe("PanelMeta validation — rationale", () => {
  it("rejects empty rationale", () => {
    const preset = basePreset({ meta: { rationale: "" } });
    expect(() => validatePresets([preset])).toThrow(/meta\.rationale/);
  });

  it("rejects whitespace-only rationale", () => {
    const preset = basePreset({ meta: { rationale: "   \n\t " } });
    expect(() => validatePresets([preset])).toThrow(/meta\.rationale/);
  });
});

describe("PanelMeta validation — expectedOutputShape", () => {
  it("rejects empty sections", () => {
    const preset = basePreset({
      meta: { expectedOutputShape: { sections: [] } },
    });
    expect(() => validatePresets([preset])).toThrow(/sections must be a non-empty array/);
  });

  it("rejects a section with empty heading", () => {
    const preset = basePreset({
      meta: {
        expectedOutputShape: {
          sections: [{ heading: "", description: "x" }],
        },
      },
    });
    expect(() => validatePresets([preset])).toThrow(/empty heading/);
  });

  it("rejects duplicate section headings", () => {
    const preset = basePreset({
      meta: {
        expectedOutputShape: {
          sections: [
            { heading: "Findings", description: "a" },
            { heading: "Findings", description: "b" },
          ],
        },
      },
    });
    expect(() => validatePresets([preset])).toThrow(/duplicate section heading/);
  });

  it("rejects a section with empty description", () => {
    const preset = basePreset({
      meta: {
        expectedOutputShape: {
          sections: [{ heading: "X", description: "" }],
        },
      },
    });
    expect(() => validatePresets([preset])).toThrow(/empty description/);
  });

  it("rejects empty tags array element", () => {
    const preset = basePreset({
      meta: {
        expectedOutputShape: {
          sections: [{ heading: "X", description: "y" }],
          tags: ["GOOD", ""],
        },
      },
    });
    expect(() => validatePresets([preset])).toThrow(/non-string or empty tag/);
  });
});

describe("PanelMeta validation — top-level tags", () => {
  it("rejects empty tag", () => {
    const preset = basePreset({ meta: { tags: ["valid", ""] } });
    expect(() => validatePresets([preset])).toThrow(/non-string or empty tag/);
  });

  it("accepts non-empty tag list", () => {
    const preset = basePreset({ meta: { tags: ["security", "v2"] } });
    expect(() => validatePresets([preset])).not.toThrow();
  });
});

describe("createRegistry — meta is preserved on the registered preset", () => {
  it("exposes meta on lookup", () => {
    const preset = basePreset({
      meta: { version: "2.0.0", rationale: "Test." },
    });
    const reg = createRegistry([preset]);
    const got = reg.get("test_panel");
    expect(got?.meta?.version).toBe("2.0.0");
    expect(got?.meta?.rationale).toBe("Test.");
  });
});
