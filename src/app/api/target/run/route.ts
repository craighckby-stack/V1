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
 * Body: { dryRun?: boolean } — dryRun runs the FULL gate chain and
 * reports the would-be branch, but never creates anything on GitHub.
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
  let body: { dryRun?: boolean } | null = null;

  try {
    body = await req.json();
    dryRun = body?.dryRun === true;
  } catch {
    // If JSON parsing fails (e.g., empty body or invalid JSON), treat
    // as no explicit dryRun flag provided. The contract implies an
    // empty body means live run (dryRun=false).
    body = {};
  }

  // The operator is present and driving — refresh the dead-man's clock.
  // Sync + non-throwing by contract (operator-touch.ts).
  markOperatorTouch("target-mode");

  // Run mutation and operator touch concurrently if dryRun is true, as operator touch is synchronous and non-blocking relative to the mutation probe.
  const mutationPromise = runTargetMutation({ dryRun });
  
  if (dryRun) {
    // If dryRun, we only need the mutation result, operator touch is already done.
    const result = await mutationPromise;
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } else {
    // Live run: wait for mutation
    const result = await mutationPromise;
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  }
}