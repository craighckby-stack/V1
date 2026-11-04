import { NextResponse } from "next/server";
import { pushCurrentState, getPushTargetPublic } from "@/lib/pipeline/autonomous/push-target";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/push
 *
 * Commits (if dirty) and pushes the current live state to the configured
 * GitHub target. Returns needsConfig when no target is set.
 *
 * Force-push REMOVED (audit 3): this route used to accept { force?: boolean }
 * and forward it to pushCurrentState — a force-push to main rewrites the
 * remote's history. The body is no longer read at all; pushes are always
 * non-forcing, regardless of what the client sends.
 */
export async function POST() {
  try {
    const target = await getPushTargetPublic();
    if (!target.configured) {
      return NextResponse.json({
        pushed: false,
        needsConfig: true,
        error: "No push target configured. Run: push <github_token> <owner/repo>",
      });
    }

    const outcome = await pushCurrentState({
      message: "Manual push: current live state",
    });

    return NextResponse.json({
      pushed: outcome.pushed,
      commitSha: outcome.commitSha,
      repo: outcome.repo,
      error: outcome.error,
    });
  } catch (err) {
    return NextResponse.json({ pushed: false, error: (err as Error).message }, { status: 500 });
  }
}
