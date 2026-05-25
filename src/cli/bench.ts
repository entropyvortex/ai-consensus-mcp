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
  filterTag: string | undefined;
  includeFullResults: boolean;
  listPanels: boolean;
  quiet: boolean;
}

const BENCH_HELP = `
${SERVER_NAME} bench — measure panel uplift over a single-model baseline

Usage:
  ai-consensus-mcp bench --config <path> --panel <id> [--runs N]
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
      --seed <N>               Base random seed. Defaults to Date.now().
      --baseline-model <id>    Model id for the single-model baseline.
                               Defaults to the judge model from config.
      --baseline-provider <id> Provider id for the baseline model.
                               Defaults to the judge provider from config.
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
    filterTag: undefined,
    includeFullResults: false,
    listPanels: false,
    quiet: false,
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
      if (!Number.isFinite(n) || n < 1) return new Error(`--runs expects a positive integer (got "${v}").`);
      out.runs = n;
    } else if (arg === "--seed") {
      const v = next();
      if (v instanceof Error) return v;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) return new Error(`--seed expects a non-negative integer (got "${v}").`);
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

  // Bench mode does not support MCP host-sample participants — there's no
  // calling host. Fail loudly if any are present rather than silently swap.
  if (Object.keys(config.hostSampleParticipants).length > 0) {
    process.stderr.write(
      `${SERVER_NAME} bench: host-sample participants are not supported in CLI bench mode (${Object.keys(
        config.hostSampleParticipants,
      ).join(
        ", ",
      )}). Reconfigure these participants as provider-backed to bench them.\n`,
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

  // Compose the per-call routing: panel participants → their providers,
  // plus the synthetic "baseline" and "judge" ids → judge provider.
  const providerByParticipant: Record<string, string> = {
    ...resolved.providerByParticipant,
    baseline: baselineProviderId,
  };
  if (config.judge) {
    providerByParticipant["judge"] = config.judge.providerId;
  }
  const caller: ModelCaller = createOpenAICompatibleCaller({
    providers: config.providers,
    providerByParticipant,
  });

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
  if (cases.length === 0) {
    process.stderr.write(
      `${SERVER_NAME} bench: no cases matched (after filtering). Nothing to run.\n`,
    );
    return 2;
  }

  const baseSeed = parsed.baseSeed ?? Date.now();
  const totalCalls = cases.length * parsed.runs * (resolved.participants.length + 1);

  if (!parsed.quiet) {
    process.stderr.write(
      `${SERVER_NAME} bench: panel="${panel.id}", cases=${cases.length}, runs=${parsed.runs}, baseline=${baselineModelId} (${baselineProviderId}), seed=${baseSeed}\n`,
    );
    process.stderr.write(
      `${SERVER_NAME} bench: expected ≈${totalCalls} provider calls (cases × runs × (panel + baseline)).\n`,
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
  const all = registry.list().slice().sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [];
  lines.push("Available panels:");
  for (const p of all) {
    const v = p.meta?.version ? ` v${p.meta.version}` : "";
    lines.push(`  • ${p.id}${v}  — ${p.title}`);
  }
  return lines.join("\n");
}

