import { NextResponse } from "next/server";
import { getCorpusStatus, getFleetDigest, searchEngines } from "@/lib/pipeline/autonomous/githistory-corpus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/memory/corpus
 *
 * Operator-facing view of the GitHistory-Sync corpus (the three
 * memory/commit-history.*.json archive files the operator's sibling
 * project keeps in sync). Read-only, no LLM, no DB — a pure file read
 * through the corpus module's lazy loader:
 *
 *   - status: loaded flag + engine/failed/successful/repo counts +
 *     the archive's generatedAt
 *   - digest: the exact bounded fleet digest the lesson distiller
 *     appends to its history digest (so the operator can audit what
 *     evidence the distiller sees, including the honest CI-pending
 *     split of the "failed" bucket)
 *   - sampleHits: what searchEngines returns for a demo keyword, so
 *     the prior-art retrieval is visible without running a cycle
 */
export async function GET() {
  try {
    const status = getCorpusStatus();
    const digest = getFleetDigest();
    
    // Validate search keyword
    const keyword = "orchestrator agent loop";
    if (typeof keyword !== "string" || keyword.trim() === "") {
      throw new Error("Invalid search keyword: must be a non-empty string");
    }
    
    // Add timeout to prevent hanging
    const sample = await Promise.race([
      searchEngines(keyword, 3).map((h) => ({
        id: h.engine.id,
        role: h.engine.role,
        score: Number(h.score.toFixed(2)),
        matched: h.matchedTerms.slice(0, 5),
      })),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Search timed out")), 5000)
      )
    ]);
    
    return NextResponse.json({ ok: true, status, digest, sampleHits: sample });
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : "corpus read failed";
    const statusCode = e instanceof Error && e.message.includes("timeout") ? 504 : 500;
    return NextResponse.json(
      { ok: false, error: errorMessage },
      { status: statusCode }
    );
  }
}