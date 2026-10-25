import { NextResponse } from "next/server";
import { selfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  selfEnhanceLoop.runContinuous().catch((err) => {
    console.error("[SELF-ENHANCE] continuous loop crashed:", err);
  });
  return NextResponse.json({ started: true, message: "Continuous self-enhancement started" });
}
