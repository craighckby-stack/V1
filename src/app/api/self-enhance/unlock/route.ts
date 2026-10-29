import { NextResponse } from "next/server";
import { selfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/unlock
 * Body: { filePath: string }  (repo-relative, e.g. "src/app/display/console-stream.tsx")
 *
 * Unlocks a saturated file so it's eligible for the next cycle. Resets
 * its no-growth counter and enhancements-this-pass counter — a fresh
 * start. The file is re-evaluated on the next cycle.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { filePath?: string };
    if (!body.filePath) {
      return NextResponse.json(
        { ok: false, error: "filePath is required" },
        { status: 400 }
      );
    }
    const result = selfEnhanceLoop.unlockFile(body.filePath);
    return NextResponse.json({ ok: result.unlocked, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
