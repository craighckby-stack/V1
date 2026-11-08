import { NextResponse } from "next/server";
import { liveSelfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";
import { markSelfEnhanceArmed } from "@/lib/pipeline/autonomous/self-enhance-armed-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  // Clear the persisted intent — [STOP] is the operator's interrupt and
  // it is STICKY: no boot or auto-start may re-arm after a human stop.
  // Only an explicit [START] or [SAVE · VERIFY · REBOOT] writes
  // armed:true again. This is the dual of the boot auto-start in the
  // self-enhance-loop constructor.
  markSelfEnhanceArmed(false, "operator-stop");
  liveSelfEnhanceLoop().stop();
  return NextResponse.json({
    stopped: true,
    message: "Self-enhancement loop stopped (armed state cleared — will not auto-start on reboot)",
  });
}
