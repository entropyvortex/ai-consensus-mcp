// Codex CLI subscription oracle — not implemented. No spawn path is
// registered, and nothing here runs `codex exec --help`. A driver ships only
// after executed help shows `--sandbox read-only` (or equivalent) and a
// non-interactive approval `never`. Do not invent flag spellings.
// Config resolve refuses only a seat (participant or judge) that uses a codex
// provider; an unused codex provider entry loads and never spawns.

/** Flags the design requires in executed `codex exec --help` before a driver ships. */
export const CODEX_REQUIRED_GATE_FLAGS = ["--sandbox read-only", "approval never"] as const;

/** Resolve-time refusal for a seat that would run on a codex provider. */
export function codexDriverRefusalMessage(providerId: string, seatId: string): string {
  return (
    `ai-consensus-mcp: codex driver is not yet implemented: its oracle flags (${CODEX_REQUIRED_GATE_FLAGS.join(", ")}) ` +
    `have not been verified against "codex exec --help". Provider "${providerId}" is used by "${seatId}"; ` +
    "move that seat to a grok, claude, or HTTP provider."
  );
}
