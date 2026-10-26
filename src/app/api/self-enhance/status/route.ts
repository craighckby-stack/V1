import { NextResponse } from "next/server";
import { selfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";
import { getQueueStats } from "@/lib/pipeline/autonomous/self-task-generator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const queue = await getQueueStats().catch(() => null);
  return NextResponse.json({
    running: selfEnhanceLoop.isRunning(),
    stats: selfEnhanceLoop.getStats(),
    logs: selfEnhanceLoop.getLogs(),
    currentTask: selfEnhanceLoop.getCurrentTask(),
    queue,
    inputMode: "system-defined",
  });
}
