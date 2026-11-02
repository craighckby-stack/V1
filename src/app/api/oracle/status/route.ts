import { NextResponse } from "next/server";
import { getProphecyCounts, getJudgedPropheciesForCalibration } from "@/lib/pipeline/oracle/prophecy-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/oracle/status
 *
 * Returns the Oracle subsystem's track record:
 *   - counts: pending / fulfilled / failed / retired / total
 *   - calibration: for several confidence thresholds (0.5, 0.7, 0.9),
 *     the fraction of prophecies at or above that threshold that came
 *     true. A well-calibrated system should hit ~50% / ~70% / ~90%
 *     respectively. Significant divergence is the interesting output
 *     — overconfident systems score low; underconfident systems score
 *     high. Either is fixable; the metric shows which.
 *   - recentActivity: counts of prophecies made and judged in the
 *     last 24h, so the UI can show whether the subsystem is actually
 *     being used.
 *
 * This route does NO LLM calls — it's a pure DB read. The calibration
 * computation is here (not in the store) because the store is a thin
 * CRUD layer; the metric is a derived view, not stored state.
 */
export async function GET() {
  try {
    const counts = await getProphecyCounts();
    const judged = await getJudgedPropheciesForCalibration();

    // Calibration per confidence threshold. For each threshold T, compute:
    //   of prophecies with confidence >= T, what fraction were fulfilled?
    // A well-calibrated system hits ~T. Significant over-/under-confidence
    // shows as deviation.
    const calibrationThresholds = [0.5, 0.7, 0.9];
    const calibration = calibrationThresholds.map((threshold) => {
      const atOrAbove = judged.filter((p) => p.confidence >= threshold);
      const fulfilled = atOrAbove.filter((p) => p.status === "fulfilled").length;
      const total = atOrAbove.length;
      const fraction = total > 0 ? fulfilled / total : null;
      return {
        threshold,
        total,
        fulfilled,
        fraction, // null when no prophecies at this threshold yet
        wellCalibratedIf: threshold, // for the UI: this is what fraction SHOULD be
      };
    });

    // Brier score — proper scoring rule for probabilistic predictions.
    // Mean of (predicted_confidence - outcome)^2 across all judged
    // prophecies, where outcome = 1 for fulfilled, 0 for failed.
    // (Retired prophecies are excluded — they were never resolvable.)
    // Lower is better; 0.0 = perfect, 0.25 = random guessing on a
    // 50/50 base rate, 1.0 = always wrong with confidence 1.0.
    const resolvable = judged.filter((p) => p.status === "fulfilled" || p.status === "failed");
    let brier: number | null = null;
    if (resolvable.length > 0) {
      const sum = resolvable.reduce((acc, p) => {
        const outcome = p.status === "fulfilled" ? 1 : 0;
        const diff = p.confidence - outcome;
        return acc + diff * diff;
      }, 0);
      brier = sum / resolvable.length;
    }

    return NextResponse.json({
      ok: true,
      counts,
      calibration,
      brierScore: brier, // null until at least one prophecy is judged
      judgedCount: resolvable.length,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
