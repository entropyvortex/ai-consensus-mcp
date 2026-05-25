// Contract test for built-in bench fixtures. The contract: every JSON file
// in src/benchmark/fixtures/ validates against BenchCaseFileSchema, and every
// case targets a real panel id (otherwise the fixture is dead-on-arrival).

import { describe, expect, it } from "vitest";
import { BUILT_IN_PRESETS } from "../../presets/definitions/index.js";
import {
  allBuiltInCases,
  builtInCasesForPanel,
  loadBuiltInFixtures,
} from "../fixtures.js";

describe("built-in fixtures — load + validate", () => {
  it("ships at least one fixture file", async () => {
    const loaded = await loadBuiltInFixtures();
    expect(loaded.length).toBeGreaterThan(0);
  });

  it("every fixture validates and has at least one case", async () => {
    const loaded = await loadBuiltInFixtures();
    for (const f of loaded) {
      expect(f.file.cases.length, `fixture ${f.name}`).toBeGreaterThan(0);
    }
  });

  it("every case in every fixture targets a real panel id (or omits one)", async () => {
    const validIds = new Set(BUILT_IN_PRESETS.map((p) => p.id));
    const cases = await allBuiltInCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      if (c.panelId !== undefined) {
        expect(validIds.has(c.panelId), `case ${c.id} → panel ${c.panelId}`).toBe(true);
      }
    }
  });

  it("ids are globally unique across all fixture files", async () => {
    const cases = await allBuiltInCases();
    const ids = new Set<string>();
    for (const c of cases) {
      expect(ids.has(c.id), `duplicate case id "${c.id}"`).toBe(false);
      ids.add(c.id);
    }
  });
});

describe("builtInCasesForPanel", () => {
  it("returns cases targeted at the panel plus untargeted cases", async () => {
    const cases = await builtInCasesForPanel("architecture_v2");
    // Every returned case has either no panelId or panelId === architecture_v2.
    for (const c of cases) {
      if (c.panelId !== undefined) {
        expect(c.panelId).toBe("architecture_v2");
      }
    }
  });

  it("returns an empty list when no built-in case targets the panel and there are no untargeted cases", async () => {
    // We don't ship cases for `ml_research_2026` yet; every shipped case names
    // a panelId — so this should be empty.
    const cases = await builtInCasesForPanel("ml_research_2026");
    expect(cases.every((c) => c.panelId === "ml_research_2026")).toBe(true);
  });
});
