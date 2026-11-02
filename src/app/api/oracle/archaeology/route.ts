/**
 * GET /api/oracle/archaeology?repo=owner/name&branch=main&maxCommits=30
 *
 * Mines the target repo's git history, runs the three-pass wrong/correct
 * pairing (revert + fix-overlap + self-identified-failure flag), and
 * returns the pairs. The Oracle can use these as a free, self-labeled
 * prophecy dataset — no human labeling, no LLM judgment, just the
 * revert/fix messages the authors already wrote.
 *
 * Optional query params:
 *   token     — override the configured push-target PAT (else uses it)
 *   maxCommits — cap on commits fetched (default 30, max 100)
 *
 * Response: { repo, branch, pairs: [...], counts: { total, correct, wrong, pairs }, deadlineMs }
 *
 * POST with the same query params additionally SEEDS one prophecy per
 * pair into the Oracle (domain "archaeology"), with a horizon of 8
 * cycles. Returns the pairs + the count seeded.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  fetchHistoryWithFiles,
  classifyCommitPairs,
  archaeologyPairToProphecyInput,
  flagSelfIdentifiedFailures,
} from "@/lib/pipeline/oracle/commit-archaeology";
import { createProphecy } from "@/lib/pipeline/oracle/prophecy-store";
import { emitOracleEvent } from "@/lib/pipeline/oracle/oracle-events";
import { getStoredTarget } from "@/lib/pipeline/autonomous/push-target";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const repo = sp.get("repo");
  const branch = sp.get("branch") ?? "main";
  const maxCommitsParam = sp.get("maxCommits");
  const maxCommits = maxCommitsParam ? Math.min(parseInt(maxCommitsParam, 10) || 30, 100) : 30;
  const tokenParam = sp.get("token");

  if (!repo) {
    return NextResponse.json({ error: "repo query param required (owner/name)" }, { status: 400 });
  }

  // Token resolution: explicit param → configured push-target PAT → none.
  let token: string | null = tokenParam && tokenParam.length >= 20 ? tokenParam : null;
  if (!token) {
    try {
      const target = await getStoredTarget();
      if (target) token = target.token;
    } catch {
      /* no stored target — proceed unauthenticated (public repo only) */
    }
  }

  try {
    const commits = await fetchHistoryWithFiles({ repo, branch, token, maxCommits });
    // ORDER MATTERS: classify the pairs FIRST (revert + fix-overlap),
    // THEN flag self-identified failures on the STILL-NEUTRAL commits
    // for enrichment. Running the flag first would pre-mark fix-commits
    // as WRONG (their bodies often contain "revert"/"failed") and block
    // classifyCommitPairs' pass 2 from turning them into CORRECT.
    const { pairs, commits: classified } = classifyCommitPairs(commits);
    const enriched = flagSelfIdentifiedFailures(classified);
    const counts = {
      total: enriched.length,
      withFiles: enriched.filter((c) => c.files.length > 0).length,
      correct: enriched.filter((c) => c.verdict === "CORRECT").length,
      wrong: enriched.filter((c) => c.verdict === "WRONG").length,
      pairs: pairs.length,
    };
    // Diagnostic sample: first 15 commits with their verdicts + file
    // counts, so the operator can see WHY pairing found what it found
    // (e.g. "the fix commit's subject didn't match FIX_PATTERN", or
    // "the preceding commit had no overlapping files"). Add &debug=full
    // for all of them.
    const debugFull = sp.get("debug") === "full";
    const sample = enriched.slice(0, debugFull ? enriched.length : 15).map((c) => ({
      short: c.shortHash,
      subject: c.subject.slice(0, 60),
      verdict: c.verdict,
      files: c.files.length,
    }));
    return NextResponse.json({ repo, branch, pairs, counts, sample, maxCommits });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** POST — same as GET but additionally seeds one prophecy per pair. */
export async function POST(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const repo = sp.get("repo");
  const branch = sp.get("branch") ?? "main";
  const maxCommitsParam = sp.get("maxCommits");
  const maxCommits = maxCommitsParam ? Math.min(parseInt(maxCommitsParam, 10) || 30, 100) : 30;
  const tokenParam = sp.get("token");

  if (!repo) {
    return NextResponse.json({ error: "repo query param required (owner/name)" }, { status: 400 });
  }

  let token: string | null = tokenParam && tokenParam.length >= 20 ? tokenParam : null;
  if (!token) {
    try {
      const target = await getStoredTarget();
      if (target) token = target.token;
    } catch {
      /* no stored target */
    }
  }

  try {
    const commits = await fetchHistoryWithFiles({ repo, branch, token, maxCommits });
    const { pairs } = classifyCommitPairs(commits);

    // Seed one prophecy per pair. Horizon = 8 cycles ≈ 80 min at the
    // default 10-min interval; the evaluator judges after that.
    let seeded = 0;
    for (const pair of pairs) {
      const input = archaeologyPairToProphecyInput(pair);
      // evaluateBy = createdAt + 80 min (a rough "8 cycles" proxy — the
      // scheduler's evaluator will pick it up after the deadline).
      const evaluateBy = new Date(Date.now() + 80 * 60 * 1000);
      const created = await createProphecy({
        claim: input.claim,
        confidence: 0.5, // archaeology-seeded, not LLM-judged — neutral
        rationale: input.rationale,
        falsifiabilityCriterion: input.falsifiabilityCriterion,
        evaluateBy,
        contextSha: input.contextSha,
        domain: input.domain,
      });
      if (created) seeded++;
    }
    emitOracleEvent(
      `Commit-archaeology: mined ${pairs.length} wrong/correct pair(s) from ${repo}:${branch}, seeded ${seeded} prophecies (domain: archaeology).`,
      "info",
      "generator",
    );
    return NextResponse.json({ repo, branch, pairs, seeded, counts: { pairs: pairs.length } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
