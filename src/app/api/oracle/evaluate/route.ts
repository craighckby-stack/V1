import { NextResponse } from "next/server";
import { evaluateDueProphecies } from "@/lib/pipeline/oracle/prophecy-evaluator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/oracle/evaluate
 *
 * Trigger the Oracle's Evaluator to judge all due prophecies — pending
 * prophecies whose evaluateBy deadline has passed. The evaluator
 * gathers the evidence window for each (git log, postmortems, cycles
 * since the prophecy was made) and asks the LLM to render a verdict
 * (fulfilled | failed | retired) against the prophecy's own
 * falsifiability criterion.
 *
 * No body needed. Returns per-prophecy outcomes:
 *   {
 *     ok: true,
 *     judged: Array<{ id, claim, verdict }>,
 *     skipped: Array<{ id, claim, reason, error }>
 *   }
 *
 * "skipped" is NOT a system failure — it's the evaluator surfacing
 * prophecies it couldn't judge (LLM unavailable, unparseable response,
 * DB error). The prophecy stays pending and will be retried on the
 * next evaluation pass. The UI surfaces skipped so the operator can
 * see whether evaluations are actually happening.
 *
 * This route is the manual trigger. The eventual background wiring
 * (run evaluator every N minutes alongside the self-enhance loop) is
 * a separate concern — this endpoint just exposes the action.
 */
export async function POST() {
  try {
    const { judged, skipped } = await evaluateDueProphecies();
    return NextResponse.json({
      ok: true,
      judged,
      skipped,
      judgedCount: judged.length,
      skippedCount: skipped.length,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message, judged: [], skipped: [] },
      { status: 500 },
    );
  }
}
