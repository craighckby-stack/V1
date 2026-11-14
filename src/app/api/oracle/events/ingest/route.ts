import { NextResponse } from "next/server";
import { z } from "zod";
import { emitOracleEvent, type OracleEvent } from "@/lib/pipeline/oracle/oracle-events";
import { parseBody } from "@/lib/api/validate";

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
 * The shared token comes from LOOP_WORKER_TOKEN on both sides. There is NO
 * default: an unset token fails CLOSED (401) so a misconfigured worker can't
 * silently poison the event stream with the source-readable default that
 * used to live here.
 *
 * Validation: unknown type/source values are coerced to the defaults
 * ("info"/"scheduler") rather than rejected — the worker may predate a new
 * enum value and its events must not be dropped. `message` is capped at
 * 500 chars (audit L8) so a runaway worker can't push unbounded strings
 * into the ring buffer the UI renders.
 */
const ingestSchema = z.object({
  message: z.string().min(1).max(500),
  type: z.string().max(20).optional(),
  source: z.string().max(40).optional(),
}).strict();

export async function POST(req: Request) {
  const token = req.headers.get("x-loop-worker-token");
  const expected = process.env.LOOP_WORKER_TOKEN;
  // Fail CLOSED when the shared token is not configured. The old default
  // "loop-worker-ingest-v1" was readable in source and let anyone forge
  // oracle events into the display ring.
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "invalid worker token" }, { status: 401 });
  }

  const parsed = await parseBody(req, ingestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

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
