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
    if (!report) {
      return NextResponse.json(
        { error: "benchmark unavailable — corpus read failed" },
        { status: 503 },
      );
    }
    return NextResponse.json(report);
  } catch (err) {
    let errorMessage = "An unknown error occurred during benchmark report generation.";
    let errorName = "UnknownError";
    let statusCode = 500;

    if (err instanceof Error) {
      errorMessage = err.message;
      errorName = err.name;
    } else if (typeof err === 'object' && err !== null && 'message' in err) {
      // Handle cases where err is an object but not an Error instance (e.g., { message: '...' })
      errorMessage = (err as { message: string }).message;
      errorName = 'ObjectError';
    }

    // If buildBenchmarkReport throws, it's a 500 server error, as 503 is handled when report is falsy.
    return NextResponse.json(
      { error: `benchmark failed (${errorName}): ${errorMessage}` },
      { status: statusCode },
    );
  }
}