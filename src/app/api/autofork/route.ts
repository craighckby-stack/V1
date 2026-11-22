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
  let repoOverride: string | undefined;
  try {
    const body = await req.json();
    if (typeof body === 'object' && body !== null && typeof body.repo === "string" && body.repo.trim()) {
      repoOverride = body.repo.trim();
    }
  } catch (e) {
    // If JSON parsing fails or body is not an object, we proceed to scan the next seed,
    // as per original logic, but we avoid swallowing the error silently without context.
    // Since the original logic ignored this, we maintain that behavior but clean up the structure.
  }

  try {
    const result = await ingestAutoFork(undefined, repoOverride);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `autofork ingest failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}