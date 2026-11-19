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

    // Verify reachability FIRST (same discipline as setPushTarget): a
    // public repo verifies unauthenticated; a private one needs the
    // stored PAT or a client token. The default branch is persisted as
    // the base ref unless the operator pinned one explicitly.
    const config = await setTargetConfig(body.repo, body.branch ?? null);
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
      return NextResponse.json({ ok: true, config: saved, defaultBranch });
    }
    return NextResponse.json({ ok: true, config, defaultBranch });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE() {
  const had = await clearTargetConfig();
  return NextResponse.json({ ok: true, had });
}
