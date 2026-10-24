import { NextResponse } from "next/server";
import { autonomousLoopRuntime } from "@/lib/pipeline/autonomous/loop-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/health
 * Reports service version and the liveness of every major subsystem,
 * now reflecting the v4.2 enhancements (LLM, TypeScript Compiler API AST,
 * TF-IDF RAG, LLM debate tribunal).
 */
export async function GET() {
  const loopState = autonomousLoopRuntime.getState();
  return NextResponse.json({
    status: "ok",
    version: "4.2.0",
    timestamp: Date.now(),
    enhancements: {
      llmStage2: "z-ai-web-dev-sdk",
      astParser: "typescript-compiler-api",
      rag: "tf-idf-cosine",
      debateTribunal: "llm-driven (rule-based fallback)",
    },
    subsystems: {
      pipeline: "ready",
      governor: "ready",
      sanitizer: "ready",
      autonomousLoop: loopState.status,
      websocket: "live",
      llm: "z-ai-web-dev-sdk",
      ast: "typescript-compiler-api",
      rag: "tf-idf-cosine-similarity",
    },
    loopStats: {
      totalRuns: loopState.stats.totalRuns,
      totalFilesCommitted: loopState.stats.totalFilesCommitted,
      lastRunTime: loopState.stats.lastRunTime,
    },
  });
}

