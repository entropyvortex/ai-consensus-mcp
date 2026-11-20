// ─────────────────────────────────────────────────────────────
// consensus_compare_attempts / consensus_list_attempts
// ─────────────────────────────────────────────────────────────
// Best-of-N adjudication for an agent running in one attempt's worktree:
// list the sibling attempts, then have the panel judge them. The server
// computes every diff itself with git, so diffs never pass through the
// calling agent's context; the agent gets a short verdict plus the typed
// result. Registered on stdio only (see server.ts).

import { z } from "zod";
import {
  AdjudicationEngine,
  CANDIDATE_LABELS,
  buildJurorVerdictJsonSchema,
  type AdjudicationCandidate,
  type AdjudicationResult,
  type CandidateCheck,
  type ConsensusOptions,
  type ModelCaller,
  type Participant,
} from "ai-consensus-core";
import { createConsensusCaller, type McpServerDeps } from "../caller.js";
import type { ResolvedProvider } from "../config.js";
import { wireAdjudicationProgress, type SendNotification } from "../progress.js";
import { computeAttemptDiff, type AttemptDiff } from "../repo/diff.js";
import {
  createGit,
  listAttempts,
  listWorktrees,
  repoRoot,
  resolveCommit,
  type Git,
  type ListAttemptsResult,
} from "../repo/git.js";
import { TEST_CHECK_NAME, runTestCommand } from "../repo/test-command.js";

export const COMPARE_ATTEMPTS_TOOL = "consensus_compare_attempts";
export const LIST_ATTEMPTS_TOOL = "consensus_list_attempts";

export const COMPARE_DEFAULTS = {
  maxRounds: 1,
  deadlineMs: 600_000,
  diffTokenBudget: 12_000,
  testTimeoutMs: 600_000,
} as const;

// ── Input schemas ───────────────────────────────────────────

const CheckInputSchema = z.object({
  name: z.string().min(1).max(80),
  status: z.enum(["passed", "failed", "unknown"]),
  output: z.string().max(4_000).optional(),
});

const AttemptInputSchema = z.object({
  ref: z.string().min(1).max(256),
  label: z.string().min(1).max(80).optional(),
  checks: z.array(CheckInputSchema).max(8).optional(),
});

export const CompareAttemptsInputSchema = z.object({
  task: z.string().min(1).max(20_000),
  repoPath: z.string().min(1).optional(),
  base: z.string().min(1).max(256).optional(),
  attempts: z.array(AttemptInputSchema).min(2).max(6),
  panel: z.string().min(1).optional(),
  participantIds: z.array(z.string().min(1)).min(2).optional(),
  judge: z.boolean().optional(),
  maxRounds: z.number().int().min(1).max(3).optional(),
  randomSeed: z.number().int().nonnegative().optional(),
  deadlineMs: z.number().int().min(10_000).max(3_600_000).optional(),
  maxTokens: z.number().int().positive().optional(),
  diffTokenBudget: z.number().int().min(1_000).max(100_000).optional(),
  includeUncommitted: z.boolean().optional(),
  testCommand: z.array(z.string().min(1)).min(1).max(64).optional(),
  testTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
});

export type CompareAttemptsInput = z.infer<typeof CompareAttemptsInputSchema>;

