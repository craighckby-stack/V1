import { NextResponse } from "next/server";
import {
  analyzeMergeBack,
  executeMergeBack,
  listMergeBackCandidates,
} from "@/lib/pipeline/autonomous/merge-back";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/self-enhance/merge-back
 *   Returns the list of retained loop-NN branches with a per-branch
 *   merge-back summary (sha, subject, commits ahead of main, src/ files
 *   delta). Read-only — safe for the UI to poll.
 *
 * GET /api/self-enhance/merge-back?branch=loop-198
 *   Returns the full merge-back PLAN for that branch (source files to
 *   change, main-only files, conflicts-if-merged). Read-only.
 *
 * POST /api/self-enhance/merge-back  { branch, strategy, push? }
 *   Executes the merge-back. Typecheck-gated (tsc --noEmit runs AFTER
 *   staging; if it fails, the commit never lands and the working tree is
 *   restored). `strategy: "dry-run"` is a safe preview. `strategy:
 *   "theirs-for-source"` brings src/ files forward, keeps main's metadata.
 *   `push: true` also pushes main to origin (default off — the operator
 *   pushes via the existing [PUSH] UI so the merge stays reversible).
 *
 * WHY: the loop creates a new loop-NN branch per mutation but has no path
 * back to main — after 198 cycles main was 35 mutations behind loop-198
 * and the running system wasn't benefiting from its own recent
 * self-enhancements. This route is the reviewed, gated catch-up path.
 */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const branch = sp.get("branch");
    if (branch) {
      const plan = analyzeMergeBack(branch);
      if (!plan) {
        return NextResponse.json(
          { ok: false, error: `branch ${branch} not found (or no remote-tracking ref)` },
          { status: 404 },
        );
      }
      return NextResponse.json({ ok: true, plan });
    }
    const candidates = listMergeBackCandidates();
    return NextResponse.json({ ok: true, candidates, count: candidates.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    let body: { branch?: unknown; strategy?: unknown; push?: unknown } = {};
    try {
      body = (await req.json()) as { branch?: unknown; strategy?: unknown; push?: unknown };
    } catch {
      return NextResponse.json(
        { ok: false, error: "invalid JSON body — expected { branch, strategy, push? }" },
        { status: 400 },
      );
    }
    const branch = typeof body.branch === "string" ? body.branch : null;
    if (!branch) {
      return NextResponse.json(
        { ok: false, error: "missing 'branch' (e.g. \"loop-198\")" },
        { status: 400 },
      );
    }
    const strategy =
      body.strategy === "theirs-for-source" || body.strategy === "dry-run"
        ? body.strategy
        : "dry-run";
    const push = body.push === true;

    const result = executeMergeBack(branch, { strategy, push });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
