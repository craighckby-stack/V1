import { NextResponse } from "next/server";
import { workerFetch, ensureWorkerRunning } from "@/lib/pipeline/autonomous/loop-worker-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/unlock
 * Body: { filePath: string }
 *
 * Unlocks a saturated file so it's eligible for the next cycle. Resets
 * its no-growth counter and enhancements-this-pass counter — a fresh
 * start. The file is re-evaluated on the next cycle.
 *
 * PINLESS BY DESIGN (operator, 2026-11-26): the two-tier PIN gate
 * (operator PIN documented mid-README + a secret master PIN + a
 * persisted master-mode bypass that survived worker restarts) was
 * retired. It was self-documented as "a speed bump, not a security
 * boundary": the real code boundary is protected-files + the gate
 * chain, which no PIN ever bypassed and the loop can never edit.
 * Unlocking a saturated file is a LOW-STAKES action — every subsequent
 * write still passes mutation-guard → structural → AST diff → syntax →
 * lint → typecheck — and the churn control (what the PIN friction used
 * to pretend to provide) is now the escalating auto-relock backoff:
 * each lockout doubles the file's cooldown (5m → 24h cap), so repeated
 * no-growth re-locks cost exponentially longer peace. `lockCount`
 * survives manual unlocks by design — that escalation IS the friction.
 *
 * A stale `pin` field in the body is accepted and ignored (old UI
 * payloads and bookmarks keep working).
 *
 * The ONE PIN left in the system guards the dangerous-direction
 * transition — unfreezing the mutation freeze (see /api/self-enhance/
 * freeze): freeze costs nothing, unfreeze proves operator presence.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as {
      filePath?: unknown;
      pin?: unknown;
    } | null;
    if (!body || typeof body.filePath !== "string" || !body.filePath) {
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
    // Forward filePath only — a legacy `pin` is deliberately dropped.
    const r = await workerFetch("/unlock", {
      method: "POST",
      body: JSON.stringify({ filePath: body.filePath }),
      timeoutMs: 10000,
    });
    if (!r || !r.data) {
      // Network failure / non-JSON body — the worker is unreachable or
      // returned garbage. Map to 502 (the honest "worker unlock failed").
      return NextResponse.json(
        { ok: false, error: "Worker unlock failed." },
        { status: 502 }
      );
    }
    // Pass the worker's actual status + body through. The worker returns
    // 200 on success with honest reasons ("already unlocked", "file not
    // tracked by saturation", …) — surfacing them lets the UI explain.
    return NextResponse.json(r.data, { status: r.status });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
