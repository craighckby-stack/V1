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
    await emgRagInstance.ensureSeeded();
    const url = new URL(req.url);
    const q = url.searchParams.get("q");

    if (!q || typeof q !== 'string' || !q.trim()) {
      return NextResponse.json(
        { error: "Missing or invalid ?q=<query> parameter. Query must be a non-empty string." },
        { status: 400 }
      );
    }
    
    const result = await emgRagInstance.query(q);

    if (!result) {
      return NextResponse.json(
        { error: "RAG query returned no result." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      query: q,
      topFixes: result.topFixes.map((e) => ({
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
      topFailures: result.topFailures.map((e) => ({
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
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during memory query.";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}