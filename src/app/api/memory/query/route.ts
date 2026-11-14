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
      console.error("RAG service not properly initialized.");
      return NextResponse.json(
        { error: "RAG service not properly initialized. Cannot process memory queries." },
        { status: 500 }
      );
    }

    await emgRagInstance.ensureSeeded();
    const url = new URL(req.url);
    const q = url.searchParams.get("q");

    if (!q || q.trim().length === 0) {
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
    
    const result = await emgRagInstance.query(q);

    if (!result) {
      return NextResponse.json(
        { error: "RAG query returned no result for the given query." },
        { status: 500 }
      );
    }

    // Add strict checks for result properties before destructuring
    if (!result.topFixes || !result.topFailures || 
        typeof result.cognitiveFrictionScore !== 'number' || 
        typeof result.epistemicRuling !== 'string') {
      return NextResponse.json(
        { error: "RAG query returned malformed result data. Missing or invalid required properties (topFixes, topFailures, cognitiveFrictionScore, epistemicRuling)." },
        { status: 500 }
      );
    }

    // Add null checks for array elements before mapping
    const safeTopFixes = result.topFixes.filter((e): e is typeof result.topFixes[number] => e != null);
    const safeTopFailures = result.topFailures.filter((e): e is typeof result.topFailures[number] => e != null);

    return NextResponse.json({
      query: q,
      topFixes: safeTopFixes.map((e) => ({
        id: e.id,
        provenance: e.provenance,
        trust: e.trust,
        filePath: e.filePath,
        content: e.content,
        diagnosis: e.diagnosis,
        cleanSnippet: e.cleanSnippet,
        ruleToAvoid: e.ruleToAvoid,
        timestamp: e.timestamp,
      })),
      topFailures: safeTopFailures.map((e) => ({
        id: e.id,
        provenance: e.provenance,
        trust: e.trust,
        filePath: e.filePath,
        content: e.content,
        diagnosis: e.diagnosis,
        cleanSnippet: e.cleanSnippet,
        ruleToAvoid: e.ruleToAvoid,
        timestamp: e.timestamp,
      })),
      cognitiveFrictionScore: result.cognitiveFrictionScore,
      epistemicRuling: result.epistemicRuling,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during memory query execution.";
    console.error("Error executing memory query:", err); // Log full error internally
    
    // Return a generic, actionable error message to the client to prevent leaking internal stack traces or implementation details.
    return NextResponse.json(
      { 
        error: "Failed to execute memory query due to an internal service error. Please check the query parameters and try again."
      }, 
      { status: 500 }
    );
  }
}