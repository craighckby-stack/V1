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
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) {
      return NextResponse.json(
        { error: "Missing ?q=<query> parameter" },
        { status: 400 }
      );
    }
    const result = emgRagInstance.query(q);
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
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
