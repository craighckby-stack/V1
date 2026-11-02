import { NextResponse } from "next/server";
import { clearSafeMode } from "@/lib/pipeline/core/duress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/duress/clear
 *
 * Clear the safe-mode flag (operator action). After a duress purge OR a
 * red-team failure raised safe-mode, the autonomous loop refuses to run
 * until this is called. The operator should verify the situation (PAT
 * reconfigured, red-team bypass investigated) BEFORE clearing — clearing
 * is the operator asserting "it's safe to resume".
 *
 * Body (optional):
 *   { by?: string }  — who cleared it (defaults to "operator").
 */
export async function POST(req: Request) {
  try {
    let by = "operator";
    try {
      const body = await req.json();
      if (body && typeof body.by === "string" && body.by.trim()) {
        by = body.by.trim().slice(0, 60);
      }
    } catch {
      /* no body — use default */
    }
    const result = await clearSafeMode(by);
    return NextResponse.json({ ok: true, cleared: result.cleared });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
