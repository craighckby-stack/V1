import { NextResponse } from "next/server";
import { selfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  // Guard against double-start: if the continuous loop is already active,
  // report it honestly instead of spinning up a second while-loop.
  if (selfEnhanceLoop.isContinuous()) {
    return NextResponse.json({
      started: true,
      alreadyRunning: true,
      message: "Continuous self-enhancement already running",
    });
  }
  selfEnhanceLoop.runContinuous().catch((err) => {
    console.error("[SELF-ENHANCE] continuous loop crashed:", err);
  });
  return NextResponse.json({ started: true, message: "Continuous self-enhancement started" });
}
