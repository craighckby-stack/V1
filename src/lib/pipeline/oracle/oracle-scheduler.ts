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
  lockToken?: number;
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
  
  // Generate a unique lock token for this tick attempt
  const lockToken = Date.now();
  
  // Check if already running with a different lock token
  if (s.running && s.lockToken !== lockToken) {
    return { ran: false, reason: "previous tick still running" };
  }

  // Skip entirely while the shared LLM gate is closed — never steal
  // quota from the mutation loop, never hammer a 429ing provider.
  if (llmIsCoolingDown()) {
    return { ran: false, reason: "LLM cooldown active — skipping tick" };
  }

  // Set the lock token and running flag
  s.lockToken = lockToken;
  s.running = true;

  // Cheap pre-check: are there any due prophecies? One indexed count
  // beats kicking off the evaluator for nothing (the evaluator's own
  // DB read is cheap too, but this keeps the tick's happy path at
  // exactly one query and no LLM calls at all).
  let due: any[] = [];
  try {
    due = await listDueProphecies();
    
    // Validate input to handle potential null/undefined results
    if (!due || !Array.isArray(due)) {
      emitOracleEvent(
        "Oracle scheduler error: listDueProphecies returned invalid data",
        "error",
        "scheduler",
      );
      return { ran: false, reason: "invalid data from prophecy store" };
    }
  } catch (err) {
    emitOracleEvent(
      `Oracle scheduler error listing due prophecies: ${(err as Error).message}`,
      "error",
      "scheduler",
    );
    return { ran: false, reason: "error listing prophecies" };
  }

  if (due.length === 0) {
    s.lastTickAt = Date.now();
    s.ticks += 1;
    s.running = false;
    delete s.lockToken;
    return { ran: true, judged: 0, skipped: 0 };
  }

  try {
    const result = await evaluateDueProphecies();
    
    // Validate the result structure
    if (!result || typeof result !== 'object' || !('judged' in result) || !('skipped' in result)) {
      emitOracleEvent(
        "Oracle scheduler error: evaluateDueProphecies returned invalid result structure",
        "error",
        "scheduler",
      );
      return { ran: false, reason: "invalid result structure from prophecy evaluator" };
    }
    
    const { judged, skipped } = result;
    
    // Validate judged and skipped are arrays
    if (!Array.isArray(judged) || !Array.isArray(skipped)) {
      emitOracleEvent(
        "Oracle scheduler error: evaluateDueProphecies returned non-array for judged or skipped",
        "error",
        "scheduler",
      );
      return { ran: false, reason: "invalid array structure from prophecy evaluator" };
    }
    
    s.lastTickAt = Date.now();
    s.lastJudgedCount = judged.length;
    s.ticks += 1;
    return { ran: true, judged: judged.length, skipped: skipped.length };
  } catch (err) {
    emitOracleEvent(
      `Oracle scheduler error evaluating prophecies: ${(err as Error).message}`,
      "error",
      "scheduler",
    );
    return { ran: false, reason: "error evaluating prophecies" };
  } finally {
    s.running = false;
    delete s.lockToken;
  }
}

/** Boot the scheduler (idempotent). Called on module import. */
function bootOracleScheduler(): void {
  const s = sched();
  if (s.booted) {
    // Clear existing timer to prevent memory leaks if re-booting
    if (s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
    return;
  }
  s.booted = true;

  // First tick after a short delay (not immediately) — gives the
  // server a moment to finish booting before we touch the DB/LLM.
  const timer = setInterval(() => {
    oracleSchedulerTick().catch((err) => {
      // A background bookkeeper must never crash the process.
      emitOracleEvent(
        `Oracle scheduler tick error: ${(err as Error).message}`,
        "error",
        "scheduler",
      );
    });
  }, TICK_MS);

  // Never keep the process alive just for the scheduler.
  if (timer && typeof timer.unref === "function") timer.unref();
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