/**
 * Unified Code Refactoring Helper Pipeline (server-side)
 *
 * Stages 0-5:
 *   0. Pattern Ingestion & Template Selection
 *   1. Shannon Entropy Pre-Screen & Secret Sanitization
 *   2. 5-Pillar Modular Agent Reasoning Loop
 *   3. AST Diff Gate Structural & Symbol Verification
 *   4. Code Review & Verification (Security vs Architecture)
 *   5. Proof-of-Clean Synthesis, Convergence, and Git Dispatch
 */

import { SIPHON_SOURCES, performArchitecturalVote, ArchitecturalVote } from "./siphon";
import { sanitizeAndGovern, SecuritySanitizerResult } from "../emg/sanitizer";
import { executeCleanRoomEngine, EngineExecutionResult } from "../engines/clean-room-runtime";
import { evaluateAstDiff, AstDiffResult } from "./ast-diff-gate";
import { DebateVerdict } from "../emg/debate";
import { conductLlmDebate } from "../llm/debate-llm";
import { SelfStoppingGovernor, HaltEvaluationState } from "../emg/halt";
import { emgRagInstance } from "../emg/emg-rag";
import { binaryShieldInstance } from "./binaryShield";
import { postmortemStore } from "../postmortem/postmortem-store";
import { gateMutation } from "./mutation-guard";

export type PipelineStageId =
  | "stage0_ingestion"
  | "stage1_sanitization"
  | "stage2_reasoning"
  | "stage3_ast_gate"
  | "stage4_review"
  | "stage5_convergence";

export interface PipelineStageState {
  id: PipelineStageId;
  name: string;
  status: "pending" | "running" | "succeeded" | "blocked" | "skipped";
  summary: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

export interface PipelineConfig {
  githubToken?: string;
  targetRepo: string;
  targetBranch: string;
  evolutionBranch: string;
  filePath: string;
  userPrompt: string;
  siphonSourceId: string;
  code: string;
  triggeredBy?: "manual" | "autonomous" | "watch" | "continuous" | "scheduled";
}

export interface PipelineExecutionReport {
  id: string;
  timestamp: number;
  config: PipelineConfig;
  status: "COMPLETED" | "REJECTED" | "HALTED" | "SANITIZED_APPLIED";
  stages: Record<PipelineStageId, PipelineStageState>;
  originalCode: string;
  evolvedCode: string;
  patternVote: ArchitecturalVote;
  siphonVote?: ArchitecturalVote;
  sanitizerResult: SecuritySanitizerResult;
  agentEngineResult: EngineExecutionResult;
  astDiffResult: AstDiffResult;
  reviewVerdict: DebateVerdict;
  tribunalVerdict?: DebateVerdict;
  haltState: HaltEvaluationState | null;
  proofCommitHash: string;
  logs: Array<{
    timestamp: string;
    message: string;
    type: "info" | "warn" | "success" | "error";
  }>;
}

export type StageUpdateHandler = (stage: PipelineStageState) => void;
export type LogHandler = (log: {
  timestamp: string;
  message: string;
  type: "info" | "warn" | "success" | "error";
}) => void;

export class UnifiedPipelineRunner {
  private governor = new SelfStoppingGovernor({
    maxCycles: 100,
    maxConsecutiveFailures: 3,
  });

