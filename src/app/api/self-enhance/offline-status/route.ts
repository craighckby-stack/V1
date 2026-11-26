import { NextResponse } from "next/server";
import { workerFetch } from "@/lib/pipeline/autonomous/loop-worker-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/self-enhance/offline-status — one-stop visibility route
 * (audit G, 2026-11-26): answers the question the extinction detector
 * and the operator both need answered in ONE call —
 *
 *   "Is the system DOWN, or is it OFFLINE-BUT-ALIVE?"
 *
 * During the 10-day endurance test the loop can enter OFFLINE mode
 * (net-status.ts: LLM/API unreachable → cycles idle, deterministic
 * SelfTasks still apply locally, pushes defer commit-only until the
 * probe recovers). That is NOT an extinction event — the process is
 * alive, the heartbeat flows, and the system self-recovers when the
 * network returns. But nothing surfaced that distinction: the
 * dashboard showed "0 cycles", the heartbeat-check workflow saw
 * staleness, and the operator had to SSH in and read dev.log to tell
 * the two apart.
 *
 * This route consolidates the three signals:
 *   1. SERVER liveness  — this route returning 200 at all (implicit)
 *   2. WORKER liveness  — the :3004 health probe (3s timeout, fast fail)
 *   3. NETWORK state    — the worker's net-status snapshot (the
 *      authoritative one: the loop's LLM calls and pushes happen in
 *      the worker process, so ITS offline tracker is the truth)
 *
 * Response `status` values:
 *   "online"         — everything healthy, network reachable
 *   "offline-alive"  — network down, process alive (NOT extinction)
 *   "stalled"        — worker unreachable (IS extinction — check the
 *                      watchdog / respawn, this is the alert case)
 *
 * Read-only, no DB, no LLM, no auth (the classification carries no
 * secrets — the lastError field is already truncated + scrubbed by
 * net-status.ts). Safe for the cron heartbeat and the dashboard to
 * poll on any cadence.
 */

interface WorkerStatusShape {
  running?: boolean;
  stats?: {
    cyclesCompleted?: number;
    lastEnhancementAt?: string | null;
  };
  net?: {
    offline?: boolean;
    since?: string | null;
    consecutiveFailures?: number;
    lastError?: string | null;
    lastSuccessAt?: string | null;
    nextProbeAt?: number | null;
    probeIntervalMs?: number;
    totalSuppressedPushFailures?: number;
  };
  mutationFrozen?: boolean;
}

export async function GET() {
  try {
    // 3s timeout: this route's whole value is a FAST honest answer —
    // a wedged worker must not turn the visibility route into a 5s
    // hang on every poll. `workerFetch` returns null on timeout →
    // "stalled" (the honest classification).
    const r = await workerFetch<WorkerStatusShape>("/status", { timeoutMs: 3000 });
    if (!r || !r.ok || !r.data) {
      return NextResponse.json(
        {
          status: "stalled",
          serverAlive: true,
          workerAlive: false,
          detail:
            "loop worker unreachable on :3004 — the dev-watchdog or instrumentation respawn owns recovery; if this persists, the extinction alert is REAL",
          checkedAt: new Date().toISOString(),
        },
        { status: 200 } // 200 on purpose: the ROUTE works; the status field carries the truth
      );
    }

    const net = r.data.net;
    const offline = net?.offline === true;
    const running = r.data.running === true;
    const lastEnhancementAt = r.data.stats?.lastEnhancementAt ?? null;

    if (offline) {
      return NextResponse.json(
        {
          status: "offline-alive",
          serverAlive: true,
          workerAlive: true,
          loopRunning: running,
          mutationFrozen: r.data.mutationFrozen === true,
          net: {
            since: net?.since ?? null,
            consecutiveFailures: net?.consecutiveFailures ?? 0,
            lastError: net?.lastError ?? null,
            lastSuccessAt: net?.lastSuccessAt ?? null,
            nextProbeAt: net?.nextProbeAt ?? null,
            probeIntervalMs: net?.probeIntervalMs ?? null,
            deferredPushFailures: net?.totalSuppressedPushFailures ?? 0,
          },
          detail:
            "network unreachable — loop is in OFFLINE mode (cycles idle, commits held locally, pushes ride the next recovery). NOT an extinction event: the process is alive and will self-recover when the probe succeeds.",
          lastEnhancementAt,
          checkedAt: new Date().toISOString(),
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        status: "online",
        serverAlive: true,
        workerAlive: true,
        loopRunning: running,
        mutationFrozen: r.data.mutationFrozen === true,
        net: {
          lastSuccessAt: net?.lastSuccessAt ?? null,
        },
        lastEnhancementAt,
        checkedAt: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err) {
    return NextResponse.json(
      {
        status: "stalled",
        serverAlive: true,
        workerAlive: false,
        detail: `offline-status route error: ${(err as Error).message}`,
        checkedAt: new Date().toISOString(),
      },
      { status: 200 }
    );
  }
}
