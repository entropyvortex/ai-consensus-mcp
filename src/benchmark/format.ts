// ─────────────────────────────────────────────────────────────
// Bench report formatting — markdown + JSON
// ─────────────────────────────────────────────────────────────
// The CLI renders the markdown to stdout and (optionally) writes the
// JSON to a file. Markdown is the primary surface — humans read it
// and the line numbers make it greppable. JSON is the durable record
// callers can diff or feed into a memory layer later.

import type { BenchMetrics, BenchReport, BenchRun } from "./types.js";

/**
 * Render the full BenchReport as a single markdown document. Section
 * order is fixed so different bench runs are diffable against each other.
 */
export function formatReportMarkdown(report: BenchReport): string {
  const lines: string[] = [];

  lines.push("# Bench Report");
  lines.push("");
  lines.push(formatHeader(report));
  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  lines.push(formatMetrics(report.metrics));
  lines.push("");

  lines.push("## Per-case results");
  lines.push("");
  lines.push(formatPerCaseTable(report.runs));
  lines.push("");

  if (report.qualitativeNotes.length > 0) {
    lines.push("## Qualitative notes");
    lines.push("");
    for (const note of report.qualitativeNotes) lines.push(note);
    lines.push("");
  }

  lines.push("## Suite metadata");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(buildHeaderRecord(report), null, 2));
  lines.push("```");

  return lines.join("\n");
}

/**
 * Stable JSON form. Filters out the heavy ConsensusResult bodies by default —
 * those are useful for memory recall later, but they bloat a bench artifact
 * meant for diffing. Pass `includeFullResults = true` to keep them.
 */
export function formatReportJson(
  report: BenchReport,
  options: { includeFullResults?: boolean } = {},
): string {
  const includeFull = options.includeFullResults ?? false;
  const slim = includeFull
    ? report
    : {
        ...report,
        runs: report.runs.map((r) => ({
          ...r,
          consensus: {
            ...r.consensus,
            // Drop the verbose `result` body but keep its top-level summary.
            result: undefined,
          },
        })),
      };
  return JSON.stringify(slim, null, 2);
}

// ── Helpers ───────────────────────────────────────────────────

function formatHeader(report: BenchReport): string {
  const version = report.panelVersion ? ` v${report.panelVersion}` : "";
  const lines: string[] = [];
  lines.push(`**Panel:** ${report.panelTitle} (\`${report.panelId}\`)${version}`);
  lines.push(`**Cases:** ${report.cases.length}`);
  const runsPerCase = report.cases.length > 0 ? report.runs.length / report.cases.length : 0;
  lines.push(`**Runs per case:** ${runsPerCase}`);
  lines.push(`**Total runs:** ${report.runs.length}`);
  lines.push(`**Baseline model:** \`${report.baselineModelId}\``);
  lines.push(`**Base seed:** ${report.baseSeed}`);
  lines.push(`**Generated at:** ${new Date(report.generatedAt).toISOString()}`);
  if (report.caseFileName) {
    lines.push(`**Case file:** ${report.caseFileName}`);
  }
  return lines.join("  \n");
}

function formatMetrics(m: BenchMetrics): string {
  const lines: string[] = [];
  lines.push(
    `- **Agreement rate** (final σ ≤ ${m.agreementStddevThreshold}): ${pct(m.agreementRate)} (${runsLabel(m)})`,
  );
  lines.push(
    `- **Convergence speed:** ${m.convergenceSpeedAvgRounds.toFixed(2)} rounds avg • **Early-stop rate:** ${pct(m.earlyStopRate)}`,
  );
  if (m.judgeConfidenceMean !== undefined && m.judgeConfidenceStddev !== undefined) {
    lines.push(
      `- **Judge confidence:** μ=${m.judgeConfidenceMean.toFixed(1)}, σ=${m.judgeConfidenceStddev.toFixed(1)}`,
    );
  } else {
    lines.push("- **Judge confidence:** _(no judge synthesis on any run)_");
  }
  lines.push(
    `- **Inter-rater reliability proxy:** ${m.interRaterReliabilityProxy.toFixed(2)} (1.00 = unanimous, 0.00 = max split)`,
  );
  lines.push(`- **Avg disagreements per run:** ${m.disagreementCountAvg.toFixed(2)}`);
  lines.push(`- **Duration ratio (consensus / baseline):** ${m.durationRatioAvg.toFixed(2)}×`);
  if (m.tokenRatioAvg !== undefined) {
    lines.push(
      `- **Token ratio (consensus / baseline):** ${m.tokenRatioAvg.toFixed(2)}× — the cost multiplier of running a panel vs. one model`,
    );
  }
  lines.push(
    `- **Consensus score > baseline confidence:** ${pct(m.consensusBeatsBaselineConfidenceRate)} of runs`,
  );
  if (
    m.consensusRubricNormalizedMean !== undefined ||
    m.baselineRubricNormalizedMean !== undefined ||
    m.consensusBeatsBaselineRubricRate !== undefined
  ) {
    lines.push("");
    lines.push("**Held-out rubric** (independent quality eval — not self-reported confidence):");
    if (
      m.consensusRubricNormalizedMean !== undefined &&
      m.baselineRubricNormalizedMean !== undefined
    ) {
      const delta = m.consensusRubricNormalizedMean - m.baselineRubricNormalizedMean;
      lines.push(
        `- **Mean rubric score:** consensus ${m.consensusRubricNormalizedMean.toFixed(1)}/100, baseline ${m.baselineRubricNormalizedMean.toFixed(1)}/100 (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`,
      );
    } else {
      if (m.consensusRubricNormalizedMean !== undefined) {
        lines.push(
          `- **Consensus mean rubric score:** ${m.consensusRubricNormalizedMean.toFixed(1)}/100`,
        );
      }
      if (m.baselineRubricNormalizedMean !== undefined) {
        lines.push(
          `- **Baseline mean rubric score:** ${m.baselineRubricNormalizedMean.toFixed(1)}/100`,
        );
      }
    }
    if (m.consensusBeatsBaselineRubricRate !== undefined) {
      lines.push(
        `- **Consensus beats baseline on rubric:** ${pct(m.consensusBeatsBaselineRubricRate)} of paired runs (${m.rubricRunsCounted} pairs)`,
      );
    }
  }
  return lines.join("\n");
}

