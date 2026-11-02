import { NextResponse } from "next/server";
import { readOracleEvents, currentOracleSeq } from "@/lib/pipeline/oracle/oracle-events";
// Boot the scheduler on first events poll too (idempotent) — the events
// poll starts as soon as the page loads, so evaluation begins early.
import "@/lib/pipeline/oracle/oracle-scheduler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/oracle/events
 *
 * Returns the oracle's in-memory event ring buffer (prophecies made,
 * verdicts rendered, scheduler activity) — the display feed that the
 * unified console stream polls so background oracle activity surfaces
 * live, the same way loop logs do.
 *
 * Query params:
 *   since — sequence cursor (total appends the caller has already
 *   seen). When provided, only events appended after that cursor are
 *   returned. Omit on the first poll to snapshot the whole buffer.
 *
 * Response: { ok, events: OracleEvent[], seq }
 *   `seq` is the total-append high-water mark — pass it back as `since`
 *   on the next poll to receive only fresh events.
 *
 * Ring semantics: the buffer retains the most recent 200 appends. If
 * the caller was idle so long that older fresh events were evicted,
 * they're simply gone (the ring is a display buffer, not a record —
 * the Prophecy table is the record). The caller's timestamp|message
 * dedup makes any overlap harmless.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  let since: number | undefined;
  if (sinceParam !== null) {
    const parsed = Number(sinceParam);
    if (Number.isFinite(parsed) && parsed >= 0) since = parsed;
  }

  try {
    const { events, seq } = readOracleEvents();

    if (since === undefined) {
      // First poll — full snapshot.
      return NextResponse.json({ ok: true, events, seq });
    }

    // Cursor poll. The caller has seen `since` appends. Fresh appends
    // are (since+1 .. seq) — that's (seq - since) events. The buffer
    // holds only the LAST min(seq, 200) appends, so the freshest we
    // can still provide is the last min(seq - since, buffer.length)
    // events.
    const freshCount = Math.min(seq - since, events.length);
    const fresh = freshCount > 0 ? events.slice(events.length - freshCount) : [];
    return NextResponse.json({ ok: true, events: fresh, seq });
  } catch (err) {
    return NextResponse.json(
      { ok: false, events: [], seq: currentOracleSeq(), error: (err as Error).message },
      { status: 500 },
    );
  }
}
