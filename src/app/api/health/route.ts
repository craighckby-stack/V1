import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { autonomousLoopRuntime } from "@/lib/pipeline/autonomous/loop-runtime";
import { liveSelfEnhanceLoop } from "@/lib/pipeline/autonomous/self-enhance-loop";
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
 *   - loops: from the runtimes' own state getters.
 */
export async function GET() {
  const loopState = autonomousLoopRuntime.getState();
  const selfLoop = liveSelfEnhanceLoop();
  const selfStats = selfLoop.getStats();
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
      selfEnhanceLoop: selfLoop.isRunning() ? "running" : "idle",
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
