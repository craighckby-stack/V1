import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Parse the violations JSON column back into a structured value when possible.
 * Returns the raw string as a fallback so the caller can still display it.
 */
function safeParseViolations(raw: string): unknown {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * GET /api/pipeline/history
 *
 * Returns the 25 most recent pipeline runs (newest first). The `violations`
 * column is parsed from its JSON string form into a structured array on the
 * way out so consumers don't have to re-parse it.
 */
export async function GET() {
  try {
    const runs = await db.pipelineRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
    });

    const mapped = runs.map((run) => ({
      ...run,
      violations: safeParseViolations(run.violations),
    }));

    return NextResponse.json({ runs: mapped });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
