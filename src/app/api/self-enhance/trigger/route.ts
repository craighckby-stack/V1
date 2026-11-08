import { NextResponse } from "next/server";
import { liveSelfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";
import { assertRouteCooldown } from "@/lib/pipeline/autonomous/route-cooldown";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/trigger
 *
 * Fires one self-enhancement cycle. Guarded by a per-route cooldown so a
 * double-click (or a retry storm) doesn't race two cycles into the
 * runtime before it flips to "running" — the guard returns 429 +
 * Retry-After for the second request within the cooldown window. The
 * window is intentionally short (5s): long enough to absorb an
 * accidental double-click, short enough that a deliberate re-trigger
 * after a real failure isn't blocked.
 */
const COOLDOWN_MS = 5_000;

export async function POST() {
  const cd = assertRouteCooldown("/api/self-enhance/trigger", COOLDOWN_MS);
  if (!cd.ok) {
    return NextResponse.json(
      { error: `Trigger cooldown active — a cycle was just fired. Retry in ${cd.retryAfterMs}s.`, cooldownSeconds: cd.retryAfterMs },
      { status: 429, headers: { "Retry-After": String(cd.retryAfterMs), "X-RateLimit-Protection": "enabled" } }
    );
  }
  const result = await liveSelfEnhanceLoop().runCycle();
  return NextResponse.json(result);
}
