import { NextResponse } from "next/server";
import { buildPolicyReport } from "@/lib/pipeline/autonomous/mutation-policy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/policy
 *
 * The learned mutation policy — 10/10 roadmap #6. Two tiers of
 * estimated parameters (never hand-written rules):
 *
 *   own  — pass rates by transform family from the loop's own
 *          MutationCorpus (Laplace-smoothed, recency-decayed,
 *          deferred below MIN_OWN_ATTEMPTS per family)
 *   wild — success rates by change kind from the harvested fleet
 *          archive (memory/commit-history.*.json — the corpus you
 *          pushed), with evidence weighting (reverted/ci-failed full,
 *          regex-fail half) and declared confounders
 *
 * The verdict field says which tier is currently injected into refactor
 * prompts (or "silent" when both are empty). Constants are included so
 * the operator can audit every tunable in one read.
 */
export async function GET() {
  try {
    const report = await buildPolicyReport();
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: `policy report failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
