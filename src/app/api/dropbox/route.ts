import { NextResponse } from "next/server";
import { getDropboxStatus, ingestDropbox } from "@/lib/pipeline/autonomous/dropbox-ingester";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/dropbox — the dropbox ingester status.
 *   { configured, totalFiles, ingestedFiles, pendingFiles,
 *     candidateLessons, bySystem: [{ system, lessons }] }
 * Read-only.
 *
 * POST /api/dropbox — trigger a scan now (operator gesture).
 *   Runs ingestDropbox() with the budget cap (MAX_INGEST_PER_SCAN=3).
 *   Returns the IngestResult. The operator uses this via the
 *   `dropbox scan` console command.
 */
export async function GET() {
  try {
    const status = await getDropboxStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: `dropbox status failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const result = await ingestDropbox();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `dropbox ingest failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
