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
export async function GET() {
  try {
    const summary = await getSelfModelSummary();
    return NextResponse.json(summary);
  } catch (err) {
    const errorMessage = (err as Error).message || "An unknown error occurred while fetching self-model summary.";
    return NextResponse.json(
      { 
        files: [], 
        calibration: { buckets: [], resolvedPredictions: 0, pendingPredictions: 0, brierScore: null, reliability: null, verdict: "error" }, 
        modeStats: { refactor: { attempts: 0, passes: 0 }, visualPolish: { attempts: 0, passes: 0 } }, 
        totals: { attempts: 0, passes: 0, failss: 0, zeroDiffs: 0 }, 
        error: `Failed to retrieve self-model summary: ${errorMessage}` 
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  let force = false;
  try {
    if (!(req instanceof Request)) {
        throw new Error("Invalid Request object provided to POST handler.");
    }
    const body = await req.json();
    if (typeof body === 'object' && body !== null && 'force' in body && typeof body.force === 'boolean') {
      force = body.force;
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("Invalid Request object")) {
        // Re-throw specific validation error
        throw e;
    }
    // Empty body or invalid JSON is acceptable, force remains false.
    // No action needed, proceed with default force=false.
  }

  if (force) {
    try {
      const { bootstrapSelfModel } = await import("@/lib/pipeline/autonomous/self-model");
      // The module-level `bootstrapped` guard prevents re-running even
      // with force — but a fresh import in dev (Turbopack re-eval) gives
      // a fresh module scope, so force works after a server-side re-eval.
      // In a long-running process without re-eval, force is a no-op
      // (the model already has rows). Both are safe.
      await bootstrapSelfModel().catch(() => {});
    } catch (bootstrapError) {
      // Log or handle bootstrap failure but allow summary retrieval to proceed if possible
      console.error("Failed to bootstrap self-model:", bootstrapError);
    }
  }
  
  try {
    const summary = await getSelfModelSummary();
    return NextResponse.json(summary);
  } catch (err) {
    const errorMessage = (err as Error).message || "An unknown error occurred while fetching self-model summary after POST operation.";
    return NextResponse.json({ error: `Failed to retrieve self-model summary after POST operation: ${errorMessage}` }, { status: 500 });
  }
}