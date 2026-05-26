// ─────────────────────────────────────────────────────────────
// Memory layer — types and storage envelope
// ─────────────────────────────────────────────────────────────
// Every persisted entry wraps a ConsensusResult in a versioned
// envelope so the layer can evolve without orphaning prior data.
// See PREMORTEM-memory-layer.md for the failure modes these
// shapes are designed against (F5 in particular).

import { z } from "zod";

/** Bump when the on-disk shape changes incompatibly. */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Stored entry shape — what lives in `results/<id>.json` on disk.
 *
 * `result` is the engine's `ConsensusResult` verbatim, validated by zod's
 * `.passthrough()` so v0.13+ additions to the engine type don't break
 * v0.12 readers (premortem F5).
 */
export const StoredEntrySchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z
    .string()
    .min(8)
    .regex(/^[a-z0-9]+$/, "id must be lowercase hex/alnum"),
  storedAt: z.number().int().nonnegative(),
  /** sha256(realpath(cwd))[0:12] — see project-key.ts. */
  projectKey: z.string().min(8),
  /** Absolute, resolved (symlinks dereferenced) project path. */
  projectPath: z.string().min(1),
  /** Panel id this run used. `"consensus"` for raw generic-tool runs. */
  panelId: z.string().min(1),
  question: z.string().min(1),
  /** Free-form indexing tags. May include panel meta tags. */
  tags: z.array(z.string().min(1)).default([]),
  /**
   * Full ConsensusResult — typed loosely so future engine-side additions to
   * the result shape don't break v0.12 readers (premortem F5). Callers cast
   * to `ConsensusResult` at the use site.
   */
  result: z.record(z.string(), z.unknown()),
});

export type StoredEntry = z.infer<typeof StoredEntrySchema>;

/**
 * Index line shape — the slim record we keep in `index.jsonl` so recall
 * can filter without loading every full result. ~200 bytes per row.
 */
export const IndexLineSchema = z.object({
  id: z.string().min(8),
  storedAt: z.number().int().nonnegative(),
  projectKey: z.string().min(8),
  panelId: z.string().min(1),
  /** Question, truncated to 240 chars for the in-line preview. */
  questionPreview: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  /** Final consensus score, if available. -1 when absent. */
  finalScore: z.number().int(),
  /** Self-reported judge confidence (0-100). -1 when no judge synthesis. */
  judgeConfidence: z.number().int(),
});

export type IndexLine = z.infer<typeof IndexLineSchema>;

// ── Recall query / result shapes ──────────────────────────────

/**
 * Query passed to `MemoryStore.recall`. Every filter is optional; an empty
 * query returns all entries for the project (subject to `limit`).
 */
export interface RecallQuery {
  /**
   * Free-form text. Tokens are split on whitespace and matched against the
   * stored question + judge synthesis. Case-insensitive, whole-token only
   * (no fuzzy match by default — see premortem F9).
   */
  query?: string;
  /** Restrict to one panel id. */
  panelId?: string;
  /** Restrict to entries that have at least one of these tags. */
  anyTag?: readonly string[];
  /** Restrict to entries with all of these tags. */
  allTags?: readonly string[];
  /** Only entries stored within the last N days. */
  sinceDays?: number;
  /** Maximum results to return (default 20, bounded to [1, 200]). */
  limit?: number;
  /**
   * Cross-project recall. When `false` (default), recall is filtered to the
   * current project key — premortem F4. Setting `true` requires the caller
   * to have explicitly opted in.
   */
  acrossProjects?: boolean;
}

/**
 * One result from recall. Includes the matched fragment so the caller can
 * eyeball relevance — premortem F9.
 */
export interface RecallHit {
  id: string;
  storedAt: number;
  ageDays: number;
  projectKey: string;
  projectPath: string;
  panelId: string;
  question: string;
  /** Truncated panel synthesis content or judge synthesis. */
  summary: string;
  tags: readonly string[];
  finalScore: number;
  judgeConfidence: number;
  /** Recall score (0-1). Higher = better match. */
  score: number;
  /**
   * Matched fragment(s) — the substrings that contributed to the score.
   * Surfaced so the caller can sanity-check whether the match is meaningful.
   */
  matchedFragments: readonly string[];
}

// ── Config additions ─────────────────────────────────────────

/**
 * Memory-layer config block. Lives under `memory` in `consensus.config.json`.
 * All fields optional; `enabled` defaults to false (premortem F10).
 */
export const MemoryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    /**
     * Absolute path to the storage root. Defaults to
     * `~/.consensus/memory/<projectKey>/`. When set, the value is taken
     * verbatim — the layer does not append the projectKey automatically,
     * so a single root can be shared if the user really wants that.
     */
    storagePath: z.string().min(1).optional(),
    /**
     * Optional explicit project path. When unset, defaults to the server's
     * cwd at startup. Setting this is the right call when running the MCP
     * server as a long-lived background process whose cwd isn't the user's
     * actual project (e.g. systemd unit, launchd plist).
     */
    projectPath: z.string().min(1).optional(),
    retention: z
      .object({
        maxResults: z.number().int().positive().optional(),
        maxAgeDays: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/**
 * Resolved memory config — the runtime shape after defaults are applied.
 * Distinct from the on-disk shape so callers can rely on every field
 * being set.
 */
export interface ResolvedMemoryConfig {
  enabled: boolean;
  storageRoot: string;
  maxResults: number;
  maxAgeDays: number;
}

export const DEFAULT_RETENTION = {
  maxResults: 1000,
  maxAgeDays: 365,
} as const;
