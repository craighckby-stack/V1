import { NextResponse } from "next/server";
import { autonomousLoopRuntime, AutonomousCycleSummary } from "@/lib/pipeline/autonomous/loop-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/autonomous/recent-cycles
 * Returns the most recent autonomous cycle summaries (newest first).
 */
export async function GET() {
  try {
    const state = autonomousLoopRuntime.getState();
    const cycles: AutonomousCycleSummary[] = state.recentCycles;
    return NextResponse.json({ cycles });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
