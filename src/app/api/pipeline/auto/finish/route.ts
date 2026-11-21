import { NextResponse } from "next/server";
import {
  ensureTargetBranch,
  commitTargetFile,
} from "@/lib/pipeline/target/target-github";
import {
  normalizeTargetRepo,
  validTargetRepoFormat,
  validTargetBranchFormat,
  resolveTargetToken,
} from "@/lib/pipeline/target/target-store";
import { getUsableToken } from "@/lib/pipeline/api/github-helpers";
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
 * POST /api/pipeline/auto/finish — phases 3+4 of the one-click gauntlet.
 *
 *   push:   on COMPLETED (+autoPush) land the survivor on
 *           <branch>-evolution via the same ensure-branch + Contents-PUT
 *           sequence the manual push uses. Never the target branch.
 *   feedback (operator decision "B" — sandbox, not population):
 *           - AST/tribunal failure → postmortem scar keyed to the TARGET
 *             repo+branch+file (stage 2 of the next auto run against the
 *             same target inherits the constraints). Labeled
 *             [auto-gauntlet] in the symptom for operator clarity.
 *           - zero-diff saturation → same scar, with the loop's churn
 *             guard (don't re-record an existing ZERO_DIFF_SATURATION).
 *           - COMPLETED → resolve any prior scar on this file.
 *           Auto runs NEVER touch Lesson/MutationCorpus/SelfModel —
 *           those stay exclusively the autonomous loop's population.
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
      token?: string;
      autoPush?: boolean;
      report?: FinishReport;
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
    if (
      !report ||
      typeof report.status !== "string" ||
      !report.config?.filePath ||
      typeof report.evolvedCode !== "string"
    ) {
      return NextResponse.json(
        { error: "report (status, config.filePath, evolvedCode) is required" },
        { status: 400 }
      );
    }
    const filePath = report.config.filePath;
    // Defense in depth: never push to a path the mutation scope refuses
    // (protected control-surface names, test files, non-source).
    if (!isMutableTargetPath(filePath)) {
      return NextResponse.json(
        { error: `refusing to finish non-mutable path "${filePath}"` },
        { status: 400 }
      );
    }

    const token = getUsableToken(typeof body.token === "string" ? body.token : undefined)
      ?? (await resolveTargetToken());
    const autoPush = body.autoPush !== false;
    const evolutionBranch = `${branch}-evolution`;
    const feedback: string[] = [];

    // ── Push phase ────────────────────────────────────────────────
    let pushed = false;
    let commitSha: string | undefined;
    let pushError: string | undefined;

    if (report.status === "COMPLETED") {
      if (!autoPush) {
        pushError = "no push — auto-push disabled by operator";
      } else if (!token) {
        pushError = "no push — no GitHub token (reads can be anonymous, pushes cannot)";
      } else {
        const ensured = await ensureTargetBranch(repo, evolutionBranch, branch, token);
        if (!ensured.ok) {
          pushError = `branch ensure failed: ${ensured.error}`;
        } else {
          const message = [
            `pipeline(auto): refactor ${filePath}`,
            `AST ${report.astDiffResult.astScore} · ${report.reviewVerdict.consensus} · proof ${report.proofCommitHash}`,
            `prompt: ${report.config.userPrompt.slice(0, 200)}`,
          ].join("\n\n");
          const commit = await commitTargetFile({
            repo,
            path: filePath,
            branch: evolutionBranch,
            content: report.evolvedCode,
            message,
            token,
          });
          if (commit.ok) {
            pushed = true;
            commitSha = commit.commitSha;
          } else {
            pushError = commit.error ?? "Contents PUT failed";
          }
        }
      }
    } else {
      pushError = `no push — the gauntlet returned ${report.status}`;
    }

    // ── Feedback phase (labeled, target-repo-keyed) ───────────────
    let postmortem: "recorded" | "resolved" | "skipped" | "none" = "none";
    const astFailed = report.astDiffResult && report.astDiffResult.passed === false;
    const reviewRejected =
      report.reviewVerdict?.consensus === "REJECTED" ||
      report.reviewVerdict?.consensus === "REQUIRES_REWRITE";
    const zeroDiff = report.originalCode === report.evolvedCode;

    try {
      if (astFailed || reviewRejected) {
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
          failureType: pm.failureType,
          symptom: `[auto-gauntlet] ${pm.symptom}`,
          evidence: pm.evidence,
          constraints: pm.constraints,
        });
        postmortem = "recorded";
        feedback.push(
          `postmortem recorded for ${filePath} (${pm.failureType}, attempt #${record.attempts}) — the next auto run on this file inherits the constraints`
        );
      } else if (zeroDiff) {
        // Churn guard (same as the loop): don't re-record an existing
        // saturation scar — that only burns attempts.
        const existing = await postmortemStore.getActivePostmortem(repo, branch, filePath);
        if (existing && existing.failureType === "ZERO_DIFF_SATURATION") {
          postmortem = "skipped";
          feedback.push(
            `file ${filePath} still 0-diff (saturation attempt #${existing.attempts}) — scar already active, not re-recorded`
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
            failureType: pm.failureType,
            symptom: `[auto-gauntlet] ${pm.symptom}`,
            evidence: pm.evidence,
            constraints: pm.constraints,
          });
          postmortem = "recorded";
          feedback.push(
            `0-diff saturation postmortem recorded (attempt #${record.attempts}) — next run gets a "make a real refactor" constraint`
          );
        }
      } else if (report.status === "COMPLETED") {
        await postmortemStore.markResolved(repo, branch, filePath);
        postmortem = "resolved";
        feedback.push(
          `any prior postmortem scar on ${filePath} resolved — this file graduated the gauntlet`
        );
      }
      if (pushed) {
        feedback.push(
          `survivor landed on ${evolutionBranch} @ ${(commitSha ?? "").slice(0, 10)} — the target branch was never touched`
        );
      }
    } catch (fbErr) {
      // Feedback is best-effort — a scar failure must never mask a
      // successful push in the response.
      feedback.push(
        `feedback write failed (non-fatal): ${(fbErr as Error).message}`
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
