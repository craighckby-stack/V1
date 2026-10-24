import { NextResponse } from "next/server";
import { autonomousLoopRuntime, LoopState } from "@/lib/pipeline/autonomous/loop-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/autonomous/start
 * Enables the autonomous loop and arms the scheduler.
 */
export async function POST() {
  try {
    const state: LoopState = autonomousLoopRuntime.start();
    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
