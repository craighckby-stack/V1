import { NextResponse } from "next/server";
import { getPassRateTrend } from "@/lib/pipeline/autonomous/mutation-corpus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/self-enhance/pass-rate-trend
 *
 * The "is compounding compounding?" view: the mutation pass rate over
 * time, derived from the mutation corpus.
 *
 * The meta-tuner computes pass-rate windows internally to accept/reject
 * its parameter trials, and boot/scan reports lifetime totals — but
 * nothing surfaced the TREND to the operator. This endpoint does, from
 * the same corpus the distiller and the negative-constraint block read.
 *
 * Denominator honesty: only RESOLVABLE attempts count (enhanced vs the
 * five gate-rejection outcomes). Deferred / no-change / cosmetic /
 * llm-unavailable rows are non-attempts and are excluded — a quota
 * drought must not read as a quality decline.
 *
 * Returns the full PassRateTrend:
 *   - overallPassRate  — over all resolvable attempts in the lookback
 *   - lastWindow       — the headline: the last ≤20 resolvable attempts
 *   - trend            — improving | declining | flat | insufficient
 *                        (second-half rate minus first-half; ±10pp bar;
 *                        "insufficient" when the halves are too small)
 *   - buckets          — chronological 10-attempt buckets for plotting
 *
 * Pure DB read, no LLM calls. Corpus unreadable → { ok: false } with
 * 200 (the UI renders "UNREADABLE", same honesty rule as every vital).
 */
export async function GET() {
  try {
    const trend = await getPassRateTrend();
    if (!trend) {
      return NextResponse.json(
        { ok: false, reason: "Mutation corpus unreadable — pass rate unknown." },
        { status: 200 }
      );
    }
    return NextResponse.json({ ok: true, ...trend });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
