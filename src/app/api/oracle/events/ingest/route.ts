import { NextResponse } from "next/server";
import { emitOracleEvent, type OracleEvent } from "@/lib/pipeline/oracle/oracle-events";
import { constantTimeEqual } from "@/lib/pipeline/core/constant-time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/oracle/events/ingest — worker → server oracle-event bridge.
 *
 * The self-enhance loop runs in mini-services/loop-worker (port 3004).
 * The oracle events it generates (auto-prophecy after a cycle, self-prophecy
 * adjudication) must land in THIS process's ring buffer — the console
 * stream polls /api/oracle/events here, and one ring means one sequence
 * space and unchanged UI dedup. The worker's oracle-events.ts dual-writes
 * here (fire-and-forget) whenever LOOP_WORKER=1.
 *
 * Token check: display-stream tamper resistance, not a security boundary —
 * a forged event could at worst put one fake line in the terminal view.
 * The shared token comes from LOOP_WORKER_TOKEN on both sides.
 *
 * FAIL-CLOSED (operator, 2026-11-25 audit): the old source-readable default
 * ("loop-worker-ingest-v1") is REMOVED — with LOOP_WORKER_TOKEN unset the
 * route accepts nothing. The client half (oracle-events.ts worker bridge)
 * already fails closed the same way: no token → no POST + one warning. The
 * two halves now honor the same contract that file's comment always claimed.
 * Compare is constant-time (constantTimeEqual) — same pattern as the PIN
 * gates, so a wrong token can't be probed byte-by-byte through timing.
 */
export async function POST(req: Request) {
  const token = req.headers.get("x-loop-worker-token");
  const expected = process.env.LOOP_WORKER_TOKEN;
  if (!expected || !constantTimeEqual(token, expected)) {
    return NextResponse.json({ error: "invalid worker token" }, { status: 401 });
  }

  let body: Partial<OracleEvent>;
  try {
    body = (await req.json()) as Partial<OracleEvent>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body.message !== "string" || body.message.length === 0) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const type: OracleEvent["type"] =
    body.type === "success" || body.type === "warn" || body.type === "error"
      ? body.type
      : "info";
  const source: OracleEvent["source"] =
    body.source === "generator" ||
    body.source === "evaluator" ||
    body.source === "auto-adjudicator"
      ? body.source
      : "scheduler";

  emitOracleEvent(body.message, type, source);
  return NextResponse.json({ ok: true });
}
