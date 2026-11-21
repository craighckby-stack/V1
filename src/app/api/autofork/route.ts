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

export async function POST() {
  try {
    const result = await ingestAutoFork();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `autofork ingest failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
