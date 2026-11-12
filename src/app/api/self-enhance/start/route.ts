import { NextResponse } from "next/server";
import { workerFetch, ensureWorkerRunning } from "@/lib/pipeline/autonomous/loop-worker-client";
import { markSelfEnhanceArmed } from "@/lib/pipeline/autonomous/self-enhance-armed-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  // Persist the armed intent FIRST (server-owned tier, unchanged semantics):
  // this is what makes [START] a ONE-TIME ritual — every subsequent process
  // boot re-arms from disk. Best-effort, never throws.
  markSelfEnhanceArmed(true, "operator-start");

  // The runtime lives in the worker. Self-heal it if it's down (a stopped
  // worker respawned here honors the armed:true we just persisted).
  const alive = await ensureWorkerRunning();
  if (!alive) {
    return NextResponse.json(
      {
        started: false,
        error:
          "Loop worker unreachable — armed state persisted; the loop will auto-start when the worker comes up.",
      },
      { status: 503 }
    );
  }

  const r = await workerFetch<{ started: boolean; alreadyRunning?: boolean }>(
    "/start",
    { method: "POST", timeoutMs: 10000 }
  );
  if (!r?.ok || !r.data?.started) {
    return NextResponse.json(
      { started: false, error: "Worker did not accept the start command." },
      { status: 502 }
    );
  }

  // Preserve the exact response the UI has always rendered.
  return NextResponse.json({
    started: true,
    alreadyRunning: r.data.alreadyRunning === true,
    message: r.data.alreadyRunning
      ? "Continuous self-enhancement already running"
      : "Continuous self-enhancement started (armed state persisted — survives restarts)",
  });
}
