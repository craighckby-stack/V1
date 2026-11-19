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
  try {
    const body = (await req.json()) as { dryRun?: boolean };
    dryRun = body?.dryRun === true;
  } catch {
    /* empty body = live run */
  }

  // The operator is present and driving — refresh the dead-man's clock.
  // Sync + non-throwing by contract (operator-touch.ts).
  markOperatorTouch("target-mode");

  try {
    const result = await runTargetMutation({ dryRun });
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, status: "failed", error: `target run crashed: ${(err as Error).message.slice(0, 300)}`, log: [] },
      { status: 500 }
    );
  }
}
