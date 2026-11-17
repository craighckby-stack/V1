import { NextResponse } from "next/server";
import { pushCurrentState, getPushTargetPublic } from "@/lib/pipeline/autonomous/push-target";
import { withTreeLock } from "@/lib/pipeline/core/tree-lock";

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
 *
 * TREE LOCK (2026-11-17): the manual push runs `git add -A` — it stages
 * EVERYTHING dirty. Without the tree lock, a worker enhancement landing
 * mid-`git add` would be partially staged and swept into the "Manual push"
 * commit (misattributed, possibly half-written). pushCurrentState itself
 * must NOT acquire the lock (chat-task and the worker call it from inside
 * their own held locks — nesting self-deadlocks), so the lock lives at
 * this top-level entry point, the only unlocked pushCurrentState caller.
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

    const outcome = await withTreeLock(() =>
      pushCurrentState({
        message: "Manual push: current live state",
      })
    );

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
