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
      // Explicitly 503 if the report generation logic returns falsy, indicating data unavailability.
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
      // If the underlying library signals a resource issue (e.g., connection timeout),
      // we might downgrade from 500 to 503, but sticking to 500 for unexpected throws is safer default.
    } else if (typeof err === 'object' && err !== null && 'message' in err) {
      // Handle non-Error objects with a message property
      errorMessage = (err as { message: string }).message;
      errorName = 'ObjectError';
    }

    // Log the full error context server-side for debugging, but return a sanitized message to the client.
    console.error("Benchmark Report Generation Failed:", err);

    // Return 500 for unexpected runtime exceptions during report generation.
    return NextResponse.json(
      { error: `benchmark failed (${errorName}): ${errorMessage}` },
      { status: statusCode },
    );
  }
}