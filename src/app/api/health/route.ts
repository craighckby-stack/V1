import { NextResponse } from "next/server";
import { autonomousLoopRuntime } from "@/lib/pipeline/autonomous/loop-runtime";
import { selfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/health
 * Reports service version and the liveness of every subsystem, including
 * both loop runtimes (remote-repo enhancer and self-enhance mode).
 */
export async function GET() {
  const loopState = autonomousLoopRuntime.getState();
  const selfStats = selfEnhanceLoop.getStats();
  return NextResponse.json({
    status: "ok",
    version: "4.3.0",
    timestamp: Date.now(),
    mode: "self-enhance",
    enhancements: {
      llmStage2: "z-ai-web-dev-sdk",
      astParser: "typescript-compiler-api + language-aware methods",
      rag: "tf-idf-cosine",
      debateTribunal: "llm-driven (rule-based fallback)",
      postmortems: "per-file constraints",
    },
    subsystems: {
      pipeline: "ready",
      governor: "ready",
      sanitizer: "fixture-aware",
      remoteLoop: loopState.status,
      selfEnhanceLoop: selfEnhanceLoop.isRunning() ? "running" : "idle",
      websocket: "live",
    },
    selfEnhanceStats: selfStats,
    remoteLoopStats: {
      totalRuns: loopState.stats.totalRuns,
      totalFilesCommitted: loopState.stats.totalFilesCommitted,
      lastRunTime: loopState.stats.lastRunTime,
    },
  });
}
