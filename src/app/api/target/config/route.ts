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
  let body: { repo?: string; branch?: string };
  let contextRepo: string = 'unknown';

  try {
    body = (await req.json()) as { repo?: string; branch?: string };
    
    if (!body?.repo || typeof body.repo !== "string") {
      return NextResponse.json({ ok: false, error: "repo is required (owner/name)" }, { status: 400 });
    }
    
    contextRepo = body.repo;

    // Validate repo format (should be in owner/name format)
    if (!body.repo.includes("/")) {
      return NextResponse.json({ 
        ok: false, 
        error: "repo must be in 'owner/name' format" 
      }, { status: 400 });
    }
    
    // Validate branch parameter if provided
    if (body.branch !== undefined && typeof body.branch !== "string") {
      return NextResponse.json({ ok: false, error: "branch must be a string if provided" }, { status: 400 });
    }

    // Resolve token first to ensure we have authentication before any validation
    const token = await resolveTargetToken();
    if (!token) {
      return NextResponse.json(
        {
          ok: false,
          error: `No GitHub token available to verify repo ${body.repo}. Please configure a token first.`,
        },
        { status: 422 }
      );
    }

    // Verify reachability FIRST: a typo'd repo or a private repo with no
    // usable token should never become a silently-broken target. The
    // default branch is persisted as the base ref unless the operator
    // pinned one explicitly.
    
    // Check default branch using the resolved token before attempting to save
    const defaultBranch = await getRepoDefaultBranch(body.repo, token);

    if (!defaultBranch) {
      // Do not save config if repo is unreachable/unverifiable.
      return NextResponse.json(
        {
          ok: false,
          error: `Repo ${body.repo} not reachable (missing, private without a usable token, or GitHub unreachable). Not saved.`,
        },
        { status: 422 }
      );
    }

    // Now that reachability is confirmed, save the configuration
    const config = await setTargetConfig(body.repo, body.branch ?? defaultBranch);

    return NextResponse.json({ ok: true, config, defaultBranch });

  } catch (err) {
    if (err instanceof Error) {
      // Differentiate between input validation errors (400) and internal system errors (500)
      // Input validation (missing repo) is handled above (400).
      // Errors from req.json() or store operations are typically internal system errors (500).
      return NextResponse.json({ ok: false, error: `Configuration update failed for repo ${contextRepo}: ${err.message}` }, { status: 500 });
    }
    // Handle non-Error objects gracefully
    return NextResponse.json({ ok: false, error: "An unknown system error occurred during configuration update." }, { status: 500 });
  }
}

export async function DELETE(): Promise<NextResponse<{ ok: boolean; had: boolean; }>> {
  const had = await clearTargetConfig();
  return NextResponse.json({ ok: true, had });
}