export const ListAttemptsInputSchema = z.object({
  repoPath: z.string().min(1).optional(),
  base: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export type ListAttemptsInput = z.infer<typeof ListAttemptsInputSchema>;

const CHECK_JSON = {
  type: "object",
  additionalProperties: false,
  required: ["name", "status"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    status: { type: "string", enum: ["passed", "failed", "unknown"] },
    output: { type: "string", maxLength: 4000, description: "Optional output excerpt." },
  },
} as const;

export const COMPARE_ATTEMPTS_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["task", "attempts"],
  properties: {
    task: {
      type: "string",
      minLength: 1,
      description: "The task every attempt was asked to solve.",
    },
    repoPath: {
      type: "string",
      description: "Any path inside the repository. Default: the server's working directory.",
    },
    base: {
      type: "string",
      description:
        "Base ref the attempts started from. Default: the merge-base of all attempts. Diffs are taken from merge-base(base, attempt).",
    },
    attempts: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      description:
        "Attempts to compare: branch names, refs or commits. Find them with consensus_list_attempts. A branch checked out in a worktree is compared with its uncommitted changes too.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref"],
        properties: {
          ref: { type: "string", minLength: 1 },
          label: {
            type: "string",
            description: "Display label for the result only; never shown to jurors.",
          },
          checks: { type: "array", maxItems: 8, items: CHECK_JSON },
        },
      },
    },
    panel: {
      type: "string",
      description:
        "Expert-panel id whose seats act as jurors. Mutually exclusive with participantIds.",
    },
    participantIds: {
      type: "array",
      minItems: 2,
      items: { type: "string" },
      description: "Configured participants to use as jurors. Default: all.",
    },
    judge: {
      type: "boolean",
      description: "Run the non-voting judge synthesis. Default: config.defaults.useJudge.",
    },
    maxRounds: {
      type: "integer",
      minimum: 1,
      maximum: 3,
      description: "1 = blind round only (default); 2–3 allow rebuttal rounds when jurors split.",
    },
    randomSeed: {
      type: "integer",
      minimum: 0,
      description: "Seeds each juror's candidate order for replay.",
    },
    deadlineMs: {
      type: "integer",
      minimum: 10000,
      maximum: 3600000,
      description:
        "Wall-clock limit; a partial result is returned at the deadline. Default 600000.",
    },
    maxTokens: {
      type: "integer",
      minimum: 1,
      description: "Token ceiling across all calls; a partial result is returned on breach.",
    },
    diffTokenBudget: {
      type: "integer",
      minimum: 1000,
      maximum: 100000,
      description:
        "Per-attempt diff budget in tokens (chars/4). Whole files beyond it are omitted and listed. Default 12000.",
    },
    includeUncommitted: {
      type: "boolean",
      description:
        "Include uncommitted and untracked changes of a checked-out attempt. Default true.",
    },
    testCommand: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional argv (no shell), run in each attempt's worktree; the result becomes a check. EXECUTES REPOSITORY CODE. Refused unless the server was started with --allow-test-command.",
    },
    testTimeoutMs: {
      type: "integer",
      minimum: 1000,
      maximum: 3600000,
      description: "Per-attempt test timeout. Default 600000.",
    },
  },
} as const;

export const LIST_ATTEMPTS_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    repoPath: {
      type: "string",
      description: "Any path inside the repository. Default: the server's working directory.",
    },
    base: {
      type: "string",
      description: "Base for ahead/behind. Default: origin/HEAD, then main, master, HEAD.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Most recently committed branches to list. Default 50.",
    },
  },
} as const;

export const COMPARE_ATTEMPTS_DESCRIPTION =
  "Judge 2–6 attempts at the same coding task (branches or worktrees off one base, e.g. a best-of-N run) and report which to keep. The server computes each diff with git (diffs never pass through your context), then the panel judges blind: neutral shuffled labels, a full ranking per juror, findings with verbatim quotes checked against the diff, Borda count + Kendall's W, and an optional judge synthesis. Returns a short verdict (recommended ref, or no clear winner and why) plus the typed result. Read-only: never merges, checks out or deletes anything.";

export const LIST_ATTEMPTS_DESCRIPTION =
  "List the branches and worktrees of this repository with ahead/behind against a base and uncommitted change counts, so you can find the sibling attempts of a task before calling consensus_compare_attempts. Read-only.";

// ── Context ─────────────────────────────────────────────────

