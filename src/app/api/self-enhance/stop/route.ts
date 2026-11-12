import { NextResponse } from "next/server";
import { workerFetch } from "@/lib/pipeline/autonomous/loop-worker-client";
import { markSelfEnhanceArmed } from "@/lib/pipeline/autonomous/self-enhance-armed-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  // Clear the persisted intent — [STOP] is the operator's interrupt and
  // it is STICKY: no boot or auto-start may re-arm after a human stop.
  // Only an explicit [START] or [SAVE · VERIFY · REBOOT] writes
  // armed:true again. This is the dual of the worker constructor's boot
  // auto-start. Server-owned tier, cleared regardless of worker state.
  markSelfEnhanceArmed(false, "operator-stop");

  // Stop the runtime in the worker. If the worker is unreachable, nothing
  // is running in it (the loop lives there) — the armed clear above already
  // guarantees no auto-start on the next boot, so this is honestly a stop.
  const r = await workerFetch("/stop", { method: "POST", timeoutMs: 8000 });
  if (r && !r.ok) {
    // Worker reachable but refused — report honestly instead of lying.
    return NextResponse.json(
      {
        stopped: false,
        error: `Worker refused stop: ${
          (r.data as { error?: string } | null)?.error ?? `status ${r.status}`
        }`,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    stopped: true,
    message: "Self-enhancement loop stopped (armed state cleared — will not auto-start on reboot)",
  });
}
