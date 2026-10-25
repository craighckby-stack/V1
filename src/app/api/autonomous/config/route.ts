import { NextResponse } from "next/server";
import { autonomousLoopRuntime, LoopConfig } from "@/lib/pipeline/autonomous/loop-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AutonomousConfigPatch = Partial<LoopConfig>;

interface AutonomousConfigRequest extends AutonomousConfigPatch {
  githubToken?: string;
}

/**
 * POST /api/autonomous/config
 *
 * Updates the autonomous loop configuration. The githubToken field is special:
 * the UI re-sends "[REDACTED]" (or empty) when the user has *not* changed the
 * token. We must NOT overwrite the stored token in that case — only persist
 * real new tokens.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AutonomousConfigRequest;

    const patch: AutonomousConfigPatch = { ...body };

    // Preserve existing token unless the caller supplied a real new value.
    if (
      patch.githubToken === undefined ||
      patch.githubToken === "" ||
      patch.githubToken === "[REDACTED]"
    ) {
      delete patch.githubToken;
    }

    const updated = autonomousLoopRuntime.updateConfig(patch);
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
