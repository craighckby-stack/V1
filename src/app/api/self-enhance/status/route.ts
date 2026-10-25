import { NextResponse } from "next/server";
import { selfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    running: selfEnhanceLoop.isRunning(),
    stats: selfEnhanceLoop.getStats(),
    logs: selfEnhanceLoop.getLogs(),
    currentFile: selfEnhanceLoop.getCurrentFile(),
  });
}