export interface CompareRunContext {
  input: CompareAttemptsInput;
  jurors: Participant[];
  providers: Record<string, ResolvedProvider>;
  providerByParticipant: Record<string, string>;
  judge: ConsensusOptions["judge"] | undefined;
  deps: McpServerDeps | undefined;
  allowTestCommand: boolean;
  signal?: AbortSignal;
  progress?: { sendNotification: SendNotification; progressToken: string | number };
  /** Injected for tests. */
  git?: Git;
  cwd?: string;
  callerFactory?: (
    jsonSchemaFor: (participantId: string) => Record<string, unknown> | undefined,
  ) => ModelCaller;
}

export interface AttemptSummary {
  ref: string;
  label: string;
  sha: string;
  worktree: string | null;
  includesUncommitted: boolean;
  diffTokens: number;
  files: AttemptDiff["files"];
}

export class ToolInputError extends Error {}

function textResult(text: string, structured: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

// ── list ────────────────────────────────────────────────────

export async function runListAttempts(args: { input: ListAttemptsInput; git?: Git; cwd?: string }) {
  const git = args.git ?? createGit();
  const result = await listAttempts(git, args.input.repoPath ?? args.cwd ?? process.cwd(), {
    ...(args.input.base !== undefined ? { base: args.input.base } : {}),
    ...(args.input.limit !== undefined ? { limit: args.input.limit } : {}),
  });
  return textResult(formatListMarkdown(result), result as unknown as Record<string, unknown>);
}

export function formatListMarkdown(r: ListAttemptsResult): string {
  const lines = [
    `Base: \`${r.base.ref}\` (${r.base.sha.slice(0, 10)}, ${r.base.source}) · repo ${r.repoRoot}`,
    "",
    "| Branch | Ahead | Behind | Worktree | Uncommitted |",
    "| ------ | ----- | ------ | -------- | ----------- |",
  ];
  for (const a of r.attempts) {
    const here = a.current ? " (this worktree)" : "";
    lines.push(
      `| \`${a.name}\`${here} | ${a.ahead} | ${a.behind} | ${a.worktree ?? "—"} | ${a.uncommitted ?? "—"} |`,
    );
  }
  if (r.detachedWorktrees.length > 0) {
    lines.push(
      "",
      `Detached worktrees: ${r.detachedWorktrees.map((w) => `${w.path} @ ${(w.head ?? "?").slice(0, 10)}`).join(", ")}`,
    );
  }
  lines.push(
    "",
    "Attempts usually share a base and are ahead of it; pass their branch names to consensus_compare_attempts.",
  );
  return lines.join("\n");
}

// ── compare ─────────────────────────────────────────────────

export async function runCompareAttempts(ctx: CompareRunContext) {
  const { input } = ctx;
  if (input.testCommand && !ctx.allowTestCommand) {
    throw new ToolInputError(
      "testCommand is disabled: it executes repository code, so the server must be started with --allow-test-command.",
    );
  }
  const refs = input.attempts.map((a) => a.ref);
  if (new Set(refs).size !== refs.length)
    throw new ToolInputError("attempts must name distinct refs.");

  const git = ctx.git ?? createGit();
  const root = await repoRoot(git, input.repoPath ?? ctx.cwd ?? process.cwd());
  const shas = await Promise.all(refs.map((ref) => resolveCommit(git, root, ref, "attempt ref")));
  let baseSha: string;
  if (input.base !== undefined) {
    baseSha = await resolveCommit(git, root, input.base, "base");
  } else {
    const mb = await git(["merge-base", "--octopus", ...shas], root, [0, 1]);
    baseSha = mb.stdout.trim();
    if (mb.exitCode !== 0 || !baseSha) {
      throw new ToolInputError("The attempts share no common ancestor; pass `base` explicitly.");
    }
  }

  const worktrees = await listWorktrees(git, root);
  const byBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch!, w]));
  const fullRefs = await Promise.all(
    refs.map(async (ref) => {
      // --verify: without it rev-parse echoes "--end-of-options" as output.
      const r = await git(
        ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", "--end-of-options", ref],
        root,
        [0, 1],
      );
      return r.stdout.trim();
    }),
  );
  const budget = input.diffTokenBudget ?? COMPARE_DEFAULTS.diffTokenBudget;
  const diffs = await Promise.all(
    refs.map((ref, i) =>
      computeAttemptDiff(git, root, {
        ref,
        sha: shas[i]!,
        baseSha,
        worktree: byBranch.get(fullRefs[i]!) ?? null,
        options: { tokenBudget: budget, includeUncommitted: input.includeUncommitted ?? true },
      }),
    ),
  );

  // Optional test command, sequential, each in its attempt's worktree.
  const testChecks: (CandidateCheck | undefined)[] = [];
  for (const d of diffs) {
    if (!input.testCommand) {
      testChecks.push(undefined);
      continue;
    }
    const wt = d.includesUncommitted ? d.worktree : null;
    testChecks.push(
      wt
        ? await runTestCommand({
            argv: input.testCommand,
            cwd: wt,
            timeoutMs: input.testTimeoutMs ?? COMPARE_DEFAULTS.testTimeoutMs,
          })
        : {
            name: TEST_CHECK_NAME,
            status: "unknown",
            output: "no worktree has this ref checked out",
          },
    );
  }

  const candidates: AdjudicationCandidate[] = input.attempts.map((a, i) => ({
    id: a.ref,
    content: diffs[i]!.content,
    checks: [...(a.checks ?? []), ...(testChecks[i] ? [testChecks[i]] : [])],
  }));
  const jurorSchema = buildJurorVerdictJsonSchema(CANDIDATE_LABELS.slice(0, candidates.length));
  const schemaFor = (participantId: string) =>
    participantId === "judge" ? undefined : jurorSchema;
  const caller =
    ctx.callerFactory?.(schemaFor) ??
    createConsensusCaller({
      providers: ctx.providers,
      providerByParticipant: ctx.providerByParticipant,
      ...(ctx.deps ?? {}),
      jsonSchemaFor: (req) => schemaFor(req.participantId),
    });

  const engine = new AdjudicationEngine(caller);
  const maxRounds = input.maxRounds ?? COMPARE_DEFAULTS.maxRounds;
  const detach = ctx.progress
    ? wireAdjudicationProgress({
        engine,
        sendNotification: ctx.progress.sendNotification,
        progressToken: ctx.progress.progressToken,
        jurorCount: ctx.jurors.length,
        maxRounds,
        judgeEnabled: Boolean(ctx.judge),
      })
    : () => undefined;
  let result: AdjudicationResult;
  try {
    result = await engine.adjudicate({
      task: input.task,
      candidates,
      jurors: ctx.jurors,
      maxRounds,
      ...(ctx.judge ? { judge: ctx.judge } : {}),
      ...(input.randomSeed !== undefined ? { randomSeed: input.randomSeed } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      budget: {
        deadlineMs: input.deadlineMs ?? COMPARE_DEFAULTS.deadlineMs,
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      },
    });
  } finally {
    detach();
  }

  const attempts: AttemptSummary[] = input.attempts.map((a, i) => ({
    ref: a.ref,
    label: a.label ?? a.ref,
    sha: shas[i]!,
    worktree: diffs[i]!.worktree,
    includesUncommitted: diffs[i]!.includesUncommitted,
    diffTokens: diffs[i]!.tokens,
    files: diffs[i]!.files,
  }));
  const structured = {
    ...stripRaw(result),
    base: { ref: input.base ?? null, sha: baseSha },
    attempts,
  };
  return textResult(formatVerdictMarkdown(result, attempts), structured);
}

