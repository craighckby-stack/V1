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
        { error: "benchmark unavailable — corpus read failed or report generation returned null" },
        { status: 503 },
      );
    }
    return NextResponse.json(report);
  } catch (err: unknown) {
    let errorMessage = "An unknown error occurred during benchmark report generation.";
    let errorName = "UnknownError";
    const statusCode = 500;

    if (err instanceof Error) {
      errorMessage = err.message;
      errorName = err.name;
    } else if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: string }).message === 'string') {
      // Handle non-Error objects that might have a message property safely
      errorMessage = (err as { message: string }).message;
      errorName = 'ObjectError';
    } else {
      // Fallback for truly malformed/uninspectable errors
      errorMessage = "Received non-Error object without a discernible message.";
      errorName = 'MalformedError';
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