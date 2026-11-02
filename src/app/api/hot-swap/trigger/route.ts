import { NextResponse } from "next/server";
import { hotSwapPipeline } from "@/lib/pipeline/core/hot-swap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A swap re-imports the pipeline subtree; give it headroom above the
// Next.js compile + require time.
export const maxDuration = 60;

/**
 * POST /api/hot-swap/trigger
 *
 * Manually trigger a pipeline hot-swap. The same swap the autonomous
 * loop fires automatically after each verified enhancement, exposed as
 * a route so the operator can force a swap (e.g. after editing a
 * pipeline file by hand). See docs/HOT-SWAP.md.
 *
 * Body (optional):
 *   { reason?: string, dryRun?: boolean }
 */
export async function POST(req: Request) {
  try {
    let reason = "manual operator trigger";
    let dryRun = false;
    try {
      const body = await req.json();
      if (body && typeof body.reason === "string" && body.reason.trim()) {
        reason = body.reason.trim().slice(0, 200);
      }
      if (body && typeof body.dryRun === "boolean") dryRun = body.dryRun;
    } catch {
      /* no body — use defaults */
    }
    const result = await hotSwapPipeline({ reason, dryRun });
    return NextResponse.json({ ok: result.ok, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
