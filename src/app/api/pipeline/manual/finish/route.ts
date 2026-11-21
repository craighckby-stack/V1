import { NextResponse } from "next/server";
import {
  normalizeTargetRepo,
  validTargetRepoFormat,
  validTargetBranchFormat,
} from "@/lib/pipeline/target/target-store";
import { isMutableTargetPath } from "@/lib/pipeline/target/target-scan";
import {
  postmortemStore,
  generatePostmortemFromReport,
} from "@/lib/pipeline/postmortem/postmortem-store";
import type { AstDiffResult } from "@/lib/pipeline/core/ast-diff-gate";
import type { SecuritySanitizerResult } from "@/lib/pipeline/emg/sanitizer";
import type { DebateVerdict } from "@/lib/pipeline/emg/debate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/pipeline/manual/finish — the manual-gauntlet's FEEDBACK-ONLY
 * close. The manual runner pushes survivors itself (via /api/github/
 * commit-file, the operator-driven path); this route is the labeled
 * feedback that the manual path was missing.
 *
 *   Operator decision "B": manual runs are a SANDBOX, not the population.
 *   - AST/tribunal failure → postmortem scar keyed to the TARGET
 *     repo+branch+file, labeled `source: "manual"` and symptom-prefixed
 *     `[manual-gauntlet]` for operator clarity. Retrievable for analysis
 *     (same (repo, branch, filePath) key as any scar) but EXCLUDED from
 *     the autonomous lesson distiller (which filters to source:
 *     "autonomous").
 *   - zero-diff saturation → same scar, with the loop's churn guard
 *     (don't re-record an existing ZERO_DIFF_SATURATION).
 *   - COMPLETED → resolve any prior scar on this file (manual success
 *     contradicts an active candidate scar the same way an autonomous
 *     success does).
 *   - mutation-guard reject → SKIP. The pipeline already wrote a
 *     specific mutation-guard scar (unified-pipeline.ts, tagged with
 *     source from triggeredBy); recording again would upsert-overwrite
 *     the specific diagnosis with a generic "review rejected".
 *
 *   Auto runs NEVER touch Lesson/MutationCorpus/SelfModel — those stay
 *   exclusively the autonomous loop's population. Manual runs are the
 *   same: feedback is postmortem-only, never the distiller's input.
 *
 *   No push: the manual runner already pushed via commit-file. This
 *   route's body carries the push OUTCOME (pushed / commitSha /
 *   pushError) so the feedback line can report it, but it does not
 *   perform the push.
 */

/** The minimal structural shape of a PipelineExecutionReport the
 *  finish flow needs (the client round-trips what /api/pipeline/run
 *  produced, so the cast is a re-parse of our own output). */
