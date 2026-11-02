/**
 * Per-file saturation tracking — the "lockout" mechanism adapted from
 * EMG's self-stopping concept for a SINGLE pipeline module at a time.
 *
 * Phase 1 of the incremental rollout: one display file, mutated until
 * stable, locked out, visible to the user. This is the entry point that
 * earns the right to expand to N files.
 *
 * What "saturated" means here (the no-growth signals):
 *   - LLM returned "No issues found" — it saw nothing to improve
 *   - Skipped (cosmetic-only change) — it proposed something trivial
 *   - Rejected by gate (typecheck/debate/test) — it proposed something bad
 *
 * What does NOT count as no-growth:
 *   - Deferred (LLM cooldown) — quota pause, not a progress signal
 *   - LLM unavailable / network error — transient, not a verdict on the file
 *   - Enhanced — growth (resets the counter)
 *
 * After SATURATION_THRESHOLD (3) consecutive no-growth cycles on a file,
 * the file is LOCKED OUT for the rest of the pass. The user reviews the
 * lockout in the UI and can unlock it for the next pass. Lockout is a
 * checkpoint, not a tombstone — a file that's stable today might unlock
 * new improvements next pass when the landscape has changed.
 *
 * The TARGET_FILES allowlist is the "focus" control. When non-empty,
 * the loop only mutates files in this list. Phase 1 = one entry. Phase 2+
 * = more entries. Default: the live-visible display file.
 */

/** Files the loop is allowed to mutate. When empty, the loop is disabled
 *  (we never want it scanning ALL pipeline files unsupervised — that was
 *  the unbounded-churn regime that burned quota). Add a path here to
 *  "focus" the loop on that file. Paths are repo-relative
 *  (e.g. "src/app/display/console-stream.tsx"). */
export const TARGET_FILES: string[] = [
  "src/app/display/console-stream.tsx",
];

/** Cycles a file must show NO growth before lockout. EMG used 3; we keep
 *  it. Tunable: too low and a file locks out before the LLM finds the real
 *  fix; too high and we burn quota re-reviewing a file that's done. */
export const SATURATION_THRESHOLD = 3;

/** Per-file saturation state. Persisted in memory only (not the DB) —
 *  lockout is per-pass, resets on server restart, which is fine: a restart
 *  is a natural "new pass" boundary. */
export interface FileSaturation {
  /** Consecutive cycles where this file showed no growth. Reset to 0 on
   *  any enhancement or on an explicit user unlock. */
  consecutiveNoGrowth: number;
  /** True once the file hit SATURATION_THRESHOLD. Stays true until the
   *  user unlocks it (or the server restarts). A locked file is skipped
   *  by runCycle — no LLM calls, no quota burn, no churn. */
  lockedOut: boolean;
  /** When the file was locked out (ISO string). UI shows "locked Xm ago". */
  lockedAt: string | null;
  /** Last reason the file was deferred/rejected/no-growth. UI shows it
   *  so the user knows WHY the system gave up on this file. */
  lastNoGrowthReason: string | null;
  /** Total enhancements this pass (for the UI's per-file progress display).
   *  Resets on unlock. */
  enhancementsThisPass: number;
}

/** The full saturation state, keyed by repo-relative file path. Exposed
 *  by the status API so the UI can render the lockout panel. */
export type SaturationMap = Record<string, FileSaturation>;

/** Classify an enhance result's reason as "growth", "no-growth", or
 *  "neutral" (quota/transient — don't count either way). Used by runCycle
 *  to update the saturation counter. */
export type GrowthClassification = "growth" | "no-growth" | "neutral";

export function classifyGrowth(reason: string): GrowthClassification {
  // Enhancement — growth (resets counter)
  if (reason.startsWith("Enhanced")) return "growth";
  // Quota / transient — neutral (don't punish the file for API limits).
  // NOTE: this deliberately includes "Deferred (debate tribunal
  // unavailable...)" — the fail-closed defer design treats an unavailable
  // tribunal as a transient condition: the file is retried when the
  // tribunal can actually run, so it is NOT a verdict on the file. (The
  // old line classifying it as no-growth was dead code — unreachable
  // under this prefix — and contradicted the defer design.)
  if (reason.startsWith("Deferred")) return "neutral";
  if (reason.startsWith("LLM unavailable")) return "neutral";
  if (reason.startsWith("Stopped")) return "neutral";
  // LLM looked and found nothing, or proposed trivial/bad change — no-growth
  if (reason === "No issues found") return "no-growth";
  if (reason.startsWith("Skipped (only cosmetic")) return "no-growth";
  if (reason.startsWith("LLM returned no code")) return "no-growth";
  if (reason.startsWith("Rejected")) return "no-growth";
  if (reason.startsWith("Error")) return "no-growth";
  // Deterministic skip — same outcome every cycle by construction.
  // Classified as no-growth (not neutral) so a permanently-too-large file
  // actually locks out after SATURATION_THRESHOLD cycles; otherwise it
  // never locks, the loop re-tests it forever, and PASS COMPLETE can never
  // fire while such a file is in TARGET_FILES. A human shrinking the file
  // later is covered by unlock (or restart, the natural new-pass boundary).
  if (reason.startsWith("Skipped (file too large")) return "no-growth";
  // Unknown — be conservative (don't count either way)
  return "neutral";
}
