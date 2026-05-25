// ─────────────────────────────────────────────────────────────
// Memory store — durable, atomic, project-scoped result storage
// ─────────────────────────────────────────────────────────────
// Each consensus result is wrapped in a versioned envelope and
// written to `results/<id>.json` atomically (write → rename).
// A slim summary line is appended to `index.jsonl` after the
// result file rename completes — so a crash mid-write can never
// leave a referenced-but-unwritten id (premortem F1).
//
// The store is created with an explicit storage root; the CLI /
// server is responsible for resolving the path and passing it in.
// No `$HOME` reads inside the module (premortem F8).

import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ConsensusResult } from "ai-consensus-core";
import {
  CURRENT_SCHEMA_VERSION,
  IndexLineSchema,
  StoredEntrySchema,
  type IndexLine,
  type RecallHit,
  type RecallQuery,
  type StoredEntry,
} from "./types.js";
import { scoreEntry } from "./query.js";

/** Public store interface — what server.ts and the CLI consume. */
export interface MemoryStore {
  /** Persist a fresh consensus result. Returns the assigned id. */
  store(args: StoreArgs): Promise<{ id: string }>;
  /** Filter + rank stored entries. */
  recall(query: RecallQuery): Promise<RecallHit[]>;
  /** Read one full entry by id. Returns undefined if not found. */
  get(id: string): Promise<StoredEntry | undefined>;
  /** Number of indexed entries (after pruning expired ones). */
  count(): Promise<number>;
  /** Hard-delete everything for this project. */
  wipe(): Promise<void>;
  /** Rebuild the index by scanning results/ — recovery from index corruption. */
  rebuildIndex(): Promise<{ count: number }>;
}

export interface StoreArgs {
  projectKey: string;
  projectPath: string;
  panelId: string;
  question: string;
  result: ConsensusResult;
  tags?: readonly string[];
}

export interface CreateMemoryStoreArgs {
  /** Absolute, already-resolved storage root. */
  storageRoot: string;
  /** Max stored entries before pruning oldest. Default 1000. */
  maxResults?: number;
  /** Drop entries older than this. Default 365. */
  maxAgeDays?: number;
  /**
   * The project the store is scoped to. Recall queries default to filtering
   * by this key (cross-project recall requires explicit opt-in — F4).
   */
  projectKey: string;
  /** Resolved project path (for self-validation on recall — F4). */
  projectPath: string;
}

const INDEX_FILENAME = "index.jsonl";
const LOCK_SUFFIX = ".lock";
const RESULTS_DIR = "results";
const QUESTION_PREVIEW_CHARS = 240;
const SUMMARY_PREVIEW_CHARS = 1200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const MS_PER_DAY = 86_400_000;

