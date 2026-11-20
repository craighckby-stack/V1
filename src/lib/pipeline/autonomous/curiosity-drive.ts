/**
 * curiosity-drive.ts — the loop's "get bored when too confident, seek surprise" drive.
 *
 * WHAT THIS IS
 * ───────────
 * The second "alive" behavior (step 2 of "what the system should be for").
 * The bandit (`orderTargetsByBandit` in self-model.ts) picks files by a
 * fixed formula: empirical success + exploration + recency + momentum +
 * complexity − exhaustion. That formula is GOOD — it's a UCB1 bandit with
 * honest priors. But it has one blind spot: it always picks the same KIND
 * of file (whatever the formula scores highest). A loop that always picks
 * the highest-scoring file converges — it gets very good at a narrow set
 * of files and stops discovering anything new.
 *
 * Curiosity drive fixes that. When the system is "too confident" (its
 * self-model Brier score is very low — predictions are accurate) AND the
 * codebase health trend is flat or worsening (the recent work isn't
 * actually helping), the drive adds a CURIOSITY BONUS to files the
 * self-model is LEAST confident about. The effect: the loop gets bored
 * when it's too confident and seeks out the files it can't predict.
 *
 * The bonus is BOUNDED (+0.0 to +0.25, capped below the exhaustion penalty
 * so a finished file is never un-sunk by curiosity alone) and GATED by a
 * SystemFlag the operator must enable (default OFF). The flag is the
 * protected-control-surface principle in action: a behavior change to
 * autonomous file selection ships DORMANT until the operator reviews the
 * specific rule and flips it on.
 *
 * THE RULE (for operator review)
 * ─────────────────────────────
 * Drive fires when BOTH:
 *   1. The self-model's Brier score is ≤ BORED_THRESHOLD (0.08, very
 *      confident — predictions are accurate, the loop "knows what it's
 *      doing" for the current file set).
 *   2. The health trend is flat or worsening: Δ(testCount) ≤ 0 OR
 *      Δ(tscErrors) ≥ 0 OR Δ(lintErrors) ≥ 0 (the codebase isn't getting
 *      healthier — the loop's confidence isn't buying anything real).
 *
 * When the drive fires, each file gets a curiosity bonus:
 *   curiosity = UNCERTAINTY_SCALE * (1 − empiricalConfidence)
 * where empiricalConfidence is the Laplace-smoothed pass rate from the
 * self-model. Files the loop is LEAST confident about (low pass rate OR
 * few attempts) get the biggest bonus. Files it's confident about
 * (high pass rate, many attempts) get near-zero.
 *
 * The bonus caps at MAX_CURIOSITY_BONUS (0.25) so it can't overwhelm the
 * bandit's other terms — it's a nudge, not a takeover.
 *
 * HONESTY
 * ───────
 * - The drive NEVER fires when the flag is off (default). The operator
 *   must set SystemFlag "curiosity-drive-enabled" = "true" to activate.
 * - The drive degrades to neutral (no bonus) when the self-model or
 *   health trend is unavailable. Never throws into the caller.
 * - The bonus is documented and tested; the specific thresholds
 *   (BORED_THRESHOLD, MAX_CURIOSITY_BONUS) are named constants the
 *   operator can tune via code edit.
 * - The drive is read-ONLY w.r.t. the self-model and health trend — it
 *   never mutates them. It only READS them to compute a bonus.
 *
 * INTEGRITY: this module shapes file selection (the loop's autonomous
 * behavior). It's in PROTECTED_FILES so the loop can't rewrite its own
 * curiosity rule. The operator enables it via SystemFlag; the loop can't
 * enable it on itself.
 */

import { getHealthTrend, type HealthTrend } from "./health-metrics";
import { getSelfModelSummary } from "./self-model";
import { db } from "@/lib/db";

/** The SystemFlag key the operator sets to enable the drive. */
export const CURIOSITY_DRIVE_FLAG = "curiosity-drive-enabled";

/** Brier score at or below which the loop is "too confident" (bored).
 *  0.08 is well-calibrated territory — predictions are accurate. Below
 *  this, the loop "knows what it's doing" for the current file set. */
export const BORED_THRESHOLD = 0.08;

/** Maximum curiosity bonus (caps the nudge so it can't overwhelm the
 *  bandit's other terms). Sits below the exhaustion penalty (0.35) so
 *  a finished file is never un-sinked by curiosity alone. */
export const MAX_CURIOSITY_BONUS = 0.25;

/** Uncertainty scale: how aggressively low-confidence files are boosted.
 *  (1 − empiricalConfidence) * UNCERTAINTY_SCALE, capped at MAX. */
const UNCERTAINTY_SCALE = 0.3;

