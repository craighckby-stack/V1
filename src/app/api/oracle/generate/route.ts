import { NextResponse } from "next/server";
import { generateProphecy, generateProphecies } from "@/lib/pipeline/oracle/prophecy-generator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/oracle/generate
 *
 * Trigger the Oracle to produce one (or N) prophecies. The LLM call is
 * synchronous from the route's perspective — the request blocks until
 * the prophecy is generated (or rejected). For long-running multi-
 * prophecy batches, the client should expect ~5-15s per prophecy.
 *
 * Body (optional):
 *   { "count": <integer 1-10> }  — how many prophecies to generate.
 *   Defaults to 1. Capped at 10 to bound LLM cost per request.
 *
 * Returns:
 *   { ok: true, generated: ProphecyRow[], failures: Array<{reason,error}> }
 *
 * Failures are surfaced honestly. A prophecy can fail generation for
 * four reasons: llm-unavailable (z-ai down or 429), unparseable (LLM
 * returned non-JSON), invalid-shape (JSON but fields missing/malformed),
 * store-failed (DB write error). The UI surfaces these so the operator
 * knows the system isn't silently dropping predictions.
 */
export async function POST(req: Request) {
  let count = 1;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.count === "number" && Number.isFinite(body.count)) {
      count = Math.max(1, Math.min(10, Math.round(body.count)));
    }
  } catch {
    /* body wasn't JSON — use default count of 1 */
  }

  try {
    if (count === 1) {
      const result = await generateProphecy();
      if (result.ok && result.prophecy) {
        return NextResponse.json({
          ok: true,
          generated: [result.prophecy],
          failures: [],
        });
      }
      return NextResponse.json({
        ok: false,
        generated: [],
        failures: [{ reason: result.reason ?? "unknown", error: result.error ?? "unknown" }],
      });
    }
    // Multi-prophecy batch
    const { generated, failures } = await generateProphecies(count);
    return NextResponse.json({
      ok: generated.length > 0,
      generated,
      failures,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, generated: [], failures: [], error: (err as Error).message },
      { status: 500 },
    );
  }
}
