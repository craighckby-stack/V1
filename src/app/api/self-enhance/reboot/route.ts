import { NextResponse } from "next/server";
import { workerFetch, ensureWorkerRunning } from "@/lib/pipeline/autonomous/loop-worker-client";
import { markOperatorTouch } from "@/lib/pipeline/autonomous/operator-touch";
import { isMutationFrozen, mutationFreezeNotice } from "@/lib/pipeline/autonomous/mutation-freeze";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/reboot
 *
 * Restart the continuous self-enhancement loop in THIS session. This is
 * the explicit "[REBOOT LOOP NOW]" gesture — the operator deliberately
 * asks to restart the loop with a new provider config (e.g. after saving
 * a new NVIDIA/Gemini key).
 *
 * DECOUPLED FROM ARMING (fix for the "starts straight away on key save"
 * bug): this route does NOT call markSelfEnhanceArmed. It only restarts
 * the loop in the current worker process. The armed state (persisted by
 * [START] at /api/self-enhance/start) is left UNTOUCHED — so an operator
 * who pressed [STOP] (disarmed) and then [REBOOT LOOP NOW] gets a loop
 * that runs now but does NOT auto-start on the next boot. [START] is the
 * ONLY gesture that arms; [STOP] is the ONLY gesture that disarms.
 *
 * Operator touch: a reboot IS an operator gesture, so markOperatorTouch
 * refreshes the dead-man's switch (the 24h auto-pause gate).
 *
 * Semantics:
 *   1. markOperatorTouch("reboot-now") — refresh the dead-man's switch.
 *   2. ensureWorkerRunning() — spawn the worker if down.
 *   3. worker /reboot — stop() → runContinuous(). The stop() bumps the
 *      run token (an in-flight cycle bails at its next checkpoint —
 *      graceful, not a hard kill); runContinuous() starts a fresh loop.
 *
 * Idempotent: safe to call when already running (stop-then-start = a
 * fresh cycle) or when stopped (just a start).
 */
export async function POST() {
  try {
    // Operator mutation freeze: a reboot is a mutation-machinery start
    // gesture — refused while locked (the worker refuses its /reboot
    // too; this edge check keeps the error message clean and skips the
    // dead-man's-switch refresh a frozen system doesn't need).
    if (isMutationFrozen()) {
      return NextResponse.json(
        { rebooted: false, frozen: true, error: mutationFreezeNotice() },
        { status: 423 }
      );
    }
    // 1: refresh the dead-man's switch — a reboot is an operator gesture.
    markOperatorTouch("reboot-now");

    const alive = await ensureWorkerRunning();
    if (!alive) {
      return NextResponse.json(
        { rebooted: false, error: "Loop worker unreachable — the loop will start when the worker comes up. Press [START] to arm it for future boots." },
        { status: 503 }
      );
    }

    // 2 + 3 execute in the worker (stop-if-running → fresh runContinuous);
    // the worker returns the exact response shape this route always sent.
    const r = await workerFetch("/reboot", { method: "POST", timeoutMs: 15000 });
    if (!r?.ok || !r.data) {
      return NextResponse.json(
        { rebooted: false, error: "Worker did not complete the reboot." },
        { status: 502 }
      );
    }
    return NextResponse.json(r.data);
  } catch (err) {
    return NextResponse.json(
      { rebooted: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
