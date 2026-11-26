import { NextResponse } from "next/server";
import { getCorpusStatus, getFleetDigest, searchEngines } from "@/lib/pipeline/autonomous/githistory-corpus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_MATCHED_TERMS = 5;
const SEARCH_TIMEOUT_MS = 5000;

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
  // Extract and validate keyword from query parameters first
  const { searchParams } = new URL(request.url);
  const keyword = searchParams.get("keyword");
  
  if (typeof keyword !== "string" || keyword.trim() === "") {
    return NextResponse.json(
      { ok: false, error: "Missing or empty 'keyword' query parameter. Please provide a valid 'keyword'." },
      { status: 400 }
    );
  }
  
  try {
    // Run status, digest, and search in parallel to reduce latency
    const searchPromise = searchEngines(keyword, 3);
    
    // Wrap timeout in a promise that rejects after 5000ms
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Search operation timed out after 5000ms.")), SEARCH_TIMEOUT_MS)
    );

    // Execute status, digest, and the race (search vs timeout) in parallel
    const [status, digest, searchResult] = await Promise.all([
      getCorpusStatus(),
      getFleetDigest(),
      Promise.race([searchPromise, timeoutPromise])
    ]);
      
    // Validate search results before mapping
    if (!Array.isArray(searchResult)) {
      // This handles cases where searchEngines resolves successfully but returns non-array data
      throw new Error(`Search returned invalid data format: expected array, got ${typeof searchResult}.`);
    }
    
    // Optimization: If no results, return immediately without mapping overhead
    if (searchResult.length === 0) {
        return NextResponse.json({ ok: true, status, digest, sampleHits: [] });
    }

    // Map results only after successful retrieval
    const mappedSample = searchResult.map((h: { engine: { id: string; role: string }; score: number; matchedTerms: string[] }) => {
      if (!h.engine || typeof h.engine.id !== "string" || typeof h.engine.role !== "string" || 
          typeof h.score !== "number" || !Array.isArray(h.matchedTerms)) {
        throw new Error("Invalid search result item format detected in corpus data: missing required fields.");
      }
      
      return {
        id: h.engine.id,
        role: h.engine.role,
        score: Number(h.score.toFixed(2)),
        matched: h.matchedTerms.slice(0, MAX_MATCHED_TERMS),
      };
    });
    
    return NextResponse.json({ ok: true, status, digest, sampleHits: mappedSample });
  } catch (e) {
    const error = e instanceof Error ? e : new Error("Unknown corpus read failure during request processing.");
    
    // Determine status code based on error context
    if (error.message === "Search operation timed out after 5000ms.") {
        return NextResponse.json(
          { ok: false, error: "Search operation timed out." },
          { status: 504 }
        );
    }
    
    // For all other errors (validation, data format, internal library errors), return 500
    // Provide a more actionable internal error message context for debugging, while keeping client response generic.
    console.error("Corpus API Error:", error.message, error.stack);
    
    // Since input validation (400) is handled before the try block, any error reaching here is internal (500).
    return NextResponse.json(
      { ok: false, error: "Internal server error while accessing corpus data." },
      { status: 500 }
    );
  }
}