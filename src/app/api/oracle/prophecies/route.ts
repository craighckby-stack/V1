import { NextResponse } from "next/server";
import { listRecentProphecies } from "@/lib/pipeline/oracle/prophecy-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/oracle/prophecies
 *
 * Returns the system's recent prophecies, newest first. Each row
 * includes all public fields — there are no secret fields on Prophecy
 * (claims are public; the calibration metric depends on transparency).
 *
 * Query params:
 *   limit — max rows to return (default 50, capped at 200)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  let limit = 50;
  if (limitParam) {
    const parsed = Number(limitParam);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(200, Math.round(parsed));
    }
  }
  try {
    const prophecies = await listRecentProphecies(limit);
    return NextResponse.json({ ok: true, prophecies });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
