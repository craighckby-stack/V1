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
 *  v5 (operator-directed, 2026-11-17): RE-EXPANDED to include
 *  `src/components/pipeline` (the LOOP display panels — oracle,
 *  self-model, defense, branches, merge-back, gemini, nvidia, etc.).
 *  The v4 rollback was justified by quota churn; the v5 re-expansion is
 *  justified by TWO new friction layers that did not exist at v4:
 *    1. The operator-PIN gate on the saturation [unlock] buttons (see
 *       README "Why it can't go rogue → The unlock PIN"). A careless
 *       user can no longer mash [unlock] on every locked display panel
 *       to re-open the churn — each re-unlock now requires the
 *       read-the-manual PIN. This was the v4 hazard (converged files
 *       kept getting re-unlocked); the PIN closes it.
 *    2. The convergent-move guard (mutation-guard.ts detectConvergentMove)
 *       now rejects the exact "Added input validation for <prop>"
 *       defensive no-ops that made v3 churn 88% waste — at the guard
 *       layer, before the debate LLM call.
 *  `src/components/ui` (the 69 vendored shadcn primitives) STAYS
 *  EXCLUDED — the loop has no business polishing vendored third-party
 *  code. Only the LOOP-authored display panels under
 *  `src/components/pipeline` are re-added. The two control-surface
 *  components inside that subtree (api-unlock.tsx — the auth-prompt UI
 *  half of the middleware gate; boot-splash.tsx — the click-intercept
 *  entry ceremony) are listed individually in PROTECTED_FILES so the
 *  loop still can't touch its own auth UI or its own boot entry.
 *
 *  Everything the system IS now lives inside its own reach: the loop
 *  can enhance the routes that serve it, the display that renders it,
 *  and the pipeline logic that drives it. It can no longer touch
 *  vendored components.
 *
 *  v6 (operator-directed, 2026-11-22): EXPANDED BEYOND src/ — the loop
 *  can now enhance the mini-services that make up the rest of the
 *  running system: its own worker-process wrapper (loop-worker), the
 *  browser socket relay (loop-ws-service), and the fleet harvester.
 *  Two deliberate exclusions:
 *    - dev-watchdog is NOT in scope and is prefix-protected in
 *      protected-files.ts: it is the resurrection layer for the dev
 *      server (2-strike respawn); a bad mutation there could orphan
 *      the entire supervision chain while appearing healthy.
 *    - each service's package.json / tsconfig.json remain blocked by
 *      the mutation-guard's SCAFFOLDING_PROTECTED_PATHS (basename
 *      match, any directory).
 *  Typecheck coverage: mini-services files are NOT in the root
 *  tsconfig program (deliberately excluded there), so
 *  in-memory-typecheck.ts builds them a SCOPED program (mutated file
 *  + bun-types + the root @types set) — see that file for why
 *  bun-types can't join the full src program. Deploy semantics differ
 *  per service: loop-worker has NO --hot (mutations inert until the
 *  next worker restart — a deliberate crash-safety property);
 *  loop-ws-service runs --hot (mutations go live on save). */
export const SCAN_SCOPES: Array<{ dir: string; extensions: string[] }> = [
  { dir: "src/lib/pipeline", extensions: [".ts"] },
  { dir: "src/app", extensions: [".ts", ".tsx"] },
  // v5 (2026-11-17): LOOP-authored display panels re-added. The 69
  // vendored shadcn primitives in src/components/ui stay excluded
  // (third-party code). Control-surface components inside this subtree
  // (api-unlock.tsx, boot-splash.tsx) are protected individually in
  // PROTECTED_FILES. The operator-PIN gate on [unlock] + the
  // convergent-move guard are the two friction layers that make this
  // safe to re-expand (see the v5 note above).
  { dir: "src/components/pipeline", extensions: [".tsx"] },
  // v6 (2026-11-22): the out-of-src expansion — see the v6 note above.
  // dev-watchdog is deliberately absent (protected-files.ts).
  { dir: "mini-services/loop-worker", extensions: [".ts"] },
  { dir: "mini-services/loop-ws-service", extensions: [".ts"] },
  { dir: "mini-services/fleet-harvester", extensions: [".ts"] },
];

/** The Prisma schema — handled as a special single-file scope. Not a
 *  directory scan; enhanceFile routes .prisma through the additive-only
 *  schema gate instead of the tsc/AST/debate chain (which don't apply
 *  to a non-TS DSL). */
export const SCHEMA_TARGET = "prisma/schema.prisma";

/** Cycles a file must show NO growth before lockout. Tunable live via
 *  MetaParam (D8 meta-tuner): the system reads this through meta-params
 *  every cycle — a value that proves itself in an A/B trial replaces the
 *  seed. Too low and a file locks out before the LLM finds the real fix;
 *  too high and we burn quota re-reviewing a file that's done.
 *
 *  Operator tightening (2026-11-17): lowered 3 → 2. After 928 cycles the
 *  self-enhance loop's yield dropped to 0.72% and ~half of its churn was
 *  no-growth rescans on already-exhausted files. Locking out one cycle
 *  earlier cuts the wasted LLM call on the third strike for files that
 *  clearly converged. The meta-tuner may still A/B this back up to 3
 *  (the clamp range is [2,6]); the operator re-tighten is the seed reset.
 *  The UI in src/app/page.tsx reads this value for the (n/N) display. */
export const SATURATION_THRESHOLD = 2;

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

/** Is this no-growth reason a DETERMINISTIC skip — one that will produce the
 *  SAME outcome every cycle because the underlying condition (file size,
 *  self-model verdict) does not change between cycles? Such locks re-lock
 *  within SATURATION_THRESHOLD cycles of an unlock unless the operator
 *  changes the underlying condition (shrinks the file, raises the size
 *  limit, retrains the self-model). The UI uses this to warn the user that
 *  clicking [unlock] on these files won't stick — it's not a broken button,
 *  it's a condition that the unlock alone can't fix.
 *
 *  Contrast with non-deterministic no-growth ("No issues found", "Rejected",
 *  "Skipped (only cosmetic"): those reflect the LLM's current verdict on
 *  the file, which CAN change pass-to-pass as the landscape evolves, so an
 *  unlock there is a genuine fresh attempt. */
export function isDeterministicSkipReason(reason: string | null): boolean {
  if (!reason) return false;
  return (
    reason.startsWith("Skipped (file too large") ||
    reason.startsWith("Skipped (file too small") ||
    reason.startsWith("Skipped (self-model predicts zero-diff")
  );
}
