import { NextResponse } from "next/server";
import { workerFetch, ensureWorkerRunning } from "@/lib/pipeline/autonomous/loop-worker-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/unlock
 * Body: { filePath: string }  (repo-relative, e.g. "src/app/display/console-stream.tsx")
 *
 * Unlocks a saturated file so it's eligible for the next cycle. Resets
 * its no-growth counter and enhancements-this-pass counter — a fresh
 * start. The file is re-evaluated on the next cycle.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { filePath?: string };
    if (!body.filePath) {
      return NextResponse.json(
        { ok: false, error: "filePath is required" },
        { status: 400 }
      );
    }
    const alive = await ensureWorkerRunning();
    if (!alive) {
      return NextResponse.json(
        { ok: false, error: "Loop worker unreachable — unlock not applied." },
        { status: 503 }
      );
    }
    const r = await workerFetch("/unlock", {
      method: "POST",
      body: JSON.stringify({ filePath: body.filePath }),
      timeoutMs: 10000,
    });
    if (!r?.ok || !r.data) {
      return NextResponse.json(
        { ok: false, error: "Worker unlock failed." },
        { status: 502 }
      );
    }
    return NextResponse.json(r.data);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