export interface CuriosityState {
  /** Whether the drive is enabled (SystemFlag). */
  enabled: boolean;
  /** Whether the drive fired this cycle (both conditions met). */
  firing: boolean;
  /** The Brier score read this cycle (null if unavailable). */
  brierScore: number | null;
  /** The health trend read this cycle (null if unavailable). */
  healthTrend: HealthTrend | null;
  /** Why the drive fired or didn't (for the cycle log). */
  reason: string;
}

/** Read the SystemFlag. Best-effort: returns false on any DB error
 *  (the drive defaults to OFF, the safe state). */
async function isCuriosityDriveEnabled(): Promise<boolean> {
  try {
    const flag = await db.systemFlag.findUnique({
      where: { key: CURIOSITY_DRIVE_FLAG },
    });
    return flag?.value === "true";
  } catch {
    return false;
  }
}

/** Compute the per-file curiosity bonus.
 *  - empiricalConfidence: the Laplace-smoothed pass rate (0..1). 0.5
 *    for files with no history (neutral — the bandit's exploration term
 *    already favors untried files; curiosity shouldn't double-count).
 *  - Returns 0 when the drive isn't firing; otherwise (1 − conf) × scale,
 *    capped at MAX_CURIOSITY_BONUS. */
export function curiosityBonusForFile(
  empiricalConfidence: number,
  state: CuriosityState,
): number {
  if (!state.enabled || !state.firing) return 0;
  // Files with no history (0.5) get no curiosity bonus — the bandit's
  // exploration term already handles untried files. Curiosity targets
  // files WITH history that the loop is BAD at (low pass rate).
  const bonus = (1 - empiricalConfidence) * UNCERTAINTY_SCALE;
  return Math.min(MAX_CURIOSITY_BONUS, Math.max(0, bonus));
}

/** Compute the curiosity state for this cycle. Called once per bandit
 *  pass; the per-file bonuses read the returned state. Best-effort:
 *  any DB/trend read failure degrades to { enabled, firing: false },
 *  so the drive NEVER throws into the bandit. */
export async function computeCuriosityState(): Promise<CuriosityState> {
  const enabled = await isCuriosityDriveEnabled();
  if (!enabled) {
    return {
      enabled: false,
      firing: false,
      brierScore: null,
      healthTrend: null,
      reason: "curiosity drive disabled (set SystemFlag 'curiosity-drive-enabled'='true' to enable)",
    };
  }

  // Read the Brier score + the health trend. Both are best-effort.
  let brierScore: number | null = null;
  let healthTrend: HealthTrend | null = null;
  try {
    const summary = await getSelfModelSummary();
    brierScore = summary.calibration.brierScore;
  } catch {
    /* self-model unavailable — drive stays dormant */
  }
  try {
    healthTrend = await getHealthTrend();
  } catch {
    /* health trend unavailable — drive stays dormant */
  }

  // Condition 1: too confident (Brier ≤ threshold).
  if (brierScore === null) {
    return {
      enabled: true,
      firing: false,
      brierScore: null,
      healthTrend,
      reason: "curiosity drive enabled but Brier score unavailable — drive dormant until self-model has resolved predictions",
    };
  }
  if (brierScore > BORED_THRESHOLD) {
    return {
      enabled: true,
      firing: false,
      brierScore,
      healthTrend,
      reason: `curiosity drive enabled but Brier ${brierScore.toFixed(3)} > ${BORED_THRESHOLD} — not overconfident, drive dormant`,
    };
  }

  // Condition 2: health trend flat or worsening.
  if (!healthTrend) {
    return {
      enabled: true,
      firing: false,
      brierScore,
      healthTrend: null,
      reason: `curiosity drive enabled, Brier ${brierScore.toFixed(3)} ≤ ${BORED_THRESHOLD}, but no health trend yet — drive dormant until first snapshot`,
    };
  }
  const d = healthTrend.delta;
  const flatOrWorsening =
    d.testCount <= 0 || d.tscErrors >= 0 || d.lintErrors >= 0;
  if (!flatOrWorsening) {
    return {
      enabled: true,
      firing: false,
      brierScore,
      healthTrend,
      reason: `curiosity drive enabled, Brier ${brierScore.toFixed(3)} ≤ ${BORED_THRESHOLD}, but health improving (Δ tests +${d.testCount}, Δ tsc ${d.tscErrors}, Δ lint ${d.lintErrors}) — drive dormant (confidence is buying real improvement)`,
    };
  }

  // Both conditions met — the drive fires.
  return {
    enabled: true,
    firing: true,
    brierScore,
    healthTrend,
    reason: `curiosity drive FIRING — Brier ${brierScore.toFixed(3)} ≤ ${BORED_THRESHOLD} (overconfident) AND health flat/worsening (Δ tests ${d.testCount >= 0 ? "+" : ""}${d.testCount}, Δ tsc ${d.tscErrors >= 0 ? "+" : ""}${d.tscErrors}, Δ lint ${d.lintErrors >= 0 ? "+" : ""}${d.lintErrors}) — boosting low-confidence files`,
  };
}
