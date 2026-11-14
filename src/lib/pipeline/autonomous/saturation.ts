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
 * TARGET_FILES is the FOCUS control (see below). Saturation is the churn
 * control that makes full-scope scanning safe: every file earns its own
 * lockout after 3 unproductive cycles, so a 40-file scope converges to
 * zero quota burn without human intervention.
 */

/** Files the loop is allowed to mutate — FOCUS MODE. When NON-empty,
 *  the loop only mutates files in this list (the surgical focus
 *  control). When EMPTY, the loop scans every enabled scope below
 *  (full-scope mode). Churn in full-scope mode is bounded by the
 *  saturation lockout (3 no-growth cycles per file) + the shared LLM
 *  429 gate — that pair replaced the old "empty = disabled" semantics
 *  when the scope expanded beyond one display file. */
export const TARGET_FILES: string[] = [];

/** The mutation scopes — what the loop is allowed to enhance in
 *  full-scope mode. Each entry: [directory, extensions]. The hard
 *  floor underneath is PROTECTED_FILES + PROTECTED_PREFIXES in
 *  protected-files.ts — nothing there is scannable no matter what.
 *
 *  v4 (operator-directed, 2026-11-12): ROLLED BACK `src/components`.
 *  The v3 expansion added `src/components` (94 files: 69 vendored
 *  shadcn primitives in `src/components/ui/` + 25 LOOP display
 *  components in `src/components/pipeline/`). An audit of the first
 *  10 hours of autonomous commits showed 88% of mutations on these
 *  files were convergent defensive no-ops ("Added input validation
 *  for `<prop>` to ensure it is one of the expected values" on stable
 *  shadcn primitives — the lowest-friction LLM move that passes every
 *  gate without changing observable behavior). The `src/components/ui`
 *  subtree is vendored third-party code the loop has no business
 *  polishing. `src/components/pipeline` produces more substantive
 *  diffs but is still display-layer churn, not LOOP's actual work.
 *  The operator's directive: the loop targets `src/lib/pipeline/`
 *  (the logic) and `src/app/` (the routes + display + page surface),
 *  which is where code that does LOOP's work lives. `src/app/` is a
 *  single merged scope (was `src/app/display` + `src/app/api` as
 *  separate entries); protected subtrees under `src/app/api/` are
 *  still filtered by PROTECTED_PREFIXES, so the merge changes
 *  nothing about what's protected — it just stops the loop from
 *  spending LLM quota on vendored components.
 *
 *  The convergent-move guard (mutation-guard.ts detectConvergentMove,
 *  commit 9584575) is the defense against the SAME pattern recurring
 *  in the remaining scopes — if the loop starts producing defensive
 *  no-ops on `src/lib/pipeline` files, the guard rejects them before
 *  the debate LLM call. This scope change removes the temptation at
 *  the source.
 *
 *  Everything the system IS now lives inside its own reach: the loop
 *  can enhance the routes that serve it, the display that renders it,
 *  and the pipeline logic that drives it. It can no longer touch
 *  vendored components. */
export const SCAN_SCOPES: Array<{ dir: string; extensions: string[] }> = [
  { dir: "src/lib/pipeline", extensions: [".ts"] },
  { dir: "src/app", extensions: [".ts", ".tsx"] },
  // ── Audit 9 (scope widening): the loop is mature — per-range calibrated
  // predictions, momentum-weighted targets, a probe-scored skip rule, and
  // 460+ landed mutations behind the full gate chain (mutation-guard →
  // syntax → structural → full-project typecheck → debate → test). The
  // operator asked what else it can now safely own. Four additions, each
  // verified to pass the SAME gate chain before being scoped:
  //
  // 1. ITS OWN DASHBOARD PANELS (src/components/pipeline, .tsx). The
  //    visual-polish pre-pass (every 5th cycle) already touches these;
  //    main-line scoping adds the refactor/bug-hunt treatment. page.tsx
  //    (the control surface) stays protected — the loop improves how
  //    things look and handle, never its own OFF switch.
  { dir: "src/components/pipeline", extensions: [".tsx"] },
  // 2. THE REAL-TIME + UI HOOKS (src/hooks, .ts). use-loop-socket.ts is
  //    the WebSocket wiring the console depends on; small, hot-path, and
  //    fully covered by the typecheck gate.
  { dir: "src/hooks", extensions: [".ts"] },
  // 3. ROOT UTILITIES (src/lib, .ts) — pipeline-store (the Zustand store
  //    the whole UI reads), retro-boot-audio, utils. db.ts is in
  //    PROTECTED_FILES (one mutation there breaks every db.* call site at
  //    once). Overlaps src/lib/pipeline by construction; scanFiles
  //    dedupes.
  { dir: "src/lib", extensions: [".ts"] },
  // 4. THE LOOP'S OWN HOST PROCESSES (mini-services, .ts). The worker
  //    (port 3004) IS the loop's runtime body; the ws-service (3005) is
  //    the console's real-time sidecar. Both are no-exports scripts — the
  //    structural validator handles them (dropped-export set is empty),
  //    and both were pipe-tested through verify-refactor BEFORE this
  //    scope landed (ok:true). Mutations take effect at the next respawn
  //    — the worker deliberately runs without --hot, so a landed change
  //    can NEVER abort an in-flight gate chain. A boot-breaking mutation
  //    is the one residual risk; it is loud (worker.log + the UI's worker
  //    status) and recoverable (git revert / merge-back), and the
  //    full-project typecheck makes it unlikely.
  //    Scoped PER-SERVICE, not mini-services/ wholesale — the walker's
  //    SKIP_DIRS now excludes node_modules, but per-service scoping also
  //    keeps future mini-services out until they're vetted.
  { dir: "mini-services/loop-worker", extensions: [".ts"] },
  { dir: "mini-services/loop-ws-service", extensions: [".ts"] },
];

