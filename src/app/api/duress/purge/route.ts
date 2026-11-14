import { NextResponse } from "next/server";
import { duressPurgePat } from "@/lib/pipeline/core/duress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/duress/purge
 *
 * Manually trigger the duress/purge protocol. This is the operator's
 * panic button — it runs the full PKM §3 sequence (KEYS → CACHE →
 * SAFE-MODE → READ-BACK → HALT), purging the PAT from all three
 * persistence tiers and raising safe-mode so the autonomous loop halts
 * until cleared. See docs/CONCEPTS-GRAFTED.md GRAFT 2.
 *
 * Body (optional):
 *   { reason?: string }  — why the operator triggered the purge.
 *                         Defaults to "manual operator trigger".
 */
export async function POST(req: Request) {
  try {
    let reason = "manual operator trigger";
    try {
      const body = await req.json();
      if (body && typeof body.reason === "string" && body.reason.trim()) {
        reason = body.reason.trim().slice(0, 300);
      }
    } catch {
      /* no body or invalid JSON — use default reason */
    }
    const result = await duressPurgePat({ reason, setBy: "operator" });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
