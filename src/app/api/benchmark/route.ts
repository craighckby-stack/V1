import { NextResponse } from "next/server";
import { buildBenchmarkReport } from "@/lib/pipeline/autonomous/benchmark";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/benchmark
 *
 * The #1 gap from the 10/10 list: does the complexity earn its keep?
 * A retrospective A/B over the mutation corpus — no extra LLM calls,
 * uses the data the loop already generates. Three natural experiments:
 *   1. Lessons injected (per-attempt, from lessonIdsInjected)
 *   2. Provenance digest (before/after the provenance commit)
 *   3. Active postmortem (confounded — flagged in the response)
 *
 * Read-only. Fail-soft: returns { error } on any failure. The
 * `benchmark` console command renders this for the operator.
 */
export async function GET() {
  try {
    const report = await buildBenchmarkReport();
    if (report === null) {
      // Explicitly 503 if the report generation logic returns null, indicating data unavailability.
      return NextResponse.json(
        { error: "benchmark unavailable: corpus read failed or report generation returned null" },
        { status: 503 },
      );
    }
    return NextResponse.json(report);
  } catch (err: unknown) {
    // Log the full error context server-side for debugging, safely handling unknown error types.
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("Benchmark Report Generation Failed:", errorMessage, err);

    // Return a generic, actionable error to the client to prevent leaking internal stack traces or implementation details.
    return NextResponse.json(
      { error: "Internal server error while generating benchmark report. Please check server logs for details." },
      { status: 500 },
    );
  }
}