interface FinishReport {
  status: string;
  originalCode: string;
  evolvedCode: string;
  proofCommitHash: string;
  config: { filePath: string; userPrompt: string };
  astDiffResult: AstDiffResult;
  sanitizerResult: SecuritySanitizerResult;
  reviewVerdict: DebateVerdict;
  haltState?: { reason?: string; shouldHalt?: boolean } | null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      repo?: string;
      branch?: string;
      report?: FinishReport;
      pushed?: boolean;
      commitSha?: string;
      pushError?: string;
    };

    const repo = normalizeTargetRepo(typeof body.repo === "string" ? body.repo : "");
    if (!validTargetRepoFormat(repo)) {
      return NextResponse.json({ error: `Invalid repo "${body.repo ?? ""}"` }, { status: 400 });
    }
    if (typeof body.branch !== "string" || !validTargetBranchFormat(body.branch.trim())) {
      return NextResponse.json({ error: `Invalid branch "${body.branch ?? ""}"` }, { status: 400 });
    }
    const branch = body.branch.trim();

    const report = body.report;
    if (!report) {
      return NextResponse.json(
        { error: "report is required" },
        { status: 400 }
      );
    }
    // Validate every field the route later dereferences — a malformed
    // report should get a 400 naming the missing field, not a generic 500
    // from a null deref deep in the feedback path.
    const missing: string[] = [];
    if (typeof report.status !== "string") missing.push("report.status");
    if (!report.config?.filePath) missing.push("report.config.filePath");
    if (typeof report.evolvedCode !== "string") missing.push("report.evolvedCode");
    if (typeof report.originalCode !== "string") missing.push("report.originalCode");
    if (!report.astDiffResult || typeof report.astDiffResult.passed !== "boolean") missing.push("report.astDiffResult.passed");
    if (!report.reviewVerdict || typeof report.reviewVerdict.consensus !== "string") missing.push("report.reviewVerdict.consensus");
    if (typeof report.proofCommitHash !== "string") missing.push("report.proofCommitHash");
    if (typeof report.config?.userPrompt !== "string") missing.push("report.config.userPrompt");
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `report missing required fields: ${missing.join(", ")}` },
        { status: 400 }
      );
    }
    const filePath = report.config.filePath;
    // Defense in depth: never record feedback on a path the mutation
    // scope refuses (protected control-surface names, test files,
    // non-source). Matches /auto/finish's guard.
    if (!isMutableTargetPath(filePath)) {
      return NextResponse.json(
        { error: `refusing to finish non-mutable path "${filePath}"` },
        { status: 400 }
      );
    }

    const pushed = body.pushed === true;
    const commitSha = typeof body.commitSha === "string" && body.commitSha.length > 0 ? body.commitSha : undefined;
    const pushError = typeof body.pushError === "string" && body.pushError.length > 0 ? body.pushError : undefined;
    const evolutionBranch = `${branch}-evolution`;
    const feedback: string[] = [];

    // ── Feedback phase (labeled, target-repo-keyed, sandbox) ────────
    let postmortem: "recorded" | "resolved" | "skipped" | "none" = "none";
    const astFailed = report.astDiffResult.passed === false;
    // H1: match the pipeline's graduate definition — only "REJECTED"
    // is a rejection. "REQUIRES_REWRITE" + passed AST = COMPLETED (a
    // graduate the pipeline pushed); recording a scar for a graduate
    // would poison the next run's LLM with a wrong "you failed" prompt.
    const reviewRejected = report.reviewVerdict.consensus === "REJECTED";
    const zeroDiff = report.originalCode === report.evolvedCode;
    // M4: the pipeline ALREADY records a specific mutation-guard postmortem
    // (unified-pipeline.ts, tagged with source from config.triggeredBy)
    // with imperative "do NOT introduce eval(…" constraints. If we
    // recordFailure again here, the upsert OVERWRITES that specific scar
    // with a generic "Review tribunal rejected" — the next run's LLM sees
    // the wrong diagnosis. Detect the mutation-guard signature and skip.
    const mutationGuardRejected =
      report.reviewVerdict.leadSummary?.startsWith("Mutation guard rejected") === true ||
      (report as { stages?: Record<string, { details?: { guardRejected?: boolean } }> })
        .stages?.stage4_review?.details?.guardRejected === true;

    try {
      if (mutationGuardRejected) {
        // The pipeline already recorded a specific mutation-guard scar —
        // don't overwrite it with a generic review-rejected one.
        postmortem = "skipped";
        feedback.push(
          `mutation guard rejected — the pipeline already recorded a specific scar; not overwritten`
        );
      } else if (astFailed || reviewRejected) {
        const pm = generatePostmortemFromReport({
          filePath,
          astDiffResult: report.astDiffResult,
          sanitizerResult: report.sanitizerResult,
          reviewVerdict: report.reviewVerdict,
          haltReason: report.haltState?.reason,
        });
        const record = await postmortemStore.recordFailure({
          repo,
          branch,
          filePath,
          // Labeled feedback (operator decision "B"): manual runs are a
          // sandbox. The scar is retrievable for analysis but excluded
          // from the autonomous lesson distiller.
          source: "manual",
          failureType: pm.failureType,
          symptom: `[manual-gauntlet] ${pm.symptom}`,
          evidence: pm.evidence,
          constraints: pm.constraints,
        });
        postmortem = "recorded";
        feedback.push(
          `[manual] postmortem recorded for ${filePath} (${pm.failureType}, attempt #${record.attempts}) — retrievable, excluded from autonomous lessons`
        );
      } else if (zeroDiff) {
        // Churn guard (same as the loop + /auto/finish): don't re-record
        // an existing saturation scar — that only burns attempts.
        const existing = await postmortemStore.getActivePostmortem(repo, branch, filePath);
        if (existing && existing.failureType === "ZERO_DIFF_SATURATION") {
          postmortem = "skipped";
          feedback.push(
            `[manual] file ${filePath} still 0-diff (saturation attempt #${existing.attempts}) — scar already active, not re-recorded`
          );
        } else {
          const pm = generatePostmortemFromReport({
            filePath,
            astDiffResult: report.astDiffResult,
            sanitizerResult: report.sanitizerResult,
            reviewVerdict: report.reviewVerdict,
            haltReason: report.haltState?.reason ?? "ZERO_DIFF_SATURATION",
          });
          const record = await postmortemStore.recordFailure({
            repo,
            branch,
            filePath,
            source: "manual",
            failureType: pm.failureType,
            symptom: `[manual-gauntlet] ${pm.symptom}`,
            evidence: pm.evidence,
            constraints: pm.constraints,
          });
          postmortem = "recorded";
          feedback.push(
            `[manual] 0-diff saturation postmortem recorded (attempt #${record.attempts}) — retrievable, excluded from autonomous lessons`
          );
        }
      } else if (report.status === "COMPLETED") {
        await postmortemStore.markResolved(repo, branch, filePath);
        postmortem = "resolved";
        feedback.push(
          `[manual] any prior postmortem scar on ${filePath} resolved — this file graduated the gauntlet`
        );
      }
      if (pushed) {
        feedback.push(
          `[manual] survivor landed on ${evolutionBranch} @ ${(commitSha ?? "").slice(0, 10)} — the target branch was never touched`
        );
      } else if (pushError) {
        feedback.push(`[manual] push did not land: ${pushError}`);
      }
    } catch (fbErr) {
      // Feedback is best-effort — a scar failure must never mask the
      // push outcome the caller already has.
      feedback.push(
        `[manual] feedback write failed (non-fatal): ${(fbErr as Error).message}`
      );
    }

    return NextResponse.json({
      pushed,
      ...(commitSha ? { commitSha } : {}),
      ...(pushed ? { evolutionBranch } : {}),
      ...(pushError ? { pushError } : {}),
      feedback,
      postmortem,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
