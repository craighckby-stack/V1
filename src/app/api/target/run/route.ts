/**
 * Target-mode run API — ONE gated mutation attempt per call.
 *
 * Guards:
 *   - middleware.ts x-loop-key gate (mutating verb)
 *   - route cooldown: 15s min interval (route-cooldown, same pattern as
 *     the self-loop trigger route) so hammering cannot spam GitHub or
 *     the LLM provider
 *   - operator touch: marked on every run (the operator is present and
 *     driving — this feeds the dead-man's-switch clock)
 *   - safe-mode (duress) checked inside the runner itself
 *
 * Body: { dryRun?: boolean, landOnMain?: boolean }
 *   - dryRun runs the FULL gate chain and reports the would-be branch,
 *     but never creates anything on GitHub.
 *   - landOnMain commits the survivor directly to the base ref (main)
 *     instead of an isolated loop-t-NN branch. Opt-in; default is the
 *     safe, reviewable, reversible isolated branch.
 */

import { NextResponse } from "next/server";
import { runTargetMutation } from "@/lib/pipeline/target/target-runner";
import { assertRouteCooldown } from "@/lib/pipeline/autonomous/route-cooldown";
import { markOperatorTouch } from "@/lib/pipeline/autonomous/operator-touch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A full attempt (probes + LLM + debate) can take a couple of minutes.
export const maxDuration = 300;

export async function POST(req: Request) {
  const cd = assertRouteCooldown("/api/target/run", 15_000);
  if (!cd.ok) {
    return NextResponse.json(
      { ok: false, error: `target run is cooling down — retry in ${cd.retryAfterMs}s` },
      { status: 429, headers: { "Retry-After": String(cd.retryAfterMs) } }
    );
  }

  let dryRun = false;
  let landOnMain = false;
  let body: { dryRun?: boolean; landOnMain?: boolean } | null = null;

  try {
    body = await req.json();
    // Explicitly check for true to avoid truthiness pitfalls if input is non-boolean but truthy
    dryRun = body?.dryRun === true;
    landOnMain = body?.landOnMain === true;
  } catch (error) {
    // Handle JSON parsing errors explicitly instead of silently defaulting flags
    // If parsing fails, we proceed with default (dryRun=false, landOnMain=false)
    // but log/handle the error contextually if necessary for debugging.
    console.error("Failed to parse request body for target run:", error instanceof Error ? error.message : "Unknown error");
    body = {}; // Use empty object to allow subsequent logic to proceed with defaults
  }

  // The operator is present and driving — refresh the dead-man's clock.
  // Sync + non-throwing by contract (operator-touch.ts).
  markOperatorTouch("target-mode");

  const result = await runTargetMutation({ dryRun, landOnMain });
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}