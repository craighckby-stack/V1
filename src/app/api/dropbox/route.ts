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
    // Return a standardized 500 error response with context
    console.error("Error retrieving Dropbox status:", err);
    return NextResponse.json(
      { error: "Failed to retrieve Dropbox status. Check logs for details." },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const result = await ingestDropbox();
    return NextResponse.json(result);
  } catch (err) {
    // Return a standardized 500 error response with context
    console.error("Error triggering Dropbox ingestion scan:", err);
    return NextResponse.json(
      { error: "Failed to trigger Dropbox ingestion scan. Check logs for details." },
      { status: 500 },
    );
  }
}