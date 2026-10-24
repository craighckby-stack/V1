import { NextResponse } from "next/server";
import { autonomousLoopRuntime } from "@/lib/pipeline/autonomous/loop-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/autonomous/trigger
 * Fires a one-shot manual autonomous cycle (mode = "manual").
 */
export async function POST() {
  try {
    const result = await autonomousLoopRuntime.triggerManual();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
