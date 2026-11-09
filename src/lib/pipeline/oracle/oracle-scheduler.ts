/**
 * Oracle Scheduler — background auto-evaluation of due prophecies.
 *
 * Without this, prophecies only get judged when a human clicks
 * [EVALUATE DUE] or POSTs /api/oracle/evaluate. A prediction system
 * that only settles its books when someone is watching isn't really
 * predicting — it's performing. The scheduler closes that gap: every
 * 5 minutes, it evaluates all due prophecies automatically.
 *
 * Design notes:
 *
 *   - LAZY BOOT: the scheduler starts on the first import of this
 *     module (which happens on the first oracle API request). No
 *     Next.js instrumentation hooks needed, no next.config changes.
 *
 *   - GLOBALTHIS GUARD: exactly one timer per Node process, even
 *     under dev-mode module re-instantiation. Same pattern as the
 *     Prisma client (src/lib/db.ts) and the oracle event ring
 *     (oracle-events.ts).
 *
 *   - LLM-GATE AWARE: the evaluator's LLM calls go through the shared
 *     serialized queue + cooldown gate (agent-llm.ts). If the provider
 *     is rate-limited, evaluateDueProphecies' calls return
 *     llm-unavailable and the prophecies stay pending — retried on the
 *     next scheduler tick. The scheduler NEVER forces through a
 *     cooldown and never steals quota from a running mutation: it
 *     checks llmIsCoolingDown() first and skips the tick entirely.
 *
 *   - CRASH-SILENT: any thrown error from a tick is caught and logged
 *     to the event ring as an error event; the timer keeps running.
 *     A background bookkeeper must never take the process down.
 *
 *   - UNREF: the timer is unref'd so it never keeps the Node process
 *     alive on its own (it would otherwise block clean shutdown).
 */

import { evaluateDueProphecies } from "./prophecy-evaluator";
import { emitOracleEvent } from "./oracle-events";
import { llmIsCoolingDown } from "../llm/agent-llm";
import { listDueProphecies } from "./prophecy-store";

const TICK_MS = 5 * 60 * 1000; // 5 minutes

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  lastTickAt: number;
  lastJudgedCount: number;
  ticks: number;
  booted: boolean;
}

const g = globalThis as unknown as { __oracleScheduler?: SchedulerState };

function sched(): SchedulerState {
  if (!g.__oracleScheduler) {
    g.__oracleScheduler = {
      timer: null,
      running: false,
      lastTickAt: 0,
      lastJudgedCount: 0,
      ticks: 0,
      booted: false,
    };
  }
  return g.__oracleScheduler;
}

/** One scheduler tick. Exported for manual testing via the terminal
 *  (oracle tick). Idempotent per tick — if a previous tick is still
 *  running (shouldn't happen; evaluation is bounded), this one exits. */
export async function oracleSchedulerTick(): Promise<{
  ran: boolean;
  judged?: number;
  skipped?: number;
  reason?: string;
}> {
  const s = sched();
  if (s.running) return { ran: false, reason: "previous tick still running" };

  // Skip entirely while the shared LLM gate is closed — never steal
  // quota from the mutation loop, never hammer a 429ing provider.
  if (llmIsCoolingDown()) {
    return { ran: false, reason: "LLM cooldown active — skipping tick" };
  }

  // Cheap pre-check: are there any due prophecies? One indexed count
  // beats kicking off the evaluator for nothing (the evaluator's own
  // DB read is cheap too, but this keeps the tick's happy path at
  // exactly one query and no LLM calls at all).
  let due: any[] = [];
  try {
    const result = await listDueProphecies();
    // Validate that we got an array back
    if (!Array.isArray(result)) {
      throw new Error(`listDueProphecies() returned non-array: ${typeof result}`);
    }
    due = result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(`Unknown error during prophecy listing: ${String(err)}`);
    emitOracleEvent(
      `Failed to list due prophecies during scheduler tick. Error: ${error.message}`,
      "error",
      "scheduler",
    );
    return { ran: false, reason: "failed to list due prophecies" };
  }

  s.lastTickAt = Date.now(); // Record tick time even if no prophecies are due
  s.ticks += 1;

  if (due.length === 0) {
    return { ran: true, judged: 0, skipped: 0 };
  }

  s.running = true;
  try {
    const { judged, skipped } = await evaluateDueProphecies();
    
    const judgedCount = (judged && Array.isArray(judged)) ? judged.length : 0;
    const skippedCount = (skipped && Array.isArray(skipped)) ? skipped.length : 0;

    s.lastJudgedCount = judgedCount;
    return { ran: true, judged: judgedCount, skipped: skippedCount };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(`Unknown error during prophecy evaluation: ${String(err)}`);
    emitOracleEvent(
      `Error during prophecy evaluation tick. Error: ${error.message}`,
      "error",
      "scheduler",
    );
    return { ran: true, judged: 0, skipped: 0, reason: "evaluation failed" };
  } finally {
    s.running = false;
  }
}

/** Boot the scheduler (idempotent). Called on module import. */
function bootOracleScheduler(): void {
  const s = sched();
  if (s.booted) return;
  s.booted = true;

  // First tick after a short delay (not immediately) — gives the
  // server a moment to finish booting before we touch the DB/LLM.
  const timer = setInterval(() => {
    oracleSchedulerTick().catch((err) => {
      // A background bookkeeper must never crash the process.
      const error = err instanceof Error ? err : new Error(`Unknown error in scheduler tick catch block: ${String(err)}`);
      emitOracleEvent(
        `Critical scheduler tick error: ${error.message}\n${error.stack}`,
        "error",
        "scheduler",
      );
    });
  }, TICK_MS);

  // Never keep the process alive just for the scheduler.
  if (typeof timer.unref === "function") timer.unref();
  s.timer = timer;

  emitOracleEvent(
    `Oracle scheduler booted — auto-evaluating due prophecies every ${Math.round(TICK_MS / 60000)} min`,
    "info",
    "scheduler",
  );
}

/** Status snapshot for the terminal command / API. */
export function oracleSchedulerStatus(): {
  booted: boolean;
  ticks: number;
  lastTickAt: string | null;
  lastJudgedCount: number;
  intervalMinutes: number;
} {
  const s = sched();
  return {
    booted: s.booted,
    ticks: s.ticks,
    lastTickAt: s.lastTickAt ? new Date(s.lastTickAt).toISOString() : null,
    lastJudgedCount: s.lastJudgedCount,
    intervalMinutes: Math.round(TICK_MS / 60000),
  };
}

// Boot on first import (any oracle API route bootstraps this).
bootOracleScheduler();