import { NextResponse } from "next/server";
import {
  getPushTargetPublic,
  setPushTarget,
  clearPushTarget,
} from "@/lib/pipeline/autonomous/push-target";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/self-enhance/push-target
 * Returns the public view of the push target — the token is NEVER included.
 */
export async function GET() {
  try {
    const target = await getPushTargetPublic();
    return NextResponse.json(target);
  } catch (err) {
    return NextResponse.json({ configured: false, error: (err as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/self-enhance/push-target
 * Body: { repo: string, token: string, isPublic?: boolean, createIfMissing?: boolean }
 *
 * Verifies the token with GitHub, verifies (or auto-creates) the repo,
 * persists the target, and points the git `origin` remote at it.
 * createIfMissing defaults to true — when false, missing repos are rejected.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      repo?: string;
      token?: string;
      isPublic?: boolean;
      createIfMissing?: boolean;
    };

    if (!body.repo || !body.token) {
      return NextResponse.json(
        { error: "Both repo and token are required" },
        { status: 400 }
      );
    }

    const createIfMissing = body.createIfMissing !== false; // default true

    const result = await setPushTarget({
      repo: body.repo,
      token: body.token,
      isPublic: Boolean(body.isPublic),
      createIfMissing,
    });

    return NextResponse.json({
      ok: true,
      repo: result.repo,
      login: result.login,
      created: result.created,
      message: result.created
        ? `Repo ${result.repo} created — pushing to it now`
        : `Connected to ${result.repo} as ${result.login}`,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}

/**
 * DELETE /api/self-enhance/push-target
 * Clears the stored target and removes the origin remote.
 */
export async function DELETE() {
  try {
    const result = await clearPushTarget();
    return NextResponse.json({ ok: true, cleared: result.cleared });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
