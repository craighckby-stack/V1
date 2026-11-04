import { NextResponse } from "next/server";
import { getSwapHistory, getSwapCount, runningPipelineFingerprint } from "@/lib/pipeline/core/hot-swap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hot-swap/status
 *
 * Returns the hot-swap subsystem's state: how many swaps have happened
 * since process start, the running pipeline's fingerprint (a hash of
 * the loaded module set), and the ring buffer of recent swap results.
 * The UI polls this to show "HOT-SWAP: N swaps" in the header. See
 * docs/HOT-SWAP.md.
 */
export async function GET() {
  try {
    return NextResponse.json({
      ok: true,
      swapCount: getSwapCount(),
      runningFingerprint: runningPipelineFingerprint(),
      history: getSwapHistory(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
