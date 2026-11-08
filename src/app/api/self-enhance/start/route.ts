import { NextResponse } from "next/server";
import { liveSelfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";
import { markSelfEnhanceArmed } from "@/lib/pipeline/autonomous/self-enhance-armed-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  // Guard against double-start: if the continuous loop is already active,
  // report it honestly instead of spinning up a second while-loop.
  if (liveSelfEnhanceLoop().isContinuous()) {
    return NextResponse.json({
      started: true,
      alreadyRunning: true,
      message: "Continuous self-enhancement already running",
    });
  }
  // Persist the armed intent to the wipe-proof tier — this is what makes
  // [START] a ONE-TIME ritual: every subsequent process boot re-arms
  // from disk (see the constructor's boot auto-start). Best-effort, never
  // throws (in-memory remains the live source; disk is the restart tier).
  markSelfEnhanceArmed(true, "operator-start");
  liveSelfEnhanceLoop().runContinuous().catch((err) => {
    console.error("[SELF-ENHANCE] continuous loop crashed:", err);
  });
  return NextResponse.json({
    started: true,
    message: "Continuous self-enhancement started (armed state persisted — survives restarts)",
  });
}