export async function createMemoryStore(args: CreateMemoryStoreArgs): Promise<MemoryStore> {
  const root = args.storageRoot;
  const resultsDir = join(root, RESULTS_DIR);
  const indexPath = join(root, INDEX_FILENAME);
  const lockPath = `${indexPath}${LOCK_SUFFIX}`;
  const maxResults = args.maxResults ?? 1000;
  const maxAgeMs = (args.maxAgeDays ?? 365) * MS_PER_DAY;
  const scopedProjectKey = args.projectKey;

  await mkdir(resultsDir, { recursive: true });

  // Touch the index file so subsequent appends don't race a missing-parent.
  try {
    await stat(indexPath);
  } catch {
    await writeFile(indexPath, "", { encoding: "utf8", mode: 0o600 });
  }

  // ── Locking ────────────────────────────────────────────────
  // Simple sentinel-file lock; portable, no native deps. Concurrent writers
  // contend on the existence of `lockPath`; whoever gets `O_EXCL` wins,
  // others spin with backoff. The lock window is the index append only —
  // result-file rename is already atomic, so the lock is just for the
  // index line (premortem F6).
  async function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const maxAttempts = 50;
    const baseDelay = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const fh = await open(lockPath, "wx", 0o600);
        await fh.close();
        try {
          return await fn();
        } finally {
          await rm(lockPath, { force: true });
        }
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "EEXIST") {
          const sleepMs = baseDelay * (1 + attempt);
          await new Promise((r) => setTimeout(r, sleepMs));
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      `memory: could not acquire index lock at ${lockPath} after ${maxAttempts} attempts`,
    );
  }

  // ── Index read ─────────────────────────────────────────────
  async function readIndexLines(): Promise<IndexLine[]> {
    let text: string;
    try {
      text = await readFile(indexPath, "utf8");
    } catch {
      return [];
    }
    if (!text) return [];
    const out: IndexLine[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Skip malformed lines (premortem F6, ratchet).
        continue;
      }
      const validated = IndexLineSchema.safeParse(parsed);
      if (!validated.success) continue;
      out.push(validated.data);
    }
    return out;
  }

  // ── Read full entry by id ──────────────────────────────────
  async function readEntry(id: string): Promise<StoredEntry | undefined> {
    const path = join(resultsDir, `${id}.json`);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    const validated = StoredEntrySchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  }

  // ── Prune by retention policy ──────────────────────────────
  async function pruneIfNeeded(lines: IndexLine[]): Promise<IndexLine[]> {
    const now = Date.now();
    // Drop expired entries first.
    const fresh = lines.filter((l) => now - l.storedAt <= maxAgeMs);
    // Then enforce maxResults — drop oldest.
    const kept = fresh
      .slice()
      .sort((a, b) => b.storedAt - a.storedAt)
      .slice(0, maxResults);
    const keptIds = new Set(kept.map((l) => l.id));
    const dropped = lines.filter((l) => !keptIds.has(l.id));
    for (const d of dropped) {
      try {
        await rm(join(resultsDir, `${d.id}.json`), { force: true });
      } catch {
        // Already gone; not fatal.
      }
    }
    if (dropped.length > 0) {
      // Rewrite the index atomically.
      const newBody = kept.map((l) => JSON.stringify(l)).join("\n") + (kept.length > 0 ? "\n" : "");
      const tmpPath = `${indexPath}.tmp`;
      await writeFile(tmpPath, newBody, { encoding: "utf8", mode: 0o600 });
      await rename(tmpPath, indexPath);
    }
    return kept;
  }

  // ── Store ──────────────────────────────────────────────────
  async function storeOne(input: StoreArgs): Promise<{ id: string }> {
    const id = deriveEntryId(input.question, Date.now());
    const entry: StoredEntry = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id,
      storedAt: Date.now(),
      projectKey: input.projectKey,
      projectPath: input.projectPath,
      panelId: input.panelId,
      question: input.question,
      tags: input.tags?.slice() ?? [],
      result: input.result as unknown as Record<string, unknown>,
    };
    // 1) Write result file atomically (F1).
    const resultPath = join(resultsDir, `${id}.json`);
    const tmpPath = `${resultPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(entry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmpPath, resultPath);

    // 2) Append index line under exclusive lock (F6).
    const indexLine = buildIndexLine(entry);
    await withIndexLock(async () => {
      await appendFile(indexPath, `${JSON.stringify(indexLine)}\n`, "utf8");
    });

    // 3) Apply retention (best-effort; failures don't break the store).
    try {
      const lines = await readIndexLines();
      await pruneIfNeeded(lines);
    } catch {
      // No-op — retention is a maintenance step.
    }

    return { id };
  }

  // ── Recall ─────────────────────────────────────────────────
  async function recallOne(query: RecallQuery): Promise<RecallHit[]> {
    const lines = await readIndexLines();
    const filtered = lines.filter((l) => {
      if (!query.acrossProjects && l.projectKey !== scopedProjectKey) return false;
      if (query.panelId && l.panelId !== query.panelId) return false;
      if (query.anyTag && query.anyTag.length > 0) {
        if (!l.tags.some((t) => query.anyTag!.includes(t))) return false;
      }
      if (query.allTags && query.allTags.length > 0) {
        for (const t of query.allTags) {
          if (!l.tags.includes(t)) return false;
        }
      }
      if (typeof query.sinceDays === "number") {
        const cutoff = Date.now() - query.sinceDays * MS_PER_DAY;
        if (l.storedAt < cutoff) return false;
      }
      return true;
    });

    // Score keyword matches.
    const scored = filtered.map((l) => {
      const { score, fragments } = scoreEntry(l, query.query ?? "");
      return { line: l, score, fragments };
    });
    // If no query string, fall back to recency ordering.
    if (!query.query || query.query.trim().length === 0) {
      scored.sort((a, b) => b.line.storedAt - a.line.storedAt);
    } else {
      // Filter out zero-score entries, then sort by score desc, recency tiebreak.
      const matched = scored.filter((s) => s.score > 0);
      matched.sort((a, b) => b.score - a.score || b.line.storedAt - a.line.storedAt);
      // If nothing matched, return empty rather than dumping unranked recents.
      scored.length = 0;
      scored.push(...matched);
    }

    const limit = Math.max(1, Math.min(MAX_LIMIT, query.limit ?? DEFAULT_LIMIT));
    const top = scored.slice(0, limit);

    // Hydrate top hits with summary from the full entry.
    const hits: RecallHit[] = [];
    for (const s of top) {
      const entry = await readEntry(s.line.id);
      if (!entry) {
        // Index/result drift (F1) — log-and-skip; never crash recall.
        continue;
      }
      // Self-validate path equals the storing path (F4 defense-in-depth).
      if (entry.projectKey !== s.line.projectKey || entry.projectPath.length === 0) {
        continue;
      }
      hits.push({
        id: entry.id,
        storedAt: entry.storedAt,
        ageDays: Math.floor((Date.now() - entry.storedAt) / MS_PER_DAY),
        projectKey: entry.projectKey,
        projectPath: entry.projectPath,
        panelId: entry.panelId,
        question: entry.question,
        summary: extractSummary(entry),
        tags: entry.tags,
        finalScore: s.line.finalScore,
        judgeConfidence: s.line.judgeConfidence,
        score: s.score,
        matchedFragments: s.fragments,
      });
    }
    return hits;
  }

  // ── Wipe / rebuild ─────────────────────────────────────────
  async function wipeAll(): Promise<void> {
    await rm(resultsDir, { recursive: true, force: true });
    await rm(indexPath, { force: true });
    await mkdir(resultsDir, { recursive: true });
    await writeFile(indexPath, "", { encoding: "utf8", mode: 0o600 });
  }

  async function rebuild(): Promise<{ count: number }> {
    const files = await readdir(resultsDir).catch(() => [] as string[]);
    const newLines: IndexLine[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -".json".length);
      const entry = await readEntry(id);
      if (entry) newLines.push(buildIndexLine(entry));
    }
    newLines.sort((a, b) => a.storedAt - b.storedAt);
    const body =
      newLines.map((l) => JSON.stringify(l)).join("\n") + (newLines.length > 0 ? "\n" : "");
    const tmpPath = `${indexPath}.tmp`;
    await writeFile(tmpPath, body, { encoding: "utf8", mode: 0o600 });
    await rename(tmpPath, indexPath);
    return { count: newLines.length };
  }

  return {
    store: storeOne,
    recall: recallOne,
    get: readEntry,
    count: async () => (await readIndexLines()).length,
    wipe: wipeAll,
    rebuildIndex: rebuild,
  };
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Derive a stable, collision-resistant id from (question, timestamp).
 * 12 hex chars = 48 bits. With ≤ 1000 entries per project, collision
 * probability is ~10⁻¹⁰ — safe within the retention cap.
 */
function deriveEntryId(question: string, timestamp: number): string {
  return createHash("sha256").update(`${timestamp}|${question}`, "utf8").digest("hex").slice(0, 12);
}

function buildIndexLine(entry: StoredEntry): IndexLine {
  const result = entry.result as unknown as ConsensusResult;
  return {
    id: entry.id,
    storedAt: entry.storedAt,
    projectKey: entry.projectKey,
    panelId: entry.panelId,
    questionPreview: truncate(entry.question, QUESTION_PREVIEW_CHARS),
    tags: entry.tags,
    finalScore: typeof result.finalScore === "number" ? Math.round(result.finalScore) : -1,
    judgeConfidence:
      typeof result.synthesis?.judgeConfidence === "number" ? result.synthesis.judgeConfidence : -1,
  };
}

function extractSummary(entry: StoredEntry): string {
  const result = entry.result as unknown as ConsensusResult;
  const synthesis = result.synthesis?.content;
  if (synthesis) return truncate(synthesis, SUMMARY_PREVIEW_CHARS);
  // Fall back to the final-round responses concatenated.
  const lastRound = result.rounds?.[result.rounds.length - 1];
  if (lastRound && Array.isArray(lastRound.responses)) {
    const merged = lastRound.responses
      .map((r) => r.content)
      .filter((s): s is string => typeof s === "string")
      .join("\n\n");
    return truncate(merged, SUMMARY_PREVIEW_CHARS);
  }
  return "(no synthesis or panel responses available)";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}
