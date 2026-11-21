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
    // Run status and digest retrieval in parallel with search operation
    const [status, digest] = await Promise.all([
      getCorpusStatus(),
      getFleetDigest()
    ]);
    
    // Keyword is hardcoded and guaranteed to be valid for this endpoint's purpose.
    const keyword = "orchestrator agent loop";
    
    // Add timeout to prevent hanging, wrapping the actual async call.
    let sample;
    try {
      sample = await Promise.race([
        searchEngines(keyword, 3),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Search timed out")), 5000)
        )
      ]);
      
      // Map results only after successful retrieval
      sample = sample.map((h: { engine: { id: string; role: string }; score: number; matchedTerms: string[] }) => ({
        id: h.engine.id,
        role: h.engine.role,
        score: Number(h.score.toFixed(2)),
        matched: h.matchedTerms.slice(0, 5),
      }));

    } catch (searchError) {
      if (searchError instanceof Error && searchError.message.includes("Search timed out")) {
        throw new Error("Search operation timed out after 5 seconds");
      }
      // Provide context on search failure
      throw new Error(`Failed to retrieve search samples for keyword "${keyword}": ${searchError instanceof Error ? searchError.message : "Unknown search error"}`);
    }
    
    return NextResponse.json({ ok: true, status, digest, sampleHits: sample });
  } catch (e) {
    const error = e instanceof Error ? e : new Error("Unknown corpus read failure");
    
    // Determine status code based on error message context
    const statusCode = error.message.includes("timed out") ? 504 : 
                      error.message.includes("Search operation timed out") ? 504 : 500;
    
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: statusCode }
    );
  }
}