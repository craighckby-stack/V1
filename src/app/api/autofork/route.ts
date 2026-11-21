import { NextResponse } from "next/server";
import { getAutoForkStatus, ingestAutoFork } from "@/lib/pipeline/autonomous/autofork-ingester";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/autofork — the auto-fork ingester status.
 *   { configured, seedsCount, enabledSeeds, seeds: [{repo, enabled, reason}],
 *     ingestedFiles, candidateLessons, bySystem: [{system, lessons}] }
 * Read-only.
 *
 * POST /api/autofork — trigger a scan now (operator gesture).
 *   Runs ingestAutoFork() — one repo per scan, up to 3 files, budget-capped.
 *   Returns the AutoForkResult. The operator uses this via the
 *   `autofork scan` console command.
 */
export async function GET() {
  try {
    const status = await getAutoForkStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: `autofork status failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    // Optional `repo` param: scan a specific seed repo (e.g. the operator
    // wants to learn from DeepSeek specifically). Without it, the next
    // enabled seed in the list is scanned.
    let repoOverride: string | undefined;
    try {
      const body = (await req.json()) as { repo?: string };
      if (typeof body.repo === "string" && body.repo.trim()) {
        repoOverride = body.repo.trim();
      }
    } catch {
      /* no body or not JSON — fine, scan the next seed */
    }
    const result = await ingestAutoFork(undefined, repoOverride);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `autofork ingest failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
