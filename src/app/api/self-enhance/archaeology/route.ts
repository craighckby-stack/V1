import { NextResponse } from "next/server";
import { z } from "zod";
import { runArchaeology, readArchaeologyReport } from "@/lib/pipeline/autonomous/archaeology";
import { parseOptionalBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Archaeology — deterministic git-history mining (CAE port).
 *
 * The loop's memory (Lesson/MutationCorpus) only accumulates from
 * RUNTIME failures. This endpoint mines the repo's own git history —
 * the pre-loop human era — with the proven 3-path detector
 * (revert / self-fail / fix-pair), seeding cross-file failure themes
 * as Lesson rows (sourceType "archaeology") and writing a per-file
 * fragility/stability report to postmortems/archaeology-report.json.
 *
 * Deterministic end to end: zero LLM calls, safe to run while the LLM
 * gate is 429-blocked (arguably the best time — quota that can't be
 * spent on mutations costs nothing to spend on memory).
 *
 *   GET                → { report | null }
 *   POST { force? }    → { ok, report }
 *
 * Lives under /api/self-enhance/ on purpose: that subtree is in
 * PROTECTED_PREFIXES, so the loop can never rewrite the endpoint that
 * feeds its own long-term memory.
 */

export async function GET() {
  try {
    return NextResponse.json({ report: readArchaeologyReport() });
  } catch (err) {
    return NextResponse.json({ report: null, error: (err as Error).message }, { status: 500 });
  }
}

const archaeologyPostSchema = z.object({
  force: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const { force } = await parseOptionalBody(req, archaeologyPostSchema, { force: false });
    const report = await runArchaeology(force);
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