/** The Prisma schema — handled as a special single-file scope. Not a
 *  directory scan; enhanceFile routes .prisma through the additive-only
 *  schema gate instead of the tsc/AST/debate chain (which don't apply
 *  to a non-TS DSL). */
export const SCHEMA_TARGET = "prisma/schema.prisma";

/** Cycles a file must show NO growth before lockout. EMG used 3; we keep
 *  it as the SEED. Tunable live via MetaParam (D8 meta-tuner): the
 *  system reads this through meta-params every cycle — a value that
 *  proves itself in an A/B trial replaces the seed. Too low and a file
 *  locks out before the LLM finds the real fix; too high and we burn
 *  quota re-reviewing a file that's done. */
export const SATURATION_THRESHOLD = 3;

/** The live lockout threshold (D8). Reads through the meta-params cache;
 *  resolves to the SEED before the first boot seeds the table. Kept in
 *  saturation.ts (not meta-params) so the churn-control semantics stay
 *  documented where they're enforced. */
export async function getSaturationThreshold(): Promise<number> {
  const { getMetaInt } = await import("./meta-params");
  return getMetaInt("SATURATION_THRESHOLD", SATURATION_THRESHOLD);
}

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
  if (reason.startsWith("Conflict")) return "neutral"; // audit 3: TOCTOU abort — not a verdict on the file
  // Audit 3: transient infrastructure errors (EMFILE, DB hiccup, ENOSPC)
  // are NOT a verdict on the file either — classifying them as no-growth
  // locked perfectly good files out for the rest of the pass after three
  // unlucky FS hiccups. Neutral: retry next cycle without punishment.
  if (reason.startsWith("Error")) return "neutral";
  // LLM looked and found nothing, or proposed trivial/bad change — no-growth
  if (reason === "No issues found") return "no-growth";
  if (reason.startsWith("Skipped (only cosmetic")) return "no-growth";
  if (reason.startsWith("LLM returned no code")) return "no-growth";
  if (reason.startsWith("Rejected")) return "no-growth";
  // Deterministic skip — same outcome every cycle by construction.
  // Classified as no-growth (not neutral) so a permanently-too-large file
  // actually locks out after SATURATION_THRESHOLD cycles; otherwise it
  // never locks, the loop re-tests it forever, and PASS COMPLETE can never
  // fire while such a file is in TARGET_FILES. A human shrinking the file
  // later is covered by unlock (or restart, the natural new-pass boundary).
  if (reason.startsWith("Skipped (file too large")) return "no-growth";
  // Audit 7: the self-model's proactive skip and the too-small skip are
  // no-growth verdicts by construction (the file IS finished / can't be
  // improved). Advancing the lockout counter on them is correct: a file
  // the model has converged on as "done" should lock out after a few
  // proactive skips, giving a clean PASS COMPLETE signal. Without this
  // the file would never lock (neutral default) and PASS COMPLETE could
  // never fire while such a file remained in scope.
  if (reason.startsWith("Skipped (self-model predicts zero-diff")) return "no-growth";
  if (reason.startsWith("Skipped (file too small")) return "no-growth";
  // Unknown — be conservative (don't count either way)
  return "neutral";
}
