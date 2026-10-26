import { NextResponse } from "next/server";
import { pushCurrentState, getPushTargetPublic } from "@/lib/pipeline/autonomous/push-target";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/push
 * Body: { force?: boolean }
 *
 * Commits (if dirty) and pushes the current live state to the configured
 * GitHub target. Returns needsConfig when no target is set.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
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
      force: Boolean(body.force),
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
