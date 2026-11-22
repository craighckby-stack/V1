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
    } else {
      // Input validation failed: missing or invalid 'repo' field.
      return NextResponse.json(
        { error: "Invalid request body: 'repo' must be a non-empty string." },
        { status: 400 },
      );
    }
  } catch (e) {
    // JSON parsing failed (e.g., malformed body)
    return NextResponse.json(
      { error: "Failed to parse request body: must be valid JSON." },
      { status: 400 },
    );
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