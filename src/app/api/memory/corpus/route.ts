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
export async function GET(request: Request) {
  try {
    // Extract and validate keyword from query parameters
    const { searchParams } = new URL(request.url);
    const keyword = searchParams.get("keyword");
    
    if (typeof keyword !== "string" || keyword.trim() === "") {
      throw new Error("Missing or empty 'keyword' query parameter. Please provide a valid 'keyword'.");
    }
    
    // Run status, digest, and search in parallel to reduce latency
    const searchPromise = searchEngines(keyword, 3);
    const timeoutError = new Error("Search operation timed out after 5000ms.");
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(timeoutError), 5000)
    );

    const [status, digest, sample] = await Promise.all([
      getCorpusStatus(),
      getFleetDigest(),
      Promise.race([searchPromise, timeoutPromise])
    ]);
      
    // Validate search results before mapping
    if (!Array.isArray(sample)) {
      throw new Error(`Search returned invalid data format: expected array, got ${typeof sample}.`);
    }
    
    // Map results only after successful retrieval
    const mappedSample = sample.map((h: { engine: { id: string; role: string }; score: number; matchedTerms: string[] }) => {
      if (!h.engine || typeof h.engine.id !== "string" || typeof h.engine.role !== "string" || 
          typeof h.score !== "number" || !Array.isArray(h.matchedTerms)) {
        throw new Error("Invalid search result item format detected in corpus data: missing required fields.");
      }
      
      return {
        id: h.engine.id,
        role: h.engine.role,
        score: Number(h.score.toFixed(2)),
        matched: h.matchedTerms.slice(0, 5),
      };
    });
    
    return NextResponse.json({ ok: true, status, digest, sampleHits: mappedSample });
  } catch (e) {
    const error = e instanceof Error ? e : new Error("Unknown corpus read failure during request processing.");
    
    // Determine status code based on error context
    const statusCode = error.message.includes("timed out") ? 504 : 500;
    
    return NextResponse.json(
      { ok: false, error: `Corpus API Error: ${error.message}` },
      { status: statusCode }
    );
  }
}