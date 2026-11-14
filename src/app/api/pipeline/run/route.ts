import { NextResponse } from "next/server";
import { z } from "zod";
import {
  unifiedPipelineRunnerInstance,
  PipelineConfig,
  PipelineExecutionReport,
} from "@/lib/pipeline/core/unified-pipeline";
import { db } from "@/lib/db";
import { parseBody, REPO_REGEX, isRepoRelativePath } from "@/lib/api/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/pipeline/run
 *
 * Manual single-file pipeline execution. Accepts a PipelineConfig JSON body
 * and runs the full 6-stage helper pipeline, persisting the result to the
 * PipelineRun table (a durable audit trail queryable directly in the DB;
 * the unused /api/pipeline/history read route was removed in the endpoint
 * cleanup).
 *
 * Validation: `code` is arbitrary content that flows into the full pipeline
 * (LLM, AST, sanitizer, sandbox tests). The old route did a bare cast — a
 * missing `filePath` or a `../` traversal in it would flow downstream. The
 * schema below caps `code` at 500KB (rejects absurd payloads), requires
 * `targetRepo` to match `owner/name`, and forces `filePath` to be
 * repo-relative. Optional fields with defaults remain optional; `.strict()`
 * rejects unknown keys so a body can't smuggle extra fields into the
 * persisted `PipelineRun` row.
 */
const pipelineConfigSchema = z.object({
  githubToken: z.string().max(500).optional(),
  targetRepo: z.string().regex(REPO_REGEX, "targetRepo must be 'owner/name'").max(100),
  targetBranch: z.string().min(1).max(100).optional(),
  evolutionBranch: z.string().min(1).max(100).optional(),
  filePath: z
    .string()
    .min(1)
    .max(500)
    .refine(isRepoRelativePath, "filePath must be repo-relative (no .. or leading /)"),
  userPrompt: z.string().min(1).max(8000).optional(),
  siphonSourceId: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(500_000),
  triggeredBy: z.enum(["manual", "autonomous", "watch", "continuous", "scheduled"]).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, pipelineConfigSchema);
    if (!parsed.ok) return parsed.response;

    const config = parsed.data;

    // Apply sane defaults so callers can omit optional fields.
    const fullConfig: PipelineConfig = {
      ...config,
      targetBranch: config.targetBranch ?? "main",
      evolutionBranch: config.evolutionBranch ?? "helper-evolution",
      siphonSourceId: config.siphonSourceId ?? "pattern-optimizer-helper",
      userPrompt: config.userPrompt ?? "Apply 5-pillar modular refactoring.",
      triggeredBy: config.triggeredBy ?? "manual",
    };

    const report: PipelineExecutionReport =
      await unifiedPipelineRunnerInstance.runPipeline(fullConfig);

    // Best-effort persistence; do not fail the request on DB errors.
    try {
      await db.pipelineRun.create({
        data: {
          pipelineId: report.id,
          targetRepo: fullConfig.targetRepo,
          targetBranch: fullConfig.targetBranch,
          evolutionBranch: fullConfig.evolutionBranch,
          filePath: fullConfig.filePath,
          userPrompt: fullConfig.userPrompt,
          siphonSourceId: fullConfig.siphonSourceId,
          status: report.status,
          astScore: report.astDiffResult.astScore,
          consensus: report.reviewVerdict.consensus,
          proofHash: report.proofCommitHash,
          // audit 3 — unbounded DB growth + 400KB/run: cap the stored code
          // blobs at 20KB each (the full code lives in git history anyway).
          originalCode: report.originalCode.slice(0, 20000),
          evolvedCode: report.evolvedCode.slice(0, 20000),
          sanitizerClean: report.sanitizerResult.clean,
          violations: JSON.stringify(report.sanitizerResult.violations),
          triggeredBy: fullConfig.triggeredBy ?? "manual",
        },
      });
    } catch (dbErr) {
      console.warn("[/api/pipeline/run] DB persist failed:", (dbErr as Error).message);
    }

    // audit 3 — unbounded DB growth (the SQLite file was 178MB with no
    // pruning): keep only the newest 25 PipelineRun rows, delete the rest.
    // Best-effort by design — a prune failure must never fail the request.
    try {
      const keep = await db.pipelineRun.findMany({
        orderBy: { createdAt: "desc" },
        take: 25,
        select: { id: true },
      });
      if (keep.length > 0) {
        await db.pipelineRun.deleteMany({
          where: { id: { notIn: keep.map((k) => k.id) } },
        });
      }
    } catch (pruneErr) {
      console.warn(
        "[/api/pipeline/run] prune failed (non-fatal):",
        (pruneErr as Error).message
      );
    }

    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