  public async runPipeline(
    config: PipelineConfig,
    onStageUpdate?: StageUpdateHandler,
    onLog?: LogHandler
  ): Promise<PipelineExecutionReport> {
    await emgRagInstance.ensureSeeded();

    const pipelineId = `helper_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const logs: PipelineExecutionReport["logs"] = [];

    const log: LogHandler = (entry) => {
      logs.push(entry);
      if (onLog) onLog(entry);
    };

    const stages: Record<PipelineStageId, PipelineStageState> = {
      stage0_ingestion: {
        id: "stage0_ingestion",
        name: "0. Pattern Ingestion Helper",
        status: "pending",
        summary: "Waiting to initialize pattern sources",
      },
      stage1_sanitization: {
        id: "stage1_sanitization",
        name: "1. Security Sanitizer Helper",
        status: "pending",
        summary: "Waiting for credential and entropy scan",
      },
      stage2_reasoning: {
        id: "stage2_reasoning",
        name: "2. Modular Agent Helper",
        status: "pending",
        summary: "Waiting for bounded ReAct reasoning loop",
      },
      stage3_ast_gate: {
        id: "stage3_ast_gate",
        name: "3. AST Verification Helper",
        status: "pending",
        summary: "Waiting for AST symbol retention check",
      },
      stage4_review: {
        id: "stage4_review",
        name: "4. Code Review Helper",
        status: "pending",
        summary: "Waiting for dual-perspective review",
      },
      stage5_convergence: {
        id: "stage5_convergence",
        name: "5. Commit & Convergence Helper",
        status: "pending",
        summary: "Waiting for convergence evaluation",
      },
    };

    const updateStage = (
      stageId: PipelineStageId,
      status: PipelineStageState["status"],
      summary: string,
      details?: Record<string, unknown>,
      durationMs?: number
    ) => {
      stages[stageId] = { ...stages[stageId], status, summary, details, durationMs };
      if (onStageUpdate) onStageUpdate(stages[stageId]);
    };

    log({
      timestamp: new Date().toLocaleTimeString(),
      message: `[HELPER START] Target: ${config.targetRepo}:${config.filePath} (${config.targetBranch})`,
      type: "info",
    });

    // STAGE 0
    const t0 = performance.now();
    updateStage("stage0_ingestion", "running", "Analyzing target structure and selecting architectural pattern...");
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: "[STAGE 0] Analyzing codebase patterns and selecting enhancement template...",
      type: "info",
    });

    const patternVote = performArchitecturalVote(config.filePath, config.code);
    const selectedSource =
      SIPHON_SOURCES.find(s => s.id === config.siphonSourceId) || patternVote.source;
    const dur0 = Math.round(performance.now() - t0);

    updateStage(
      "stage0_ingestion",
      "succeeded",
      `Applied template: ${selectedSource.label}`,
      { selectedSource, vote: patternVote },
      dur0
    );
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: `[STAGE 0] Selected pattern: ${selectedSource.label} (Confidence: ${patternVote.score}%)`,
      type: "success",
    });

    // STAGE 1
    const t1 = performance.now();
    updateStage("stage1_sanitization", "running", "Running Shannon entropy calculation and credential scan...");
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: "[STAGE 1] Scanning buffers for credential leakage and high-entropy secrets...",
      type: "info",
    });

    const sanitizerResult = sanitizeAndGovern(config.code, config.filePath);
    const dur1 = Math.round(performance.now() - t1);

    if (sanitizerResult.clean) {
      updateStage(
        "stage1_sanitization",
        "succeeded",
        "Clean: 0 hardcoded credentials or high-entropy secrets detected.",
        { violations: [] },
        dur1
      );
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: "[STAGE 1] Pre-screen passed: 0 credentials leaked.",
        type: "success",
      });
    } else {
      updateStage(
        "stage1_sanitization",
        "succeeded",
        `Sanitized ${sanitizerResult.violations.length} secret token(s) prior to execution.`,
        { violations: sanitizerResult.violations },
        dur1
      );
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: `[STAGE 1] Sanitized ${sanitizerResult.violations.length} high-entropy token(s). Redactions applied.`,
        type: "warn",
      });
    }

    const sanitizedBaseCode = sanitizerResult.sanitizedCode;

    // STAGE 2
    const t2 = performance.now();
    updateStage("stage2_reasoning", "running", "Running bounded ReAct loop with in-memory VFS sandbox...");
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: `[STAGE 2] Executing modular agent loop for: "${config.userPrompt.slice(0, 60)}..."`,
      type: "info",
    });

    // Fetch per-file postmortem constraints (if any prior failures recorded)
    const postmortemConstraints = await postmortemStore.getConstraintsForFile(
      config.targetRepo,
      config.targetBranch,
      config.filePath
    );
    if (postmortemConstraints.hasActivePostmortem) {
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: `[STAGE 2] Active postmortem found (${postmortemConstraints.failureType}, ${postmortemConstraints.attempts} prior failure(s)). Injecting constraints into LLM prompt.`,
        type: "warn",
      });
    }

    const agentGoal = `${config.userPrompt} (Template: ${selectedSource.label})`;
    const agentEngineResult = await executeCleanRoomEngine("inference-reasoning-loop", agentGoal, {
      originalCode: sanitizedBaseCode,
      filePath: config.filePath,
      postmortemConstraints: postmortemConstraints.promptBlock,
    });
    const dur2 = Math.round(performance.now() - t2);

    const llmStatus = agentEngineResult.llmUsed
      ? `LLM refactor produced ${agentEngineResult.proposedEvolvedCode.length} bytes (${agentEngineResult.llmTotalLatencyMs}ms).`
      : `LLM unavailable (${agentEngineResult.llmError ?? "unknown"}). No refactor produced — original code kept, cycle will halt at 0-diff.`;

    updateStage(
      "stage2_reasoning",
      "succeeded",
      `Completed in ${agentEngineResult.steps.length} bounded steps. ${llmStatus}`,
      {
        steps: agentEngineResult.steps.length,
        tokenBudget: agentEngineResult.tokenBudget,
        llmUsed: agentEngineResult.llmUsed,
        llmLatencyMs: agentEngineResult.llmTotalLatencyMs,
      },
      dur2
    );
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: `[STAGE 2] Agent loop completed (${agentEngineResult.steps.length} steps). ${llmStatus}`,
      type: agentEngineResult.llmUsed ? "success" : "warn",
    });

    // Synthesize proposed evolved code.
    // The LLM's refactored output IS the enhancement — we do NOT prepend a
    // "Enhanced by Architecture Helper Pipeline" header. That header was
    // cosmetic noise that polluted every committed file without adding
    // value. If the LLM produced no semantic change, we return the
    // original code unchanged and let the 0-diff saturation check halt
    // the cycle (no commit = no noise).

    let evolvedCode: string;
    if (agentEngineResult.llmUsed && agentEngineResult.proposedEvolvedCode.trim()) {
      // Real LLM-produced code — sanitize it again (defense in depth)
      // and use it AS-IS. No header prepended.
      const llmCode = agentEngineResult.proposedEvolvedCode;
      const reSanitized = sanitizeAndGovern(llmCode, config.filePath);
      evolvedCode = reSanitized.sanitizedCode;
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: `[STAGE 2] Using LLM-refactored code (${llmCode.length} bytes, re-sanitized: ${reSanitized.violations.length} violations).`,
        type: reSanitized.clean ? "success" : "warn",
      });
    } else {
      // LLM unavailable or produced no code — return the original
      // unchanged. The 0-diff saturation check will halt this cycle
      // (no semantic change = nothing to commit). We do NOT inject a
      // cosmetic header or unused ExecutionContract interface.
      evolvedCode = sanitizedBaseCode;
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: `[STAGE 2] No LLM refactor produced. Returning original code unchanged (no cosmetic header injected).`,
        type: "warn",
      });
    }

    // STAGE 3
    const t3 = performance.now();
    updateStage("stage3_ast_gate", "running", "Verifying AST symbol retention and structural drift...");
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: "[STAGE 3] Evaluating AST symbol retention ratio and syntax invariants...",
      type: "info",
    });

    const astDiffResult = evaluateAstDiff(config.code, evolvedCode, config.filePath);
    const dur3 = Math.round(performance.now() - t3);

    if (astDiffResult.passed) {
      updateStage(
        "stage3_ast_gate",
        "succeeded",
        `Passed: AST Score ${astDiffResult.astScore}/100, Retained ${astDiffResult.symbolMap.retainedCount}/${astDiffResult.symbolMap.originalCount} symbols (${astDiffResult.parserUsed}).`,
        {
          astScore: astDiffResult.astScore,
          violations: astDiffResult.violations,
          parserUsed: astDiffResult.parserUsed,
          symbolMap: astDiffResult.symbolMap,
          drift: astDiffResult.structuralDriftRatio,
        },
        dur3
      );
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: `[STAGE 3] AST verification passed with score ${astDiffResult.astScore}/100.`,
        type: "success",
      });
    } else {
      updateStage(
        "stage3_ast_gate",
        "blocked",
        `AST integrity check flagged violations (Score: ${astDiffResult.astScore}/100, ${astDiffResult.parserUsed}).`,
        {
          violations: astDiffResult.violations,
          parserUsed: astDiffResult.parserUsed,
          symbolMap: astDiffResult.symbolMap,
          drift: astDiffResult.structuralDriftRatio,
        },
        dur3
      );
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: `[STAGE 3] AST violations flagged: ${astDiffResult.violations.map(v => v.code).join(", ")}`,
        type: "warn",
      });
    }

    // STAGE 4
    const t4 = performance.now();

    // 0-diff short-circuit: if the evolution stage produced NO change
    // (LLM unavailable or returned the original), there is nothing to
    // review and nothing to commit. Convening a tribunal over identical
    // code proves nothing — report HALTED honestly and stop here.
    if (evolvedCode === config.code) {
      updateStage(
        "stage4_review",
        "skipped",
        "Skipped: 0-diff (no change produced). Nothing to review or commit.",
        { consensus: "SKIPPED_ZERO_DIFF" },
        Math.round(performance.now() - t4)
      );
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: "[STAGE 4] Skipped — 0-diff: the evolution stage produced no change. Halting cycle honestly (no review, no commit).",
        type: "warn",
      });

      let haltStateEarly: HaltEvaluationState | null = null;
      try {
        haltStateEarly = this.governor.checkZeroDiffSaturation(config.code, evolvedCode);
      } catch {
        haltStateEarly = null;
      }

      updateStage(
        "stage5_convergence",
        "succeeded",
        "Converged at 0-diff (saturation). No proof commit — nothing changed.",
        { proofCommitHash: "NONE", haltState: haltStateEarly },
        0
      );

      return {
        id: pipelineId,
        timestamp: Date.now(),
        config,
        status: "HALTED",
        stages,
        originalCode: config.code,
        evolvedCode,
        patternVote,
        siphonVote: patternVote,
        sanitizerResult,
        agentEngineResult,
        astDiffResult,
        reviewVerdict: {
          currentTopic: `Code Review for ${config.filePath}`,
          consensus: "APPROVED", // vacuous: identical code — nothing was changed, so nothing needs review
          consensusCoefficient: 1,
          cognitiveFriction: 0,
          securityPoints: [],
          architecturePoints: [],
          leadSummary: "Review skipped: 0-diff (no change produced).",
          arguments: [],
        },
        haltState: haltStateEarly,
        proofCommitHash: "NONE",
        logs,
      };
    }

    updateStage("stage4_review", "running", "Running mutation guard (triage + finalAuthority) before convening the review tribunal...");
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: "[STAGE 4] Mutation guard: scanning proposed code for escape attempts and protected-path violations...",
      type: "info",
    });

    // ── Two-authority mutation guard (concept: Aether_Forge Ω repo) ────
    // Run BEFORE the debate tribunal: an obviously-evil proposal (newly-
    // introduced eval/child_process, or a mutation of a protected
    // scaffolding path) is rejected here without spending an LLM review
    // call. The guard is fail-CLOSED: triage evil → reject; unsure/good →
    // finalAuthority (protected paths + non-empty). See mutation-guard.ts.
    const gateResult = gateMutation({
      filePath: config.filePath,
      originalCode: config.code,
      evolvedCode,
    });
    if (!gateResult.allowed) {
      const dur4guard = Math.round(performance.now() - t4);
      const rejectMsg = `Mutation guard REJECTED (${gateResult.rejectedBy}): ${gateResult.reasons.join("; ")}`;
      updateStage(
        "stage4_review",
        "blocked",
        rejectMsg,
        {
          consensus: "MUTATION_GUARD_REJECTED",
          rejectedBy: gateResult.rejectedBy,
          triageVerdict: gateResult.verdict,
          triageSuspicion: gateResult.triage.suspicionScore,
          reasons: gateResult.reasons,
        },
        dur4guard
      );
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: `[STAGE 4] ${rejectMsg}`,
        type: "error",
      });
      // Synthesize a review verdict that the downstream gate logic reads
      // as REJECTED, so the cycle halts with no commit. We do NOT call
      // the debate tribunal — the guard already decided, and spending
      // an LLM call on an evil proposal would waste quota + risk the LLM
      // being talked into approving it.
      const rejectedVerdict: DebateVerdict = {
        currentTopic: `Mutation Guard for ${config.filePath}`,
        consensus: "REJECTED",
        consensusCoefficient: 0,
        cognitiveFriction: 1,
        securityPoints: gateResult.reasons,
        architecturePoints: [],
        leadSummary: `Mutation guard rejected before review: ${gateResult.rejectedBy} layer.`,
        arguments: [],
      };
      // Record the guard-rejection as a postmortem so the next attempt
      // gets the constraint — the LLM will see "you tried to introduce
      // eval( last time; don't" in its prompt.
      try {
        await postmortemStore.recordFailure({
          repo: config.targetRepo,
          branch: config.targetBranch,
          filePath: config.filePath,
          failureType: "OTHER",
          symptom: `Mutation guard rejected (${gateResult.rejectedBy})`,
          evidence: gateResult.reasons.join("\n"),
          constraints: [
            "The mutation guard rejected your last proposed change.",
            "Do NOT introduce any of: eval(, new Function(, child_process, __import__(,",
            "  require('fs'/'child_process'/'net'/'os'), fetch() to non-allowlisted hosts,",
            "  path-traversal literals (../../), process.mainModule, weak crypto (md5/sha1).",
            "Do NOT mutate protected paths: prisma/schema.prisma, package.json,",
            "  next.config.*, tsconfig.json, .env, Caddyfile, start-dev.sh, or any file",
            "  in the loop runtime / gates / LLM wrappers / UI control surface.",
          ].join("\n"),
        });
      } catch {
        /* best-effort — the rejection still blocks the commit */
      }
      // Fall through to STAGE 5 with the synthesized REJECTED verdict so
      // the normal "review rejected → no commit" path handles it.
      const reviewVerdict = rejectedVerdict;
      const isReviewApproved = false;

      updateStage(
        "stage4_review",
        "blocked",
        `Mutation guard: ${gateResult.rejectedBy} rejected. Review skipped (no LLM call spent on a guarded proposal).`,
        {
          consensus: reviewVerdict.consensus,
          coefficient: reviewVerdict.consensusCoefficient,
          usedLlm: false,
          guardRejected: true,
          reasons: gateResult.reasons,
        },
        dur4guard
      );
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: `[STAGE 4] Mutation guard rejected — review tribunal skipped (no LLM call). Verdict: REJECTED.`,
        type: "warn",
      });

      // Skip to STAGE 5 convergence with the synthesized verdict.
      // (Mirrors the structure of the 0-diff early-return above, but
      // with a REJECTED verdict instead of a vacuous APPROVED one.)
      const t5guard = performance.now();
      const guardHaltState = this.governor.recordResult(false, config.filePath);
      const guardProofHash = await binaryShieldInstance
        .computeHash(evolvedCode)
        .then((h) => h.slice(0, 7))
        .catch(() => "UNPROVEN");
      updateStage(
        "stage5_convergence",
        "succeeded",
        `Converged (guard-rejected). Proof: ${guardProofHash}.`,
        { proofCommitHash: guardProofHash, haltState: guardHaltState, guardRejected: true },
        Math.round(performance.now() - t5guard)
      );

      emgRagInstance.addEntry({
        provenance: "failure",
        trust: "low",
        filePath: config.filePath,
        content: `Mutation guard rejected ${config.filePath} (${gateResult.rejectedBy}): ${gateResult.reasons.join("; ")}. Proof ${guardProofHash}.`,
        diagnosis: "MUTATION_GUARD_REJECTED",
      });

      let finalStatusGuard: PipelineExecutionReport["status"] = "REJECTED";
      if (guardHaltState && guardHaltState.shouldHalt) finalStatusGuard = "HALTED";

      return {
        id: pipelineId,
        timestamp: Date.now(),
        config,
        status: finalStatusGuard,
        stages,
        originalCode: config.code,
        evolvedCode,
        patternVote,
        siphonVote: patternVote,
        sanitizerResult,
        agentEngineResult,
        astDiffResult,
        reviewVerdict,
        tribunalVerdict: reviewVerdict,
        haltState: guardHaltState,
        proofCommitHash: guardProofHash,
        logs,
      };
    }

    // Guard passed — proceed to the LLM debate tribunal.
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: `[STAGE 4] Mutation guard passed (triage: ${gateResult.verdict}, suspicion ${gateResult.triage.suspicionScore.toFixed(2)}). Convening review tribunal...`,
      type: "info",
    });

    updateStage("stage4_review", "running", "Conducting dual-perspective review (Security vs Architecture)...");
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: "[STAGE 4] Convening LLM review tribunal: Security Reviewer vs Architecture Reviewer...",
      type: "info",
    });

    // The tribunal THROWS when the LLM is unavailable — no fabricated
    // verdicts. An unavailable review means the stage is blocked: the file
    // does not pass review, and that is reported honestly.
    let debateResult: Awaited<ReturnType<typeof conductLlmDebate>>;
    try {
      debateResult = await conductLlmDebate(
        `Code Review for ${config.filePath}`,
        evolvedCode,
        config.filePath
      );
    } catch (debateErr) {
      const dur4 = Math.round(performance.now() - t4);
      updateStage(
        "stage4_review",
        "blocked",
        `Review tribunal UNAVAILABLE — no verdict (LLM failure). Blocking: unreviewed code cannot pass.`,
        { consensus: "UNAVAILABLE", usedLlm: false, llmError: (debateErr as Error).message },
        dur4
      );
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: `[STAGE 4] Review tribunal unavailable: ${(debateErr as Error).message.slice(0, 150)} — stage blocked, no fabrication`,
        type: "error",
      });
      throw debateErr;
    }
    const reviewVerdict = debateResult.verdict;
    const dur4 = Math.round(performance.now() - t4);
    const isReviewApproved =
      reviewVerdict.consensus === "APPROVED" ||
      reviewVerdict.consensus === "CONDITIONAL_APPROVAL";

    updateStage(
      "stage4_review",
      isReviewApproved ? "succeeded" : "blocked",
      `Verdict: ${reviewVerdict.consensus} (Consensus: ${(reviewVerdict.consensusCoefficient * 100).toFixed(0)}%) [LLM]`,
      {
        consensus: reviewVerdict.consensus,
        coefficient: reviewVerdict.consensusCoefficient,
        usedLlm: true,
      },
      dur4
    );
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: `[STAGE 4] Review outcome: ${reviewVerdict.consensus} (${reviewVerdict.leadSummary}) [LLM]`,
      type: isReviewApproved ? "success" : "warn",
    });

    // STAGE 5
    const t5 = performance.now();
    updateStage("stage5_convergence", "running", "Verifying convergence and generating proof commit...");
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: "[STAGE 5] Checking 0-diff code saturation and computing proof commit hash...",
      type: "info",
    });

    const zeroDiffCheck = this.governor.checkZeroDiffSaturation(config.code, evolvedCode);
    let haltState = zeroDiffCheck;

    if (zeroDiffCheck) {
      log({
        timestamp: new Date().toLocaleTimeString(),
        message: `[STAGE 5] Saturation check triggered: ${zeroDiffCheck.detail}`,
        type: "warn",
      });
    } else {
      const recordHalt = this.governor.recordResult(astDiffResult.passed, config.filePath);
      if (recordHalt) {
        haltState = recordHalt;
        log({
          timestamp: new Date().toLocaleTimeString(),
          message: `[STAGE 5] Loop convergence guard engaged: ${recordHalt.detail}`,
          type: "warn",
        });
      }
    }

    // Proof hash: computed from the ACTUAL evolved code. If hashing fails,
    // the proof is UNPROVEN — never a fabricated timestamp-based hash posing
    // as a proof commit (that would make the proof layer meaningless).
    const proofCommitHash = await binaryShieldInstance
      .computeHash(evolvedCode)
      .then(h => h.slice(0, 7))
      .catch(() => "UNPROVEN");
    const dur5 = Math.round(performance.now() - t5);

    // Record the run in RAG memory — HONESTLY (audit 2): a run that failed
    // the AST gate is a FAILURE pattern, not a validated clean one. This
    // used to write provenance:"clean" / trust:"high" unconditionally, so
    // rejected code entered topFixes() as a high-trust pattern that later
    // runs were encouraged to imitate.
    const runPassed = astDiffResult.passed;
    emgRagInstance.addEntry({
      provenance: runPassed ? "clean" : "failure",
      trust: runPassed ? "high" : "low",
      filePath: config.filePath,
      content: `Code Refactoring Helper run for ${config.filePath}. AST Score: ${astDiffResult.astScore}, Proof Hash: ${proofCommitHash}${runPassed ? "" : ", AST gate: FAILED"}`,
      cleanSnippet: runPassed ? evolvedCode.slice(0, 150) : undefined,
      diagnosis: `Review: ${reviewVerdict.consensus}`,
    });

    updateStage(
      "stage5_convergence",
      "succeeded",
      `Converged. Generated proof commit: ${proofCommitHash}`,
      { proofCommitHash, haltState },
      dur5
    );
    log({
      timestamp: new Date().toLocaleTimeString(),
      message: `[STAGE 5] Helper pipeline finished. Clean Proof Commit Hash: ${proofCommitHash}`,
      type: "success",
    });

    let finalStatus: PipelineExecutionReport["status"] = "COMPLETED";
    if (!astDiffResult.passed || reviewVerdict.consensus === "REJECTED") {
      finalStatus = "REJECTED";
    } else if (haltState && haltState.shouldHalt) {
      finalStatus = "HALTED";
    } else if (!sanitizerResult.clean) {
      finalStatus = "SANITIZED_APPLIED";
    }

    return {
      id: pipelineId,
      timestamp: Date.now(),
      config,
      status: finalStatus,
      stages,
      originalCode: config.code,
      evolvedCode,
      patternVote,
      siphonVote: patternVote,
      sanitizerResult,
      agentEngineResult,
      astDiffResult,
      reviewVerdict,
      tribunalVerdict: reviewVerdict,
      haltState,
      proofCommitHash,
      logs,
    };
  }

  public resetGovernor(): void {
    this.governor.reset();
  }

  public setMaxCycles(max: number): void {
    this.governor.setMaxCycles(max);
  }

  public getGovernorCycles(): { current: number; max: number } {
    return {
      current: this.governor.getCurrentCycle(),
      max: this.governor.getMaxCycles(),
    };
  }
}

export const unifiedPipelineRunnerInstance = new UnifiedPipelineRunner();
