import { NextResponse } from "next/server";
import { z } from "zod";
import { pruneOldLoopBranches, getPushTargetPublic } from "@/lib/pipeline/autonomous/push-target";
import { parseOptionalBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/self-enhance/prune-branches[?keep=50&margin=10]
 * POST /api/self-enhance/prune-branches  { keep?, margin?, dryRun? }
 *
 * Branch retention policy for the autonomous loop's `loop-NN` mutation
 * branches. The loop creates one remote branch per successful mutation and
 * never deletes any — after 100+ cycles the repo's ref namespace is
 * unwieldy, the audit trail unsearchable, and clones/fetches pull an
 * ever-growing set of refs. The commits themselves are the real record of
 * truth (they live on the seed branch lineage and carry the mutation number
 * in their log), so pruning old `loop-NN` branches loses no history.
 *
 * Policy: keep the most recent `keep` mutation branches (by cycle number),
 * delete the rest. Hysteresis (`margin`) avoids deleting on every push —
 * the drain only fires once the count exceeds keep + margin, then drains
 * back down to `keep` in one batch. The seed branch and every non-`loop-NN`
 * branch are protected by construction.
 *
 * GET is always a dry-run (read-only, safe for the UI to call): it returns
 * the candidate set WITHOUT deleting. POST defaults to executing the prune,
 * but accepts { dryRun: true } to preview, and { keep, margin } to override
 * the defaults (50 / 10) — useful for a one-off deeper clean or a tighter
 * retention window.
 *
 * Returns the full PruneBranchesResult audit summary.
 */
function clampPositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export async function GET(req: Request) {
  try {
    const configured = (await getPushTargetPublic()).configured;
    if (!configured) {
      return NextResponse.json(
        {
          ok: false,
          ran: false,
          reason: "No push target configured — set the PAT via the [CONFIG] panel.",
        },
        { status: 200 }
      );
    }
    const sp = new URL(req.url).searchParams;
    const keep = clampPositiveInt(sp.get("keep"), 50);
    const margin = clampPositiveInt(sp.get("margin"), 10);
    const result = await pruneOldLoopBranches({ keep, margin, dryRun: true });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message, ran: false },
      { status: 500 }
    );
  }
}

const pruneBranchesSchema = z.object({
  keep: z.number().int().min(1).max(1000).optional(),
  margin: z.number().int().min(0).max(1000).optional(),
  dryRun: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const configured = (await getPushTargetPublic()).configured;
    if (!configured) {
      return NextResponse.json(
        {
          ok: false,
          ran: false,
          reason: "No push target configured — set the PAT via the [CONFIG] panel.",
        },
        { status: 200 }
      );
    }
    // No/invalid body — proceed with defaults. The prune is safe to call
    // with no arguments; a malformed JSON must not 500 the operator.
    const { keep, margin, dryRun } = await parseOptionalBody(
      req,
      pruneBranchesSchema,
      { keep: 50, margin: 10, dryRun: false },
    );
    const result = await pruneOldLoopBranches({ keep, margin, dryRun });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message, ran: false },
      { status: 500 }
    );
  }
}
