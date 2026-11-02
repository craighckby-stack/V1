import { NextResponse } from "next/server";
import { scanContent, summarizeFindings, SENSITIVE_PATTERNS } from "@/lib/pipeline/core/secret-scan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/secret-scan/scan
 *
 * Scan arbitrary content for secrets. Used by the UI's "scan a paste"
 * tool AND by automated smoke tests. This is the SAME scanner that runs
 * as the pre-push gate (push-target.ts preCommitSecretGate), exposed
 * standalone so the operator can see exactly what the gate would catch.
 * See docs/CONCEPTS-GRAFTED.md GRAFT 1.
 *
 * Body:
 *   { content: string, filePath?: string, blockOnMedium?: boolean }
 *
 * Returns:
 *   { ok, findings, summary: { block, worst, reason }, patternCount }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body || typeof body.content !== "string") {
      return NextResponse.json(
        { ok: false, error: "body.content (string) is required" },
        { status: 400 }
      );
    }
    const filePath = typeof body.filePath === "string" ? body.filePath : "paste.txt";
    const blockOnMedium = body.blockOnMedium === true;
    const findings = scanContent(body.content, filePath);
    // Strip the matchedText from each finding before returning — the
    // API should never echo a real secret back to the client. The
    // redactedPreview is the safe form.
    const safeFindings = findings.map((f) => ({
      patternId: f.patternId,
      patternName: f.patternName,
      severity: f.severity,
      confidence: f.confidence,
      redactedPreview: f.redactedPreview,
      filePath: f.filePath,
      line: f.line,
      lineContentRedacted: f.lineContent.replace(f.matchedText, f.redactedPreview),
    }));
    const summary = summarizeFindings(findings, blockOnMedium);
    return NextResponse.json({
      ok: true,
      findings: safeFindings,
      summary: { block: summary.block, worst: summary.worst ? {
        patternId: summary.worst.patternId,
        patternName: summary.worst.patternName,
        severity: summary.worst.severity,
        filePath: summary.worst.filePath,
        line: summary.worst.line,
      } : null, reason: summary.reason },
      patternCount: SENSITIVE_PATTERNS.length,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
