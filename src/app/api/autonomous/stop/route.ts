import { NextResponse } from "next/server";
import { autonomousLoopRuntime, LoopState } from "@/lib/pipeline/autonomous/loop-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/autonomous/stop
 * Disables the autonomous loop and clears any pending timer.
 */
export async function POST() {
  try {
    const state: LoopState = autonomousLoopRuntime.stop();
    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
