import { NextResponse } from "next/server";
import { liveSelfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";
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
 * Semantics:
 *   1. stop() — bumps the run token (any in-flight cycle bails at its next
 *      checkpoint) and sets continuous=false. Harmless when the loop is
 *      already stopped (just bumps a token no one holds + one warn log).
 *   2. markSelfEnhanceArmed(true, "reboot-on-config") — persists the armed
 *      intent to the wipe-proof tier (.git/info/loop-self-enhance-armed.json)
 *      so the loop ALSO auto-starts on every subsequent process boot. The
 *      operator's reboot-on-config gesture is treated as a re-arm: if the
 *      dev server later recycles, the loop comes back on its own — that's
 *      the "automate this with system start" contract.
 *   3. runContinuous() — sets continuous=true, captures the new run token,
 *      and starts a fresh while-loop. The runCycle re-entry guard
 *      (`if (this.running) return`) means the new loop's first cycle no-ops
 *      if a stale cycle is still mid-flight, then takes over cleanly once
 *      the old one releases `running` in its `finally` block. No two loops
 *      ever run concurrently (the generation token guarantees it — see
 *      self-enhance-loop.ts runContinuous audit 2).
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
    const loop = liveSelfEnhanceLoop();
    const wasRunning = loop.isContinuous();

    // 1. Stop: bump the run token so any in-flight cycle bails; set
    //    continuous=false so the outer while-loop exits.
    if (wasRunning) {
      loop.stop();
    }

    // 2. Persist armed:true so the loop also auto-starts on every
    //    subsequent process boot (the "automate with system start" tier).
    //    Best-effort, never throws.
    markSelfEnhanceArmed(true, "reboot-on-config");

    // 3. Start fresh. Fire-and-forget the async while-loop — the HTTP
    //    response returns immediately with the running state.
    loop.runContinuous().catch((err) => {
      console.error("[REBOOT] self-enhance loop crashed on restart:", err);
    });

    return NextResponse.json({
      rebooted: true,
      running: true,
      wasRunning,
      armed: true,
      message: wasRunning
        ? "Self-enhancement loop rebooted — in-flight cycle aborted, fresh loop started with the new provider chain. Armed state persisted — it auto-starts on the next system boot too."
        : "Self-enhancement loop started — running with the new provider chain. Armed state persisted — it auto-starts on the next system boot too.",
    });
  } catch (err) {
    return NextResponse.json(
      { rebooted: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
