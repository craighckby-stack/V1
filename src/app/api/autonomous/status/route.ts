import { NextResponse } from "next/server";
import { autonomousLoopRuntime, LoopState } from "@/lib/pipeline/autonomous/loop-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/autonomous/status
 * Returns the full LoopState of the autonomous self-enhancement loop.
 */
export async function GET() {
  try {
    const state: LoopState = autonomousLoopRuntime.getState();
    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