function formatPerCaseTable(runs: readonly BenchRun[]): string {
  const lines: string[] = [];
  const anyRubric = runs.some(
    (r) => r.consensus.rubric !== undefined || r.baseline.rubric !== undefined,
  );
  if (anyRubric) {
    lines.push(
      "| Case | Run | Score | σ | Rounds | Stop | Disagree | Judge conf | Baseline conf | Δ conf | Rubric C | Rubric B | Δ rubric |",
    );
    lines.push(
      "| ---- | --- | ----- | - | ------ | ---- | -------- | ---------- | ------------- | ------ | -------- | -------- | -------- |",
    );
  } else {
    lines.push(
      "| Case | Run | Score | σ | Rounds | Stop | Disagree | Judge conf | Baseline conf | Δ |",
    );
    lines.push(
      "| ---- | --- | ----- | - | ------ | ---- | -------- | ---------- | ------------- | - |",
    );
  }
  for (const r of runs) {
    if (r.failed) {
      const baseFailed = `| ${r.caseId} | ${r.runIndex} | — | — | — | — | — | — | — | _FAILED: ${escapeTable(r.errorMessage ?? "?")}_ |`;
      lines.push(anyRubric ? `${baseFailed} — | — | — |` : baseFailed);
      continue;
    }
    const c = r.consensus;
    const delta = c.finalScore - r.baseline.confidence;
    const baseRow = `| ${r.caseId} | ${r.runIndex} | ${c.finalScore} | ${c.finalStddev.toFixed(1)} | ${c.roundsCompleted} | ${shortStopReason(
      c.result.stopReason,
    )} | ${c.disagreementCount} | ${c.judgeConfidence ?? "—"} | ${r.baseline.confidence} | ${delta >= 0 ? "+" : ""}${delta} |`;
    if (!anyRubric) {
      lines.push(baseRow);
      continue;
    }
    const cr = r.consensus.rubric;
    const br = r.baseline.rubric;
    const crCell = !cr ? "—" : cr.errorMessage ? "ERR" : `${cr.normalized}`;
    const brCell = !br ? "—" : br.errorMessage ? "ERR" : `${br.normalized}`;
    let rubricDeltaCell = "—";
    if (cr && !cr.errorMessage && br && !br.errorMessage) {
      const d = cr.normalized - br.normalized;
      rubricDeltaCell = `${d >= 0 ? "+" : ""}${d}`;
    }
    lines.push(`${baseRow} ${crCell} | ${brCell} | ${rubricDeltaCell} |`);
  }
  return lines.join("\n");
}

function buildHeaderRecord(report: BenchReport): Record<string, unknown> {
  return {
    panelId: report.panelId,
    panelTitle: report.panelTitle,
    panelVersion: report.panelVersion,
    baselineModelId: report.baselineModelId,
    baseSeed: report.baseSeed,
    generatedAt: report.generatedAt,
    caseFileName: report.caseFileName,
    caseCount: report.cases.length,
    runCount: report.runs.length,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function runsLabel(m: BenchMetrics): string {
  return m.runsCounted === m.runsAttempted
    ? `${m.runsCounted} runs`
    : `${m.runsCounted}/${m.runsAttempted} runs counted (rest failed)`;
}

function shortStopReason(s: string): string {
  if (s === "converged") return "conv";
  if (s === "max-rounds") return "max";
  if (s === "aborted") return "abort";
  return s;
}

function escapeTable(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
