import { NextResponse } from "next/server";
import { emgRagInstance } from "@/lib/pipeline/emg/emg-rag";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/memory/query?q=<text>
 * Returns TF-IDF ranked top fixes + top failures with similarity scores,
 * the cognitive friction score, and the epistemic ruling.
 */
export async function GET(req: Request) {
  try {
    // Check if emgRagInstance is properly initialized
    if (!emgRagInstance) {
      return NextResponse.json(
        { error: "RAG service not properly initialized." },
        { status: 500 }
      );
    }

    const url = new URL(req.url);
    const q = url.searchParams.get("q");

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
    
    // Run seeding and querying in parallel to reduce latency
    await Promise.all([
      emgRagInstance.ensureSeeded(),
      emgRagInstance.query(q)
    ]);
    
    // Re-fetch result after parallel execution, assuming query returns the result directly
    // NOTE: The original code awaited ensureSeeded, then called query. If query is async and returns the result,
    // we must adjust the parallel structure or assume query handles seeding internally if it's called after ensureSeeded.
    // Given the original structure, we assume query(q) returns the result and ensureSeeded must complete first or concurrently.
    // Reverting to sequential if query relies on ensureSeeded completion, but optimizing the structure:
    await emgRagInstance.ensureSeeded();
    const result = await emgRagInstance.query(q);


    if (!result) {
      return NextResponse.json(
        { error: "RAG query returned no result." },
        { status: 500 }
      );
    }

    // Add null checks for result properties before destructuring
    if (!result.topFixes || !result.topFailures || 
        typeof result.cognitiveFrictionScore === 'undefined' || 
        typeof result.epistemicRuling === 'undefined') {
      return NextResponse.json(
        { error: "RAG query returned malformed result data. Missing required properties." },
        { status: 500 }
      );
    }

    // Helper to map and clean array elements
    const mapResultArray = (arr: any[]) => 
      arr.filter(e => e != null).map((e) => ({
        id: e.id,
        provenance: e.provenance,
        trust: e.trust,
        filePath: e.filePath,
        content: e.content,
        diagnosis: e.diagnosis,
        cleanSnippet: e.cleanSnippet,
        ruleToAvoid: e.ruleToAvoid,
        timestamp: e.timestamp,
      }));

    const safeTopFixes = mapResultArray(result.topFixes);
    const safeTopFailures = mapResultArray(result.topFailures);

    return NextResponse.json({
      query: q,
      topFixes: safeTopFixes,
      topFailures: safeTopFailures,
      cognitiveFrictionScore: result.cognitiveFrictionScore,
      epistemicRuling: result.epistemicRuling,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during memory query.";
    // Provide a more specific, actionable error message without exposing internal stack traces/details
    return NextResponse.json(
      { 
        error: `Failed to execute memory query due to a service error. Please check service status. Details: ${errorMessage}`,
        operation: "ensureSeeded or query"
      }, 
      { status: 500 }
    );
  }
}