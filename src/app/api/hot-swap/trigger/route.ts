import { NextResponse } from "next/server";
import { z } from "zod";
import { hotSwapPipeline } from "@/lib/pipeline/core/hot-swap";
import { parseOptionalBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A swap re-imports the pipeline subtree; give it headroom above the
// Next.js compile + require time.
export const maxDuration = 60;

const hotSwapSchema = z.object({
  reason: z.string().min(1).max(200).optional(),
  dryRun: z.boolean().optional(),
});

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
    const { reason, dryRun } = await parseOptionalBody(
      req,
      hotSwapSchema,
      { reason: "manual operator trigger", dryRun: false },
    );
    const result = await hotSwapPipeline({ reason, dryRun });
    return NextResponse.json({ ok: result.ok, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
