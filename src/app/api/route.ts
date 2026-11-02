import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api — service index.
 *
 * The old body here was a "Hello, world!" placeholder with no dynamic/
 * runtime flags — dead scaffold. This index describes the actual API
 * surface so an operator (or monitoring probe) hitting /api directly gets
 * an honest map of the system instead of a greeting.
 */
export async function GET() {
  return NextResponse.json({
    service: "LOOP — autonomous self-enhancement system",
    api: {
      selfEnhance: [
        "GET  /api/self-enhance/status",
        "GET  /api/self-enhance/files",
        "GET  /api/self-enhance/tasks?limit=N",
        "POST /api/self-enhance/{start,stop,trigger,rescan,skip,unlock,push}",
        "POST /api/self-enhance/push-target  (configure GitHub push)",
        "POST /api/self-enhance/llm-config   (configure Gemini direct)",
        "POST /api/self-enhance/chat-task/{propose,apply}",
      ],
      autonomous: [
        "GET  /api/autonomous/status",
        "POST /api/autonomous/{start,stop,trigger,config}",
        "GET  /api/autonomous/recent-cycles",
      ],
      oracle: [
        "GET  /api/oracle/status   (track record + calibration + Brier)",
        "GET  /api/oracle/prophecies",
        "GET  /api/oracle/events?since=N",
        "POST /api/oracle/{generate,evaluate}",
      ],
      postmortems: ["GET /api/postmortems", "POST /api/postmortems/seed"],
      pipeline: ["GET /api/pipeline/history", "POST /api/pipeline/run"],
      github: [
        "POST /api/github/{validate-token,repo-tree,fetch-file,commit-file,batch-commit}",
      ],
      memory: ["GET /api/memory/entries", "POST /api/memory/query"],
      health: ["GET /api/health"],
    },
  });
}
