import { NextResponse } from "next/server";
import { getSafeModeState, getConsecutiveAuthFailures, isSafeMode } from "@/lib/pipeline/core/duress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/duress/status
 *
 * Returns the current safe-mode state (raised by the duress purge OR the
 * red-team suite) plus the consecutive-push-auth-failure counter (the
 * anomaly signal that auto-triggers the purge). The autonomous loop
 * reads `isSafeMode()` in-process every cycle; this route is for the UI
 * and for external monitoring. See docs/CONCEPTS-GRAFTED.md GRAFT 2.
 */
export async function GET() {
  try {
    const state = await getSafeModeState();
    return NextResponse.json({
      ok: true,
      safeMode: {
        active: state.active,
        setBy: state.setBy,
        reason: state.reason,
        setAt: state.setAt,
      },
      consecutiveAuthFailures: getConsecutiveAuthFailures(),
      authFailureThreshold: 5,
      runtimeFlag: isSafeMode(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
