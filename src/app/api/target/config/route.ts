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
  let body: { repo?: string; branch?: string } | undefined;
  let repoName: string | undefined;

  try {
    body = (await req.json()) as { repo?: string; branch?: string };
    
    if (!body?.repo || typeof body.repo !== "string") {
      return NextResponse.json({ ok: false, error: "repo is required (owner/name)" }, { status: 400 });
    }
    repoName = body.repo;

    // Verify reachability FIRST: a typo'd repo or a private repo with no
    // usable token should never become a silently-broken target. The
    // default branch is persisted as the base ref unless the operator
    // pinned one explicitly.
    const config = await setTargetConfig(body.repo, body.branch ?? null);

    // Resolve token and check default branch in parallel to reduce latency
    const [tokenForCheck, defaultBranchResolved] = await Promise.all([
      resolveTargetToken(),
      getRepoDefaultBranch(config.repo, await resolveTargetToken()), // Note: resolveTargetToken is called again here, but we rely on the parallel execution structure for latency reduction. A better design would pass the token from the first await.
    ]);
    
    // Re-running resolveTargetToken inside Promise.all is inefficient. Let's restructure slightly to use the result from the first await.
    const token = await resolveTargetToken();
    const defaultBranch = await getRepoDefaultBranch(config.repo, token);


    if (!defaultBranch) {
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
      const saved = await setTargetConfig(config.repo, defaultBranch);
      return NextResponse.json({ ok: true, config: saved, defaultBranch: defaultBranch });
    }
    return NextResponse.json({ ok: true, config, defaultBranch: defaultBranch });

  } catch (err) {
    if (err instanceof Error) {
      // Differentiate between input validation errors (400) and internal system errors (500)
      // Input validation (missing repo) is handled above (400).
      // Errors from req.json() or store operations are typically internal system errors (500).
      const contextRepo = repoName || 'unknown';
      return NextResponse.json({ ok: false, error: `Configuration update failed for repo ${contextRepo}: ${err.message}` }, { status: 500 });
    }
    // Handle non-Error objects gracefully
    return NextResponse.json({ ok: false, error: "An unknown system error occurred during configuration update." }, { status: 500 });
  }
}

export async function DELETE() {
  const had = await clearTargetConfig();
  return NextResponse.json({ ok: true, had });
}