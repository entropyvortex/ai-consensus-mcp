import { describe, expect, it, vi } from "vitest";
import {
  benchProviderCallEstimate,
  benchSubscriptionWarning,
  formatBenchCallEstimate,
  runBench,
} from "../bench.js";

describe("bench provider-call estimate", () => {
  it("counts participants × maxRounds + judge + baseline + rubricCalls", () => {
    const estimate = benchProviderCallEstimate({
      cases: 4,
      runs: 3,
      participants: 3,
      maxRounds: 4,
      judge: 1,
      rubricCalls: 2,
    });
    // 3×4 + 1 judge + 1 baseline + 2 rubric = 16 per run; 4×3×16 = 192
    expect(estimate.total).toBe(192);
    expect(estimate.explainer).toBe(
      "cases × runs × ((participants × maxRounds + judge) + baseline + rubricCalls)",
    );
  });

  it("drops the judge and rubric terms when they are absent", () => {
    const estimate = benchProviderCallEstimate({
      cases: 1,
      runs: 1,
      participants: 3,
      maxRounds: 2,
      judge: 0,
      rubricCalls: 0,
    });
    expect(estimate.total).toBe(3 * 2 + 1);
  });

  it("adds the subscription warning only when a counted provider is cli", () => {
    const http = { openai: { transport: "http" }, anthropic: { transport: "http" } };
    expect(benchSubscriptionWarning(http, ["openai", "anthropic"])).toBe("");

    const mixed = { ...http, "grok-sub": { transport: "cli" } };
    const warning = benchSubscriptionWarning(mixed, ["openai", "grok-sub"]);
    expect(warning).toContain("subscription warning");
    expect(warning).toContain("does not refuse to run");
    expect(warning).toContain("does not require a CLI");
    expect(benchSubscriptionWarning(mixed, ["openai", "anthropic"])).toBe("");
  });

  it("uses panel maxRounds, then config, then 4, and warns only for a counted CLI provider", () => {
    const providers = {
      openai: { transport: "http" },
      "grok-sub": { transport: "cli" },
    };
    const httpOnly = formatBenchCallEstimate({
      cases: 2,
      runs: 1,
      participants: 3,
      panelMaxRounds: undefined,
      configMaxRounds: 2,
      judgeCalls: 1,
      rubricCalls: 0,
      providers: { openai: { transport: "http" } },
      participantProviderIds: ["openai", undefined],
      judgeProviderId: "openai",
      baselineProviderId: "openai",
      evaluatorProviderId: undefined,
    });
    // config maxRounds 2: 3×2 + 1 judge + 1 baseline = 8, times 2 cases
    expect(httpOnly).toContain("expected ≈16 provider calls");
    expect(httpOnly).toContain("Upper bound when early-stop fires");
    expect(httpOnly).not.toContain("subscription warning");

    const cliJudge = formatBenchCallEstimate({
      cases: 1,
      runs: 1,
      participants: 2,
      panelMaxRounds: 4,
      configMaxRounds: 2,
      judgeCalls: 1,
      rubricCalls: 2,
      providers,
      participantProviderIds: ["openai", "openai"],
      judgeProviderId: "grok-sub",
      baselineProviderId: "openai",
      evaluatorProviderId: "openai",
    });
    // panel maxRounds 4 wins over config 2: 2×4 + 1 + 1 + 2 = 12
    expect(cliJudge).toContain("expected ≈12 provider calls");
    expect(cliJudge).toContain("subscription warning");

    const cliIgnoredWhenJudgeOff = formatBenchCallEstimate({
      cases: 1,
      runs: 1,
      participants: 1,
      panelMaxRounds: undefined,
      configMaxRounds: undefined,
      judgeCalls: 0,
      rubricCalls: 0,
      providers,
      participantProviderIds: ["openai"],
      judgeProviderId: "grok-sub",
      baselineProviderId: "openai",
      evaluatorProviderId: "grok-sub",
    });
    // default maxRounds 4: 1×4 + 0 + 1 = 5. Judge and rubric CLI ids are not counted.
    expect(cliIgnoredWhenJudgeOff).toContain("expected ≈5 provider calls");
    expect(cliIgnoredWhenJudgeOff).not.toContain("subscription warning");
  });

  it("help text states the estimate and that a CLI is not required", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(await runBench(["--help"])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const help = writes.join("");
    expect(help).toMatch(
      /cases × runs × \(\(participants × maxRounds \+ judge\) \+ baseline \+\s+rubricCalls\)/,
    );
    expect(help).toMatch(/upper bound when early-stop fires/i);
    expect(help).toContain("not required");
    expect(help).toMatch(/does not\s+refuse to run/);
    expect(help).toMatch(/--quick does not skip a CLI\s+seat/);
  });
});
