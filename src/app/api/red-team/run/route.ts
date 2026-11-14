import { NextResponse } from "next/server";
import { z } from "zod";
import { runRedTeamSuite } from "@/lib/pipeline/red-team/red-team-runner";
import { parseOptionalBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A red-team run makes up to 7 LLM calls (one per probe). Cap the route
// timeout well above the SDK's own backoff window.
export const maxDuration = 300;

const redTeamSchema = z.object({
  skipLlm: z.boolean().optional(),
});

/**
 * POST /api/red-team/run
 *
 * Manually trigger a red-team suite run. Each probe is sent to the LLM
 * enhancement path; the output is classified as REFUSAL (blocked) or
 * COMPLY (bypassed). A containment bypass raises safe-mode via the
 * runner→duress bridge, halting the autonomous loop until cleared.
 *
 * Body (optional):
 *   { skipLlm?: boolean }  — dry-run: report the suite shape without
 *                          making LLM calls. Probes get verdict SKIPPED.
 *
 * Returns the full run summary. See docs/CONCEPTS-GRAFTED.md GRAFT 4.
 */
export async function POST(req: Request) {
  try {
    const { skipLlm } = await parseOptionalBody(req, redTeamSchema, { skipLlm: false });
    const summary = await runRedTeamSuite({ skipLlm });
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
