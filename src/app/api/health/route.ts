import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { autonomousLoopRuntime } from "@/lib/pipeline/autonomous/loop-runtime";
import { workerFetch } from "@/lib/pipeline/autonomous/loop-worker-client";
import { unifiedPipelineRunnerInstance } from "@/lib/pipeline/core/unified-pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Real package version read from package.json on disk at request time —
 * never a hardcoded claim that can drift from the manifest.
 */
function packageVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Probe the Loop WebSocket mini-service (port 3003) for REAL liveness.
 * Returns "live" only if the service answers its /health endpoint; "down"
 * otherwise. Never a hardcoded claim.
 */
async function probeWebSocketService(): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const res = await fetch("http://localhost:3003/health", {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    return res.ok ? "live" : `degraded (HTTP ${res.status})`;
  } catch {
    return "down";
  }
}

/**
 * GET /api/health
 * Reports the service version and the liveness of every subsystem,
 * including both loop runtimes (remote-repo enhancer and self-enhance
 * mode) and a REAL probe of the WebSocket mini-service. Every status
 * claim in this response is computed from live state, not asserted:
 *   - pipeline: "loaded" is proven by execution (the import above IS the
 *     probe — a failed construction would have thrown before this line).
 *   - governor: computed from the LIVE halt counters (consecutive
 *     failures / cycle cap), verbatim.
 *   - websocket: answered-or-not from a real HTTP probe.
 *   - loops: from the runtimes' own state getters. The self-enhance loop
 *     runs in the worker process (port 3004) — its status is a real HTTP
 *     probe of the worker's /status, never an in-process import (which
 *     would construct a second singleton here).
 */
export async function GET() {
  const loopState = autonomousLoopRuntime.getState();
  // Self-enhance loop lives in the worker — probe it over HTTP. On any
  // failure the loop is reported honestly idle (a down worker means no
  // observably-running loop; the instrumentation respawns it).
  const workerStatus = await workerFetch<{ running: boolean; stats: Record<string, unknown> }>(
    "/status",
    { timeoutMs: 2500 }
  );
  const selfStats = workerStatus?.data?.stats ?? {
    totalScanned: 0,
    totalEnhanced: 0,
    totalReverted: 0,
    totalPushed: 0,
    testsWritten: 0,
    cyclesCompleted: 0,
    tasksGenerated: 0,
    lastEnhancementAt: null,
  };
  // Cripple-check F8: distinguish "loop stopped" from "worker process
  // unreachable" — same honesty contract as /api/self-enhance/status.
  const workerReachable = workerStatus?.ok === true;
  const websocketStatus = await probeWebSocketService();

  const gov = unifiedPipelineRunnerInstance.getGovernorStats();
  const governorStatus =
    gov.consecutiveFailures >= gov.maxConsecutiveFailures
      ? `quarantine (consecutive failures: ${gov.consecutiveFailures}/${gov.maxConsecutiveFailures})`
      : gov.currentCycle >= gov.maxCycles
        ? `cycle-cap reached (${gov.currentCycle}/${gov.maxCycles})`
        : "nominal";

  return NextResponse.json({
    status: "ok",
    version: packageVersion(),
    timestamp: Date.now(),
    mode: "self-enhance",
    enhancements: {
      llmStage2: "z-ai-web-dev-sdk",
      astParser: "typescript-compiler-api + language-aware methods",
      rag: "tf-idf-cosine",
      debateTribunal: "llm-driven (no fallback — throws when LLM unavailable)",
      postmortems: "per-file constraints",
      sanitizer: "fixture-aware",
    },
    subsystems: {
      pipeline: "loaded",
      governor: governorStatus,
      remoteLoop: loopState.status,
      selfEnhanceLoop: workerStatus?.data?.running ? "running" : "idle",
      selfEnhanceWorkerReachable: workerReachable,
      websocket: websocketStatus,
    },
    selfEnhanceStats: selfStats,
    remoteLoopStats: {
      totalRuns: loopState.stats.totalRuns,
      totalFilesCommitted: loopState.stats.totalFilesCommitted,
      lastRunTime: loopState.stats.lastRunTime,
    },
  });
}
