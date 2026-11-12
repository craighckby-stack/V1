import { NextResponse } from "next/server";
import { workerFetch, healWorkerInBackground } from "@/lib/pipeline/autonomous/loop-worker-client";
import { llmGateInfo } from "@/lib/pipeline/llm/agent-llm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Zeroed stats — the exact shape of the loop's initialized stats object
 *  (self-enhance-loop.ts `private stats`), used when the worker is
 *  unreachable so the UI renders an honestly idle panel instead of NaNs. */
const IDLE_STATS = {
  totalScanned: 0,
  totalEnhanced: 0,
  totalReverted: 0,
  totalPushed: 0,
  testsWritten: 0,
  cyclesCompleted: 0,
  tasksGenerated: 0,
  lastEnhancementAt: null as string | null,
};

export async function GET() {
  // The loop runs in the worker process (port 3004). This route is a
  // read-only proxy — importing self-enhance-loop here would construct a
  // second singleton whose boot auto-start honors the armed tier.
  const r = await workerFetch("/status", { timeoutMs: 4000 });
  if (r?.ok && r.data) {
    return NextResponse.json(r.data);
  }

  // Worker down — self-heal in the background (never block the poll; the
  // next 2s poll finds the respawned worker) and report an honestly idle
  // loop in the exact shape the UI expects. llmGate falls back to THIS
  // process's gate — still accurate for the autonomous loop's LLM calls.
  healWorkerInBackground();
  return NextResponse.json({
    running: false,
    stats: IDLE_STATS,
    logs: [],
    currentFile: null,
    llmGate: llmGateInfo(),
    saturation: {},
  });
}
