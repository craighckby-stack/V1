import { NextResponse } from "next/server";
import { workerFetch, ensureWorkerRunning } from "@/lib/pipeline/autonomous/loop-worker-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const alive = await ensureWorkerRunning();
  if (!alive) {
    return NextResponse.json(
      { ok: false, error: "Loop worker unreachable — rescan not performed." },
      { status: 503 }
    );
  }
  const r = await workerFetch("/rescan", { method: "POST", timeoutMs: 30000 });
  if (!r?.ok || !r.data) {
    return NextResponse.json(
      { ok: false, error: "Worker rescan failed." },
      { status: 502 }
    );
  }
  return NextResponse.json(r.data);
}
