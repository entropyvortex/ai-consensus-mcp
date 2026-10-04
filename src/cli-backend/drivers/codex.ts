// Codex CLI subscription oracle — refused until executed `codex exec --help`
// shows `--sandbox read-only` (or equivalent) and a non-interactive approval
// `never`. This host: `command -v codex` empty; `codex` / `codex exec --help`
// both return "command not found". No spawn path is registered. Resolve of
// `driver: "codex"` fails with the message below. Do not invent flag spellings.

/** True only when this PR ran `codex exec --help` and the gate flags matched. */
export const CODEX_ORACLE_FLAGS_VERIFIED = false;

/**
 * Gate from the design. Both must appear in executed help before a spawn path
 * ships. Named in the refusal message so the operator knows what is missing.
 */
export const CODEX_REQUIRED_GATE_FLAGS = ["--sandbox read-only", "approval never"] as const;

/**
 * Resolve-time refusal. `<bin> exec --help` is the help channel the design
 * requires; when the binary is absent that help cannot be shown, so the gate
 * flags are missing.
 */
export function codexDriverRefusalMessage(bin = "codex"): string {
  return (
    `codex driver refused: required oracle flags missing from "${bin} exec --help": ` +
    `${CODEX_REQUIRED_GATE_FLAGS.join(", ")}`
  );
}

/** Throws when Codex has no verified spawn path. Called from config resolve. */
export function assertCodexDriverAllowed(bin = "codex"): void {
  if (!CODEX_ORACLE_FLAGS_VERIFIED) {
    throw new Error(codexDriverRefusalMessage(bin));
  }
}
