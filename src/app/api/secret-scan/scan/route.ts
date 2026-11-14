import { NextResponse } from "next/server";
import { z } from "zod";
import { scanContent, summarizeFindings, SENSITIVE_PATTERNS } from "@/lib/pipeline/core/secret-scan";
import { parseBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const secretScanSchema = z.object({
  content: z.string().min(1).max(500_000),
  filePath: z.string().min(1).max(500).optional(),
  blockOnMedium: z.boolean().optional(),
}).strict();

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
    const parsed = await parseBody(req, secretScanSchema);
    if (!parsed.ok) return parsed.response;

    const filePath = parsed.data.filePath ?? "paste.txt";
    const blockOnMedium = parsed.data.blockOnMedium === true;
    const findings = scanContent(parsed.data.content, filePath);
    // Strip the matchedText from each finding before returning — the
    // API should never echo a real secret back to the client. The
    // redactedPreview is the safe form. The replacement uses the
    // FUNCTION form of .replace so `$&`/`$'`-style patterns inside
    // matchedText can't be interpreted as substitution directives
    // (audit H7 — the old string form could leave the secret unredacted
    // in the echoed line content).
    const safeFindings = findings.map((f) => ({
      patternId: f.patternId,
      patternName: f.patternName,
      severity: f.severity,
      confidence: f.confidence,
      redactedPreview: f.redactedPreview,
      filePath: f.filePath,
      line: f.line,
      lineContentRedacted: f.lineContent.replace(f.matchedText, () => f.redactedPreview),
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
