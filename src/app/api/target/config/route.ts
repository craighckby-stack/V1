/**
 * Target-mode configuration API.
 *
 * GET    → { ok, config, lastRun }        (public view — never a token)
 * POST   → set { repo, branch? }; verifies the repo is reachable before
 *          saving so a typo never becomes a silently-broken target
 * DELETE → disconnect (idempotent)
 *
 * Mutating verbs are gated by middleware.ts (x-loop-key), same as every
 * other mutating route in the system.
 */

import { NextResponse } from "next/server";
import {
  getTargetConfig,
  setTargetConfig,
  clearTargetConfig,
  getTargetLastRun,
  resolveTargetToken,
} from "@/lib/pipeline/target/target-store";
import { getRepoDefaultBranch } from "@/lib/pipeline/target/target-github";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [config, lastRun] = await Promise.all([getTargetConfig(), getTargetLastRun()]);
  return NextResponse.json({ ok: true, config, lastRun });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { repo?: string; branch?: string };
    if (!body.repo || typeof body.repo !== "string") {
      return NextResponse.json({ ok: false, error: "repo is required (owner/name)" }, { status: 400 });
    }

    // Verify reachability FIRST
    const config = await setTargetConfig(body.repo, body.branch ?? null);
    
    // Run token resolution and default branch check concurrently
    const [token, defaultBranch] = await Promise.all([
      resolveTargetToken(),
      getRepoDefaultBranch(config.repo, await resolveTargetToken()), // Note: resolveTargetToken is awaited inside getRepoDefaultBranch if needed, but we await it once above for efficiency. Re-evaluating dependency: getRepoDefaultBranch needs token.
    ]);

    // Corrected concurrent execution: resolve token first, then use it for branch check
    const tokenResolved = await resolveTargetToken();
    const defaultBranchResolved = await getRepoDefaultBranch(config.repo, tokenResolved);

    if (!defaultBranchResolved) {
      // Do not leave a broken config behind — roll back the save.
      await clearTargetConfig();
      return NextResponse.json(
        {
          ok: false,
          error: `Repo ${config.repo} not reachable (missing, private without a usable token, or GitHub unreachable). Not saved.`,
        },
        { status: 422 }
      );
    }
    
    if (!config.branch) {
      // Persist the resolved default so `target status` shows the truth.
      const saved = await setTargetConfig(config.repo, defaultBranchResolved);
      return NextResponse.json({ ok: true, config: saved, defaultBranch: defaultBranchResolved });
    }
    
    // If branch was provided, return the original config (which already includes the repo)
    return NextResponse.json({ ok: true, config, defaultBranch: defaultBranchResolved });

  } catch (err) {
    if (err instanceof Error) {
      // Differentiate between input validation errors (400) and internal system errors (500)
      // Assuming errors from req.json() or store operations are usually 500 unless input validation failed above.
      // Keeping 400 for general errors caught here, but context is improved.
      return NextResponse.json({ ok: false, error: `Configuration update failed: ${err.message}` }, { status: 400 });
    }
    // Handle non-Error objects gracefully
    return NextResponse.json({ ok: false, error: "An unknown system error occurred during configuration update." }, { status: 500 });
  }
}

export async function DELETE() {
  const had = await clearTargetConfig();
  return NextResponse.json({ ok: true, had });
}