import { NextResponse } from "next/server";
import { getSelfModelSummary } from "@/lib/pipeline/autonomous/self-model";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Self-Model status — the loop's measured self-knowledge (audit 7).
 *
 * Exposes the three cognitive surfaces wired in audit 7:
 *   1. PER-FILE SELF-KNOWLEDGE — every file's pass/fail/zero-diff counts,
 *      finished-score, last outcome. The bandit reads this to decide
 *      what to work on.
 *   2. CALIBRATION CURVE — 10 confidence buckets (0.0-0.1 ... 0.9-1.0),
 *      each with predicted vs actual pass rate, plus a Brier score and
 *      a plain-language verdict ("well-calibrated" / "OVERCONFIDENT" /
 *      "UNDERCONFIDENT"). Built from resolved self-predictions.
 *   3. MODE STATS — refactor vs visual-polish attempt/pass counts.
 *
 * Lives under /api/self-model/ (NOT /api/self-enhance/) so it's NOT in
 * PROTECTED_PREFIXES — the loop CAN enhance the route that exposes its
 * own cognition. (The self-model logic itself in self-model.ts is in
 * PROTECTED_FILES and can't be rewritten by the loop — the loop can't
 * lie about its own track record.)
 *
 *   GET → { files, calibration, modeStats, totals }
 *   POST { force? } → same (bootstrap is idempotent; force re-runs it)
 */
const ERROR_RESPONSE_BASE = {
  files: [],
  calibration: { buckets: [], resolvedPredictions: 0, pendingPredictions: 0, brierScore: null, reliability: null, verdict: "error" },
  modeStats: { refactor: { attempts: 0, passes: 0 }, visualPolish: { attempts: 0, passes: 0 } },
  totals: { attempts: 0, passes: 0, fails: 0, zeroDiffs: 0 },
};

const createErrorResponse = (message: string, status: number = 500) => {
  return NextResponse.json(
    { ...ERROR_RESPONSE_BASE, error: message },
    { status }
  );
};

export async function GET() {
  try {
    const summary = await getSelfModelSummary();
    return NextResponse.json(summary);
  } catch (err) {
    const errorMessage = (err instanceof Error ? err.message : "An unknown error occurred while fetching self-model summary.");
    return createErrorResponse(`Failed to retrieve self-model summary: ${errorMessage}`);
  }
}

export async function POST(req: Request) {
  let force = false;
  let body: { force?: boolean } | null = null;

  try {
    // Use req.json() for idiomatic Next.js API route body parsing
    body = await req.json();
  } catch {
    // Handles JSON parsing errors (e.g., invalid JSON, non-JSON body)
    return NextResponse.json(
      { error: "Invalid request body: Body must be valid JSON." },
      { status: 400 }
    );
  }

  // Validate body is an object (req.json() ensures it's not null if successful, but check type)
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json(
      { error: "Request body must be a non-null object." },
      { status: 400 }
    );
  }

  // Validate force parameter if present
  if ('force' in body) {
    if (typeof body.force !== 'boolean') {
      return NextResponse.json(
        { error: "Force parameter must be a boolean." },
        { status: 400 }
      );
    }
    force = body.force;
  }

  if (force) {
    try {
      const { bootstrapSelfModel } = await import("@/lib/pipeline/autonomous/self-model");
      await bootstrapSelfModel();
    } catch (bootstrapError) {
      // Log bootstrap failure with context and return an error response
      const errorToLog = bootstrapError instanceof Error ? bootstrapError : new Error(String(bootstrapError));
      console.error("Failed to bootstrap self-model during POST operation:", errorToLog);
      return NextResponse.json(
        { error: `Failed to bootstrap self-model: ${errorToLog.message}` },
        { status: 500 }
      );
    }
  }

  // Fetch summary once after potential bootstrap.
  try {
    const summary = await getSelfModelSummary();
    return NextResponse.json(summary);
  } catch (err) {
    const errorMessage = (err instanceof Error ? err.message : "An unknown error occurred while fetching self-model summary after POST operation.");
    return createErrorResponse(`Failed to retrieve self-model summary after POST operation: ${errorMessage}`);
  }
}