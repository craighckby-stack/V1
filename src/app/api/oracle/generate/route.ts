import { NextResponse } from "next/server";
import { z } from "zod";
import { generateProphecy, generateProphecies } from "@/lib/pipeline/oracle/prophecy-generator";
import { parseOptionalBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const oracleGenerateSchema = z.object({
  // Required here + defaults in parseOptionalBody: an empty/absent body
  // fails validation and falls back to count=1, so the merged type is
  // { count: number } (not number|undefined).
  count: z.number().int().min(1).max(10),
});

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
  // Missing/invalid body → count=1. A non-integer count falls back to 1
  // (the old code rounded and clamped; the zod int() check + default is
  // stricter and simpler).
  const { count } = await parseOptionalBody(req, oracleGenerateSchema, { count: 1 });

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
