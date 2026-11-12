import { NextResponse } from "next/server";
import { workerFetch, ensureWorkerRunning } from "@/lib/pipeline/autonomous/loop-worker-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** User veto on system-defined input: skip the next pending task. */
export async function POST() {
  const alive = await ensureWorkerRunning();
  if (!alive) {
    return NextResponse.json(
      { ok: false, error: "Loop worker unreachable — skip not applied." },
      { status: 503 }
    );
  }
  const r = await workerFetch("/skip", { method: "POST", timeoutMs: 15000 });
  if (!r || r.data === null) {
    return NextResponse.json(
      { ok: false, error: "Worker skip failed." },
      { status: 502 }
    );
  }
  return NextResponse.json(r.data, { status: r.ok ? 200 : r.status });
}
