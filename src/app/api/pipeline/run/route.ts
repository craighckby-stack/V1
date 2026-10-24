import { NextResponse } from "next/server";
import {
  unifiedPipelineRunnerInstance,
  PipelineConfig,
  PipelineExecutionReport,
} from "@/lib/pipeline/core/unified-pipeline";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/pipeline/run
 *
 * Manual single-file pipeline execution. Accepts a PipelineConfig JSON body
 * and runs the full 6-stage helper pipeline, persisting the result to the
 * PipelineRun table for later inspection via /api/pipeline/history.
 */
export async function POST(req: Request) {
  try {
    const config = (await req.json()) as PipelineConfig;

    if (!config.targetRepo || !config.filePath || typeof config.code !== "string") {
      return NextResponse.json(
        { error: "targetRepo, filePath, and code are required" },
        { status: 400 }
      );
    }

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
          originalCode: report.originalCode.slice(0, 200000),
          evolvedCode: report.evolvedCode.slice(0, 200000),
          sanitizerClean: report.sanitizerResult.clean,
          violations: JSON.stringify(report.sanitizerResult.violations),
          triggeredBy: fullConfig.triggeredBy ?? "manual",
        },
      });
    } catch (dbErr) {
      console.warn("[/api/pipeline/run] DB persist failed:", (dbErr as Error).message);
    }

    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
