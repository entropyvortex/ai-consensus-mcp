// ─────────────────────────────────────────────────────────────
// Recall query scoring
// ─────────────────────────────────────────────────────────────
// Keyword-based, whole-token, case-insensitive. Returns a normalized
// score in 0..1 and the matched fragments so the caller can inspect
// why a hit ranked — premortem F9.
//
// Intentionally simple: this is a first-pass index over the question
// preview line. A future opt-in embedding ranker (Phase 2.2) plugs in
// at the same call site.

import type { IndexLine } from "./types.js";

const MIN_TOKEN_LEN = 2;
const FRAGMENT_PADDING = 30;
const MAX_FRAGMENTS = 4;

export interface ScoredEntry {
  score: number;
  fragments: string[];
}

/**
 * Score an index line against a free-form query. Score is the fraction of
 * non-trivial query tokens that appear as whole-token matches in the
 * question preview, with a small bonus for tag matches. Range 0..1.
 *
 * An empty query short-circuits to score=0; callers fall back to recency
 * ordering for the empty-query case (the store does this).
 */
export function scoreEntry(line: IndexLine, query: string): ScoredEntry {
  const tokens = tokenize(query);
  if (tokens.length === 0) return { score: 0, fragments: [] };

  const haystack = line.questionPreview.toLowerCase();
  const tagSet = new Set(line.tags.map((t) => t.toLowerCase()));

  let hits = 0;
  const fragments: string[] = [];
  for (const tok of tokens) {
    if (wholeTokenMatch(haystack, tok)) {
      hits++;
      if (fragments.length < MAX_FRAGMENTS) {
        const frag = extractFragment(line.questionPreview, tok);
        if (frag) fragments.push(frag);
      }
      continue;
    }
    if (tagSet.has(tok)) {
      hits += 0.5; // tag match is half a keyword hit
      if (fragments.length < MAX_FRAGMENTS) fragments.push(`[tag:${tok}]`);
    }
  }
  const score = Math.min(1, hits / tokens.length);
  return { score, fragments };
}

/** Lowercase whitespace-tokenize with min-length filter and dedupe. */
export function tokenize(s: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of s.toLowerCase().split(/\s+/)) {
    const t = raw.replace(/[^\p{L}\p{N}_-]+/gu, "");
    if (t.length < MIN_TOKEN_LEN) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    tokens.push(t);
  }
  return tokens;
}

/**
 * Whole-token match (premortem F9): "auth" must NOT match "author". Pads
 * the haystack with spaces and looks for the token wrapped in word-
 * boundary characters.
 */
function wholeTokenMatch(haystackLower: string, token: string): boolean {
  // Pre-tokenize the haystack into the same token alphabet as `tokenize`.
  // O(n) over haystack — short enough (question preview is ≤ 240 chars).
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}([^\\p{L}\\p{N}_-]|$)`, "u");
  return pattern.test(haystackLower);
}

/**
 * Extract a short snippet around the first whole-token occurrence of
 * `token` in the original preview. Returns "" when not found.
 */
function extractFragment(preview: string, token: string): string {
  const lower = preview.toLowerCase();
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}([^\\p{L}\\p{N}_-]|$)`, "u").exec(lower);
  if (!m) return "";
  const idx = m.index;
  const start = Math.max(0, idx - FRAGMENT_PADDING);
  const end = Math.min(preview.length, idx + token.length + FRAGMENT_PADDING + 2);
  const slice = preview.slice(start, end);
  return `${start > 0 ? "…" : ""}${slice}${end < preview.length ? "…" : ""}`;
}
