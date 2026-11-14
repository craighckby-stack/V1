import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getPushTargetPublic,
  setPushTarget,
  clearPushTarget,
} from "@/lib/pipeline/autonomous/push-target";
import { parseBody, REPO_REGEX } from "@/lib/api/validate";

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
 *
 * Validation: `repo` is interpolated into `git remote add` URLs and GitHub
 * REST URLs downstream — the old route took it as-is, so a value like
 * `../victims/repo` could redirect API calls. The `^owner/name$` shape check
 * blocks that. `token` is a PAT — capped at 500 chars to reject absurd
 * inputs. `.strict()` rejects unknown keys so a body can't smuggle extra
 * fields into the persisted target.
 */
const pushTargetPostSchema = z.object({
  repo: z.string().regex(REPO_REGEX, "repo must be 'owner/name'").max(100),
  token: z.string().min(1).max(500),
  isPublic: z.boolean().optional(),
  createIfMissing: z.boolean().optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, pushTargetPostSchema);
    if (!parsed.ok) return parsed.response;

    const { repo, token, isPublic, createIfMissing } = parsed.data;
    const doCreate = createIfMissing !== false; // default true

    const result = await setPushTarget({
      repo,
      token,
      isPublic: Boolean(isPublic),
      createIfMissing: doCreate,
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
    // setPushTarget throws on auth/repo failures — 400 keeps the old
    // contract the UI depends on (the panel reads `data.error`).
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