/** Juror raw outputs stay out of the agent's context. */
function stripRaw(result: AdjudicationResult): AdjudicationResult {
  return {
    ...result,
    rounds: result.rounds.map((r) => ({
      ...r,
      verdicts: r.verdicts.map((v) => ({ ...v, raw: "" })),
    })),
  };
}

const REASON_TEXT: Record<string, string> = {
  incomplete: "not every juror finished the first round",
  "insufficient-votes": "fewer than two jurors returned a valid verdict",
  "low-agreement": "the jurors disagree",
  tie: "the top attempts are tied on points",
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function formatVerdictMarkdown(
  r: AdjudicationResult,
  attempts: readonly AttemptSummary[],
): string {
  const name = (id: string | null) => {
    if (id === null) return "—";
    const a = attempts.find((x) => x.ref === id);
    return a && a.label !== a.ref ? `\`${id}\` (${a.label})` : `\`${id}\``;
  };
  const lines: string[] = [];
  if (r.verdict === "winner") {
    lines.push(`**Verdict: keep ${name(r.recommended)}.**`);
  } else {
    const why = r.noClearWinnerReason ? REASON_TEXT[r.noClearWinnerReason] : "no recommendation";
    lines.push(
      `**Verdict: no clear winner** — ${why}.${r.leader ? ` Leading on points: ${name(r.leader)}.` : ""}`,
    );
  }
  const w = r.agreement.kendallW;
  lines.push(
    `Agreement (Kendall's W) ${w === null ? "n/a" : w.toFixed(2)} (threshold ${r.agreement.threshold.toFixed(2)}) · ${r.agreement.votes} vote(s) · ${r.rounds.length} round(s) · stop: ${r.stopReason}`,
  );
  if (r.stopReason !== "completed") lines.push(`_Partial result: stopped by ${r.stopReason}._`);
  lines.push(
    "",
    "| # | Attempt | Points | 1st | Findings | Checks |",
    "| - | ------- | ------ | --- | -------- | ------ |",
  );
  for (const row of r.ranking) {
    const listed = (r.candidates.find((c) => c.id === row.candidateId)?.checks ?? [])
      .map((c) => `${c.name} ${c.status}`)
      .join(", ");
    const checks = listed === "" ? "—" : listed;
    lines.push(
      `| ${row.rank} | ${name(row.candidateId)}${row.eligible ? "" : " ⚠ ineligible"} | ${row.points} | ${row.firstPlaceVotes} | ${row.findingWeight} | ${checks} |`,
    );
  }
  const findings = r.findings
    .flatMap((f) => f.verified.map((v) => ({ ...v, ref: f.candidateId })))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  lines.push(
    "",
    `Verified findings (${findings.length}; ${r.droppedFindings} dropped as unverifiable):`,
  );
  for (const f of findings.slice(0, 10)) {
    const at = f.line === null ? f.file : `${f.file}:${f.line}`;
    lines.push(`- ${name(f.ref)} **${f.severity}** \`${at}\` — ${f.issue}`);
  }
  if (findings.length > 10) lines.push(`- … ${findings.length - 10} more in the structured result`);
  if (r.dissent.length > 0) {
    lines.push(
      "",
      `Dissent: ${r.dissent.map((d) => `${d.jurorId} preferred ${name(d.topPick)}`).join("; ")}.`,
    );
  }
  if (r.synthesis?.majorityPosition) {
    lines.push("", `Judge: ${r.synthesis.majorityPosition.split("\n")[0]}`);
  }
  const coverage = attempts
    .filter((a) => a.files.skipped.length > 0 || a.files.truncated.length > 0)
    .map(
      (a) =>
        `${name(a.ref)}: ${a.files.included.length} file(s) shown, ${a.files.skipped.length} skipped (lockfile/generated/binary), ${a.files.truncated.length} over budget${a.files.truncated.length ? ` (${a.files.truncated.map((t) => t.path).join(", ")})` : ""}`,
    );
  if (coverage.length > 0) lines.push("", "Diff coverage:", ...coverage.map((c) => `- ${c}`));
  lines.push("", "Nothing was merged, checked out or deleted.");
  return lines.join("\n");
}
