import { NextResponse } from "next/server";
import { z } from "zod";
import { clearSafeMode } from "@/lib/pipeline/core/duress";
import { parseOptionalBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const duressClearSchema = z.object({
  by: z.string().min(1).max(60).optional(),
});

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
    const { by } = await parseOptionalBody(req, duressClearSchema, { by: "operator" });
    const result = await clearSafeMode(by);
    return NextResponse.json({ ok: true, cleared: result.cleared });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
