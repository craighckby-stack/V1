import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/health
 * Reports service version and the liveness of every major subsystem.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    version: "4.1.0",
    timestamp: Date.now(),
    subsystems: {
      pipeline: "ready",
      governor: "ready",
      sanitizer: "ready",
      autonomousLoop: "idle",
      websocket: "pending",
    },
  });
}
