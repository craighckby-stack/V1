import { NextResponse } from "next/server";
import { emgRagInstance, type VectorEntry } from "@/lib/pipeline/emg/emg-rag";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/memory/query?q=<text>
 * Returns TF-IDF ranked top fixes + top failures with similarity scores,
 * the cognitive friction score, and the epistemic ruling.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q");

  if (!emgRagInstance) {
    return NextResponse.json(
      { error: "RAG service not properly initialized." },
      { status: 500 }
    );
  }

  if (!q || typeof q !== 'string' || !q.trim()) {
    return NextResponse.json(
      { error: "Missing or invalid ?q=<query> parameter. Query must be a non-empty string." },
      { status: 400 }
    );
  }

  // Prevent excessively long queries that could cause performance issues
  if (q.length > 1000) {
    return NextResponse.json(
      { error: "Query too long. Maximum length is 1000 characters." },
      { status: 400 }
    );
  }
  
  try {
    // Run seeding and querying in parallel to reduce latency.
    // Both operations are initiated concurrently.
    const [_, queryResultSequential] = await Promise.all([
      emgRagInstance.ensureSeeded(),
      emgRagInstance.query(q),
    ]);

    if (!queryResultSequential) {
      return NextResponse.json(
        { error: "RAG query returned no result." },
        { status: 500 }
      );
    }

    // Check for required properties and types
    if (!queryResultSequential.topFixes || !queryResultSequential.topFailures || 
        typeof queryResultSequential.cognitiveFrictionScore === 'undefined' || 
        typeof queryResultSequential.epistemicRuling === 'undefined') {
      return NextResponse.json(
        { error: "RAG query returned malformed result data. Missing required properties (topFixes, topFailures, cognitiveFrictionScore, or epistemicRuling)." },
        { status: 500 }
      );
    }

    // Helper to map and clean array elements
    const mapResultArray = (arr: VectorEntry[]) => 
      arr.map((e) => {
        if (e == null) return null;
        return {
          id: e.id,
          provenance: e.provenance,
          trust: e.trust,
          filePath: e.filePath,
          content: e.content,
          diagnosis: e.diagnosis,
          cleanSnippet: e.cleanSnippet,
          ruleToAvoid: e.ruleToAvoid,
          timestamp: e.timestamp,
        };
      }).filter((e): e is NonNullable<typeof e> => e !== null);

    const safeTopFixes = mapResultArray(queryResultSequential.topFixes);
    const safeTopFailures = mapResultArray(queryResultSequential.topFailures);

    return NextResponse.json({
      query: q,
      topFixes: safeTopFixes,
      topFailures: safeTopFailures,
      cognitiveFrictionScore: queryResultSequential.cognitiveFrictionScore,
      epistemicRuling: queryResultSequential.epistemicRuling,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during RAG service operation.";
    
    // Log the full error context internally for debugging, including the query 'q'.
    console.error(`[MemoryQueryError] Failed to execute memory query for "${q}". Error: ${errorMessage}`, err);
    
    return NextResponse.json(
      { 
        error: `Failed to execute memory query for "${q}". The RAG service encountered an internal error. Please check system logs for details.`,
        operation: "memory query"
      }, 
      { status: 500 }
    );
  }
}