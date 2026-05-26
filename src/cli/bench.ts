// ─────────────────────────────────────────────────────────────
// `bench` subcommand — measure panel uplift over a single-model baseline
// ─────────────────────────────────────────────────────────────
// Loads a config + a panel + (built-in or user-provided) cases and runs
// the full consensus protocol against a baseline single-model call for
// each (case, run) pair. Writes a markdown report to stdout and an
// optional JSON report to disk.
//
// IMPORTANT: real LLM calls flow through the user's configured providers.
// Bench is not free. The CLI surfaces total expected runs upfront so a
// caller doesn't accidentally fire a $100 batch.

import { writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { ConsensusOptions, ModelCaller } from "ai-consensus-core";
import { loadConfig, type LoadedConfig } from "../config.js";
import { createOpenAICompatibleCaller } from "../adapter.js";
import { BUILT_IN_PRESETS } from "../presets/definitions/index.js";
import { createRegistry, type PresetRegistry } from "../presets/registry.js";
import { resolvePresetPanel, checkRunnability } from "../presets/resolve-panel.js";
import type { Preset } from "../presets/types.js";
import { allBuiltInCases, builtInCasesForPanel } from "../benchmark/fixtures.js";
import { loadCaseFile } from "../benchmark/load.js";
import { runSuite, type BenchProgressEvent } from "../benchmark/runner.js";
import { formatReportJson, formatReportMarkdown } from "../benchmark/format.js";
import type { BenchCase } from "../benchmark/types.js";
import { SERVER_NAME } from "../version.js";

export interface BenchArgs {
  help: boolean;
  configPath: string | undefined;
  panelId: string | undefined;
  casesPath: string | undefined;
  runs: number;
  baseSeed: number | undefined;
  outputPath: string | undefined;
  baselineModelId: string | undefined;
  baselineProviderId: string | undefined;
  evaluatorModelId: string | undefined;
  evaluatorProviderId: string | undefined;
  filterTag: string | undefined;
  includeFullResults: boolean;
  listPanels: boolean;
  quiet: boolean;
  /**
   * Quick-sanity-check mode for power users. Forces a deterministic
   * single-case, single-run, seed=0 invocation against the first
   * built-in fixture matching the panel — minimum-cost confidence
   * check that the panel is wired correctly end-to-end.
   *
   * Explicit `--runs`, `--seed`, `--cases`, and `--filter-tag` still
   * win when both are passed (so a user can keep `--quick` for the
   * "limit to one case" semantics and override the rest).
   */
  quick: boolean;
}

/**
 * When `--quick` is on but the user didn't pin a seed, we use this
 * fixed seed so two `bench --quick` invocations in a row produce the
 * same shuffle/round order. Documented in the help text.
 */
const QUICK_DEFAULT_SEED = 0;

const BENCH_HELP = `
${SERVER_NAME} bench — measure panel uplift over a single-model baseline

Usage:
  ai-consensus-mcp bench --config <path> --panel <id> [--runs N]
  ai-consensus-mcp bench --config <path> --panel <id> --quick
  ai-consensus-mcp bench --config <path> --panel <id> --cases ./my-cases.json
  ai-consensus-mcp bench --list-panels

Required:
  -c, --config <path>          Path to consensus.config.json (providers + judge).
                               Defaults to $CONSENSUS_CONFIG.
  -p, --panel <id>             Panel id (e.g. architecture_v2). See --list-panels.

Optional:
      --cases <path>           JSON case file. Defaults to the built-in
                               fixtures filtered to the panel's family.
  -n, --runs <N>               Runs per case. Default: 1, max: 32.
      --seed <N>               Base random seed. Defaults to Date.now() (or 0
                               under --quick).
      --quick                  Quick mode: 1 case (the first built-in fixture
                               that matches the panel), 1 run, seed=0. The
                               cheapest end-to-end smoke check that the panel
                               is wired correctly. Explicit --runs / --seed /
                               --cases override the quick defaults.
      --baseline-model <id>    Model id for the single-model baseline.
                               Defaults to the judge model from config.
      --baseline-provider <id> Provider id for the baseline model.
                               Defaults to the judge provider from config.
      --evaluator-model <id>   Model id for a held-out rubric evaluator. When
                               set AND the panel declares a rubric, the bench
                               scores both consensus and baseline outputs
                               against that rubric. SHOULD differ from both
                               the judge model and the baseline model — the
                               evaluator grades both sides blind, and using
                               the same brain for grading and producing one
                               side biases the result. The CLI warns when
                               this contract is violated but does not block.
      --evaluator-provider <id> Provider id for the evaluator model. Required
                               when --evaluator-model is set.
      --filter-tag <tag>       Only run cases that have this tag.
      --output <path>          Also write the JSON report to this path.
      --include-full-results   Keep the full ConsensusResult objects in the
                               JSON output. Default omits them for diffability.
      --list-panels            Print available panels and exit.
  -q, --quiet                  Suppress per-run progress on stderr.
  -h, --help                   Show this help.

Bench loads providers from your config and runs real LLM calls. Cost is
proportional to (case_count × runs × (panel_size + 1)). Inspect the
estimate the CLI prints before confirming.

Determinism:
  Round-ordering and per-run RNG are seeded from --seed (defaults to
  Date.now()). Re-using the same seed reproduces the round/shuffle
  decisions. Model outputs at temperature > 0 are inherently stochastic —
  use --runs N to average over noise on real LLM calls.

Examples:
  # Smallest end-to-end check — one case, one run, deterministic seed
  ai-consensus-mcp bench -c ./consensus.config.json -p architecture_v2 --quick

  # Reproducible runs of the architecture panel with the built-in fixtures
  ai-consensus-mcp bench --config ./consensus.config.json \\
      --panel architecture_v2 --runs 3 --seed 42 --output report.json

  # Restrict to one tag and write JSON + markdown
  ai-consensus-mcp bench -c ./consensus.config.json -p security_redteam \\
      --filter-tag injection --output sec.json

  # Held-out rubric eval — consensus + baseline scored by a third model
  ai-consensus-mcp bench -p architecture_v2 --runs 3 --seed 42 \\
      --evaluator-model claude-opus-4-5 --evaluator-provider anthropic \\
      --output bench-rubric.json

  # Discover panels and their tags
  ai-consensus-mcp bench --list-panels

Environment:
  CONSENSUS_CONFIG             Default config path if --config is omitted.
  <PROVIDER_API_KEY>           Each provider's apiKeyEnv must be set.
`;

export function parseBenchArgs(argv: readonly string[]): BenchArgs | Error {
  const out: BenchArgs = {
    help: false,
    configPath: undefined,
    panelId: undefined,
    casesPath: undefined,
    runs: 1,
    baseSeed: undefined,
    outputPath: undefined,
    baselineModelId: undefined,
    baselineProviderId: undefined,
    evaluatorModelId: undefined,
    evaluatorProviderId: undefined,
    filterTag: undefined,
    includeFullResults: false,
    listPanels: false,
    quiet: false,
    quick: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string | Error => {
      const v = argv[i + 1];
      if (!v) return new Error(`Missing value for ${arg}`);
      i++;
      return v;
    };
    if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else if (arg === "--list-panels") {
      out.listPanels = true;
    } else if (arg === "-q" || arg === "--quiet") {
      out.quiet = true;
    } else if (arg === "--quick") {
      out.quick = true;
    } else if (arg === "--include-full-results") {
      out.includeFullResults = true;
    } else if (arg === "-c" || arg === "--config") {
      const v = next();
      if (v instanceof Error) return v;
      out.configPath = v;
    } else if (arg.startsWith("--config=")) {
      out.configPath = arg.slice("--config=".length);
    } else if (arg === "-p" || arg === "--panel") {
      const v = next();
      if (v instanceof Error) return v;
      out.panelId = v;
    } else if (arg.startsWith("--panel=")) {
      out.panelId = arg.slice("--panel=".length);
    } else if (arg === "--cases") {
      const v = next();
      if (v instanceof Error) return v;
      out.casesPath = v;
    } else if (arg.startsWith("--cases=")) {
      out.casesPath = arg.slice("--cases=".length);
    } else if (arg === "-n" || arg === "--runs") {
      const v = next();
      if (v instanceof Error) return v;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1)
        return new Error(`--runs expects a positive integer (got "${v}").`);
      out.runs = n;
    } else if (arg === "--seed") {
      const v = next();
      if (v instanceof Error) return v;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0)
        return new Error(`--seed expects a non-negative integer (got "${v}").`);
      out.baseSeed = n;
    } else if (arg === "--output") {
      const v = next();
      if (v instanceof Error) return v;
      out.outputPath = v;
    } else if (arg.startsWith("--output=")) {
      out.outputPath = arg.slice("--output=".length);
    } else if (arg === "--baseline-model") {
      const v = next();
      if (v instanceof Error) return v;
      out.baselineModelId = v;
    } else if (arg === "--baseline-provider") {
      const v = next();
      if (v instanceof Error) return v;
      out.baselineProviderId = v;
    } else if (arg === "--evaluator-model") {
      const v = next();
      if (v instanceof Error) return v;
      out.evaluatorModelId = v;
    } else if (arg === "--evaluator-provider") {
      const v = next();
      if (v instanceof Error) return v;
      out.evaluatorProviderId = v;
    } else if (arg === "--filter-tag") {
      const v = next();
      if (v instanceof Error) return v;
      out.filterTag = v;
    } else {
      return new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

export async function runBench(argv: readonly string[]): Promise<number> {
  const parsed = parseBenchArgs(argv);
  if (parsed instanceof Error) {
    process.stderr.write(`${SERVER_NAME} bench: ${parsed.message}\n${BENCH_HELP}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stderr.write(`${BENCH_HELP}\n`);
    return 0;
  }
  if (parsed.listPanels) {
    process.stdout.write(`${formatPanelList()}\n`);
    return 0;
  }

  const configPath = parsed.configPath ?? process.env["CONSENSUS_CONFIG"];
  if (!configPath) {
    process.stderr.write(
      `${SERVER_NAME} bench: --config <path> is required (or set $CONSENSUS_CONFIG).\n`,
    );
    return 2;
  }
  if (!parsed.panelId) {
    process.stderr.write(
      `${SERVER_NAME} bench: --panel <id> is required. Run \`--list-panels\` to see options.\n`,
    );
    return 2;
  }

  let config: LoadedConfig;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    process.stderr.write(
      `${SERVER_NAME} bench: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const registry: PresetRegistry = createRegistry(BUILT_IN_PRESETS);
  const panel = registry.get(parsed.panelId);
  if (!panel) {
    process.stderr.write(
      `${SERVER_NAME} bench: unknown panel "${parsed.panelId}".\n${formatPanelList()}\n`,
    );
    return 2;
  }



  const runnability = checkRunnability(panel, config);
  if (!runnability.runnable) {
    process.stderr.write(
      `${SERVER_NAME} bench: panel "${panel.id}" is not runnable with the current config. Missing personas: ${runnability.missingPersonaIds.join(", ")}.\n`,
    );
    return 2;
  }

  const resolved = resolvePresetPanel(panel, config);
  if (resolved instanceof Error) {
    process.stderr.write(`${SERVER_NAME} bench: ${resolved.message}\n`);
    return 2;
  }

  // Pick the baseline model. Explicit --baseline-model wins; otherwise the
  // judge model is the most-defensible default ("if you just asked the
  // most-capable model in the config, how would it answer?").
  const baselineModelId =
    parsed.baselineModelId ?? (config.judge ? config.judge.modelId : undefined);
  const baselineProviderId =
    parsed.baselineProviderId ?? (config.judge ? config.judge.providerId : undefined);
  if (!baselineModelId || !baselineProviderId) {
    process.stderr.write(
      `${SERVER_NAME} bench: no baseline model — pass --baseline-model + --baseline-provider, or configure a judge in your consensus.config.json.\n`,
    );
    return 2;
  }
  if (!config.providers[baselineProviderId]) {
    process.stderr.write(
      `${SERVER_NAME} bench: baseline provider "${baselineProviderId}" is not in your config (available: ${Object.keys(
        config.providers,
      ).join(", ")}).\n`,
    );
    return 2;
  }

  // Evaluator routing — required if --evaluator-model is set. Validated
  // BEFORE we start running so we fail fast on a typo'd provider id rather
  // than dozens of provider calls in.
  let evaluatorModelId: string | undefined;
  let evaluatorProviderId: string | undefined;
  if (parsed.evaluatorModelId || parsed.evaluatorProviderId) {
    if (!parsed.evaluatorModelId || !parsed.evaluatorProviderId) {
      process.stderr.write(
        `${SERVER_NAME} bench: --evaluator-model and --evaluator-provider must be passed together.\n`,
      );
      return 2;
    }
    if (!config.providers[parsed.evaluatorProviderId]) {
      process.stderr.write(
        `${SERVER_NAME} bench: evaluator provider "${parsed.evaluatorProviderId}" is not in your config (available: ${Object.keys(
          config.providers,
        ).join(", ")}).\n`,
      );
      return 2;
    }
    evaluatorModelId = parsed.evaluatorModelId;
    evaluatorProviderId = parsed.evaluatorProviderId;
    if (!panel.rubric || panel.rubric.length === 0) {
      process.stderr.write(
        `${SERVER_NAME} bench: panel "${panel.id}" declares no rubric; --evaluator-model has nothing to score. Ignoring.\n`,
      );
      evaluatorModelId = undefined;
      evaluatorProviderId = undefined;
    }
  }

  // Compose the per-call routing: panel participants → their providers,
  // plus the synthetic "baseline", "judge", and "rubric-evaluator" ids.
  const providerByParticipant: Record<string, string> = {
    ...resolved.providerByParticipant,
    baseline: baselineProviderId,
  };
  if (config.judge) {
    providerByParticipant["judge"] = config.judge.providerId;
  }
  if (evaluatorProviderId) {
    providerByParticipant["rubric-evaluator"] = evaluatorProviderId;
  }
  const caller: ModelCaller = createOpenAICompatibleCaller({
    providers: config.providers,
    providerByParticipant,
  });

  // Held-out contract warnings — the bench will still run, but a reviewer
  // reading the report needs to see "this comparison wasn't blind."
  if (evaluatorModelId) {
    if (evaluatorModelId === baselineModelId) {
      process.stderr.write(
        `${SERVER_NAME} bench: ⚠ evaluator model == baseline model (${evaluatorModelId}). The evaluator is grading its own output. Results on the baseline side are NOT independent.\n`,
      );
    }
    if (evaluatorModelId === config.judge?.modelId) {
      process.stderr.write(
        `${SERVER_NAME} bench: ⚠ evaluator model == judge model (${evaluatorModelId}). The evaluator is grading text synthesised by the same brain that produced the consensus output — eval is not held-out.\n`,
      );
    }
  }
  if (
    baselineModelId === config.judge?.modelId &&
    (!evaluatorModelId || evaluatorModelId === baselineModelId)
  ) {
    process.stderr.write(
      `${SERVER_NAME} bench: ⚠ baseline and judge are the same model (${baselineModelId}). Consensus and baseline both flow through this brain; "consensus vs baseline" is a self-comparison artifact.\n`,
    );
  }

  // Load cases.
  let cases: BenchCase[];
  let caseFileName: string | undefined;
  if (parsed.casesPath) {
    let loaded;
    try {
      loaded = await loadCaseFile(parsed.casesPath);
    } catch (err) {
      process.stderr.write(
        `${SERVER_NAME} bench: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
    cases = loaded.file.cases.slice();
    caseFileName = loaded.sourcePath;
  } else {
    // No case file given — pull built-in fixtures filtered to the panel.
    // Cases without a panelId match any panel; cases with one must match.
    try {
      cases = await builtInCasesForPanel(panel.id);
    } catch (err) {
      process.stderr.write(
        `${SERVER_NAME} bench: failed to load built-in fixtures: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return 2;
    }
    if (cases.length === 0) {
      // Nothing pinned to this panel — fall back to all cases (let the panel
      // be applied to every question; the user gets useful uplift signal even
      // if the fixture wasn't curated for this exact panel).
      cases = await allBuiltInCases();
    }
    caseFileName = "(built-in fixtures)";
  }
  if (parsed.filterTag) {
    const wanted = parsed.filterTag;
    cases = cases.filter((c) => c.tags?.includes(wanted));
  }
  // `--quick`: trim to the first matching case and pin runs/seed to deterministic
  // defaults unless the user explicitly overrode them. The user can keep
  // `--quick` for the "one case" semantics and still pass `--runs 5 --seed 42`
  // to override the rest — those win over the defaults.
  if (parsed.quick && cases.length > 1) {
    cases = cases.slice(0, 1);
    if (!parsed.quiet) {
      process.stderr.write(
        `${SERVER_NAME} bench: --quick trimmed to first matching case "${cases[0]!.id}".\n`,
      );
    }
  }
  if (cases.length === 0) {
    process.stderr.write(
      `${SERVER_NAME} bench: no cases matched (after filtering). Nothing to run.\n`,
    );
    return 2;
  }

  const baseSeed = parsed.baseSeed ?? (parsed.quick ? QUICK_DEFAULT_SEED : Date.now());
  const perRunRubricCalls = evaluatorModelId ? 2 : 0;
  const totalCalls =
    cases.length * parsed.runs * (resolved.participants.length + 1 + perRunRubricCalls);

  if (!parsed.quiet) {
    const evalSuffix = evaluatorModelId
      ? `, evaluator=${evaluatorModelId} (${evaluatorProviderId})`
      : "";
    process.stderr.write(
      `${SERVER_NAME} bench: panel="${panel.id}", cases=${cases.length}, runs=${parsed.runs}, baseline=${baselineModelId} (${baselineProviderId})${evalSuffix}, seed=${baseSeed}${parsed.quick ? " (quick mode)" : ""}\n`,
    );
    const explainer = evaluatorModelId
      ? "cases × runs × (panel + baseline + 2 rubric evals)"
      : "cases × runs × (panel + baseline)";
    process.stderr.write(
      `${SERVER_NAME} bench: expected ≈${totalCalls} provider calls (${explainer}).\n`,
    );
  }

  // Build the engine defaults from panel + config.
  const engineDefaults = buildEngineDefaults(panel, config);

  // Abort on SIGINT.
  const ac = new AbortController();
  const onSig = () => ac.abort(new Error("interrupted (SIGINT)"));
  process.on("SIGINT", onSig);

  const progressHandler = parsed.quiet
    ? undefined
    : (e: BenchProgressEvent) => {
        process.stderr.write(`[bench] ${e.message}\n`);
      };

  let exitCode = 0;
  try {
    const report = await runSuite({
      cases,
      panel,
      participants: resolved.participants,
      engineDefaults,
      caller,
      baselineModelId,
      runs: parsed.runs,
      baseSeed,
      ...(progressHandler ? { onProgress: progressHandler } : {}),
      signal: ac.signal,
      ...(caseFileName ? { caseFileName } : {}),
      ...(evaluatorModelId ? { evaluatorModelId } : {}),
    });

    const md = formatReportMarkdown(report);
    process.stdout.write(`${md}\n`);

    if (parsed.outputPath) {
      const jsonPath = resolvePath(parsed.outputPath);
      const json = formatReportJson(report, { includeFullResults: parsed.includeFullResults });
      await writeFile(jsonPath, `${json}\n`, "utf8");
      if (!parsed.quiet) {
        process.stderr.write(`${SERVER_NAME} bench: wrote ${jsonPath}\n`);
      }
    }

    if (report.metrics.runsCounted < report.metrics.runsAttempted) {
      exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(
      `${SERVER_NAME} bench: suite failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    exitCode = 1;
  } finally {
    process.off("SIGINT", onSig);
  }

  return exitCode;
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Compose the engine-defaults bag the runner threads into every consensus
 * run. Panel defaults override config defaults, which override engine
 * defaults (which the engine itself applies if anything is missing).
 */
function buildEngineDefaults(
  panel: Preset,
  config: LoadedConfig,
): Omit<ConsensusOptions, "question" | "participants" | "randomSeed"> {
  const p = panel.defaults;
  const c = config.defaults;
  const out: Omit<ConsensusOptions, "question" | "participants" | "randomSeed"> = {};
  pickN(out, "maxRounds", [p.maxRounds, c.maxRounds]);
  pickB(out, "earlyStop", [p.earlyStop, c.earlyStop]);
  pickN(out, "convergenceDelta", [p.convergenceDelta, c.convergenceDelta]);
  pickN(out, "disagreementThreshold", [p.disagreementThreshold, c.disagreementThreshold]);
  pickB(out, "blindFirstRound", [p.blindFirstRound, c.blindFirstRound]);
  pickB(out, "randomizeOrder", [p.randomizeOrder, c.randomizeOrder]);
  pickN(out, "participantTemperature", [p.participantTemperature, c.participantTemperature]);
  pickN(out, "maxOutputTokens", [p.maxOutputTokens, c.maxOutputTokens]);

  if (c.useJudge && config.judge) {
    out.judge = {
      modelId: config.judge.modelId,
      ...(config.judge.temperature !== undefined ? { temperature: config.judge.temperature } : {}),
      ...(config.judge.maxOutputTokens !== undefined
        ? { maxOutputTokens: config.judge.maxOutputTokens }
        : {}),
      ...(panel.judgeSystemPrompt !== undefined ? { systemPrompt: panel.judgeSystemPrompt } : {}),
    };
  }
  return out;
}

function pickN<K extends string>(
  target: Record<string, unknown>,
  key: K,
  candidates: readonly (number | undefined)[],
): void {
  for (const c of candidates) {
    if (typeof c === "number") {
      target[key] = c;
      return;
    }
  }
}

function pickB<K extends string>(
  target: Record<string, unknown>,
  key: K,
  candidates: readonly (boolean | undefined)[],
): void {
  for (const c of candidates) {
    if (typeof c === "boolean") {
      target[key] = c;
      return;
    }
  }
}

function formatPanelList(): string {
  const registry = createRegistry(BUILT_IN_PRESETS);
  const all = registry
    .list()
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [];
  lines.push("Available panels:");
  for (const p of all) {
    const v = p.meta?.version ? ` v${p.meta.version}` : "";
    lines.push(`  • ${p.id}${v}  — ${p.title}`);
    const tags = p.meta?.tags ?? [];
    if (tags.length > 0) {
      lines.push(`      tags: ${tags.join(", ")}`);
    }
  }
  const allTags = registry.allTags();
  if (allTags.length > 0) {
    lines.push("");
    lines.push(`Tag index: ${allTags.join(", ")}`);
    lines.push("  (use --filter-tag <tag> to restrict built-in fixtures by tag.)");
  }
  return lines.join("\n");
}
