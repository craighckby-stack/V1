import { NextResponse } from "next/server";
import { workerFetch, healWorkerInBackground } from "@/lib/pipeline/autonomous/loop-worker-client";
import { llmGateInfo } from "@/lib/pipeline/llm/agent-llm";
import { getLessonOutcomes } from "@/lib/pipeline/autonomous/lesson-store";
import { getHealthTrend } from "@/lib/pipeline/autonomous/health-metrics";

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
  // Lesson OUTCOME metrics — queried here (not in the worker) so the
  // worker stays a thin proxy and the DB read is local. Best-effort: if
  // the DB is unavailable, lessonOutcomes falls to all-zeros and the
  // dashboard shows "lessons helped:0 hindered:0" honestly.
  const lessonOutcomes = await getLessonOutcomes().catch(() => ({
    helped: 0,
    hindered: 0,
    activeLessons: 0,
    medianScore: 0,
  }));
  // Codebase HEALTH trend — the EXTERNAL objective signal (test count,
  // tsc errors, lint errors). Queried here for the same reason as
  // lessonOutcomes: keeps the worker a thin proxy. Best-effort: null if
  // the DB is unavailable or no snapshots exist yet. NOTE: requires a
  // dev-server restart after a schema push that adds the codebaseHealth
  // model — the Next.js dev server caches the Prisma Client on
  // globalThis; a mid-session db:push doesn't invalidate it.
  const healthTrend = await getHealthTrend().catch(() => null);
  if (r?.ok && r.data) {
    // Cripple-check F8: surface worker reachability explicitly. Without
    // this flag, "loop stopped" and "worker process dead/respawning"
    // were indistinguishable to the UI — both rendered the same idle
    // panel while the actual cause was invisible.
    return NextResponse.json({ ...r.data, workerReachable: true, lessonOutcomes, healthTrend });
  }

  // Worker down — self-heal in the background (never block the poll; the
  // next 2s poll finds the respawned worker) and report an honestly idle
  // loop in the exact shape the UI expects, PLUS the honest cause: the
  // worker is unreachable. llmGate falls back to THIS process's gate —
  // still accurate for the autonomous loop's LLM calls.
  healWorkerInBackground();
  return NextResponse.json({
    running: false,
    workerReachable: false,
    stats: IDLE_STATS,
    logs: [],
    currentFile: null,
    llmGate: llmGateInfo(),
    saturation: {},
    // Shape parity with the worker's /status payload — null when the worker
    // (which owns the retention cache) is down, so the dashboard's branch
    // counter renders "unknown" rather than undefined.
    branchRetention: null,
    // Master-unlock flag defaults to false when the worker is down — a
    // dead worker can't have an active master session. Shape parity with
    // the worker's /status payload so the UI's `status?.masterUnlocked`
    // reads cleanly on every poll.
    masterUnlocked: false,
    // Lesson outcomes are independent of the worker (queried above from
    // the DB), so they're honest even when the worker is down.
    lessonOutcomes,
    // Health trend is also independent of the worker.
    healthTrend,
  });
}
