import { NextResponse } from "next/server";
import { workerFetch, ensureWorkerRunning } from "@/lib/pipeline/autonomous/loop-worker-client";
import { markSelfEnhanceArmed } from "@/lib/pipeline/autonomous/self-enhance-armed-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/reboot
 *
 * Restart the continuous self-enhancement loop. This is the "system reboot"
 * gesture triggered when an operator saves a new LLM provider config (e.g. a
 * Gemini key in the GEMINI panel): the loop was either stopped by a 429 wall
 * or self-exited after a pass, and a fresh provider quota is the reason to
 * bring it back to life immediately instead of waiting for a manual [START].
 *
 * Semantics (unchanged by the worker split — the runtime just moved):
 *   1. worker stop() — bumps the run token (any in-flight cycle bails at
 *      its next checkpoint) and sets continuous=false. Harmless when the
 *      loop is already stopped.
 *   2. markSelfEnhanceArmed(true, "reboot-on-config") — persists the armed
 *      intent to the wipe-proof tier (.git/info/loop-self-enhance-armed.json)
 *      so the loop ALSO auto-starts on every subsequent worker boot. The
 *      operator's reboot-on-config gesture is treated as a re-arm.
 *   3. worker runContinuous() — sets continuous=true, captures the new run
 *      token, and starts a fresh while-loop in the worker process. The
 *      runCycle re-entry guard means the new loop's first cycle no-ops if a
 *      stale cycle is still mid-flight, then takes over cleanly.
 *
 * This route deliberately does NOT touch the autonomous scheduler
 * (autonomousLoopRuntime). That loop has its own operator-gated armed state
 * (.git/info/loop-armed-state.json) and a sticky [STOP] that must only be
 * released by an explicit [START] on /api/autonomous/start — a provider
 * config change is not license to override an operator's deliberate
 * disarm. Reboot here is scoped to the work-producing self-enhance loop.
 *
 * Idempotent: safe to call when already running (stop-then-start = a clean
 * fresh cycle) or when stopped (just a start + re-arm).
 */
export async function POST() {
  try {
    // 2 first (armed is server-owned): persist before touching the runtime
    // so even a worker crash mid-reboot leaves the re-arm persisted.
    markSelfEnhanceArmed(true, "reboot-on-config");

    const alive = await ensureWorkerRunning();
    if (!alive) {
      return NextResponse.json(
        { rebooted: false, error: "Loop worker unreachable — armed state persisted; the loop will auto-start when the worker comes up." },
        { status: 503 }
      );
    }

    // 1 + 3 execute in the worker (stop-if-running → fresh runContinuous);
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
