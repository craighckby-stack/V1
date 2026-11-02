import { NextResponse } from "next/server";
import { autonomousLoopRuntime } from "@/lib/pipeline/autonomous/loop-runtime";
import { assertRouteCooldown } from "@/lib/pipeline/autonomous/route-cooldown";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/autonomous/trigger
 * Fires a one-shot manual autonomous cycle (mode = "manual").
 *
 * Guarded by a per-route cooldown (5s) so a double-click doesn't race
 * two manual cycles into the runtime before it flips to "running" —
 * the runtime's own status === "running" check is the inner guard,
 * this is the outer HTTP-layer guard that returns a clean 429 +
 * Retry-After instead of letting both requests pile in.
 */
const COOLDOWN_MS = 5_000;

export async function POST() {
  const cd = assertRouteCooldown("/api/autonomous/trigger", COOLDOWN_MS);
  if (!cd.ok) {
    return NextResponse.json(
      { error: `Trigger cooldown active — a manual cycle was just fired. Retry in ${cd.retryAfterMs}s.`, cooldownSeconds: cd.retryAfterMs },
      { status: 429, headers: { "Retry-After": String(cd.retryAfterMs), "X-RateLimit-Protection": "enabled" } }
    );
  }
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
