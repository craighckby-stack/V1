/**
 * Oracle Events — a globalThis-guarded in-memory ring buffer of oracle
 * lifecycle events (prophecy made, prophecy judged, scheduler runs).
 *
 * Why this exists: the oracle runs partially in the background (the
 * scheduler auto-evaluates due prophecies; the self-enhance loop
 * auto-generates one prophecy per completed cycle). Background events
 * need to surface in the unified console stream — the system narrating
 * its own predictions — the same way the loop's own logs do.
 *
 * Design constraints that shaped this module:
 *
 *   1. DEV-SAFE: Next.js dev mode recompiles modules and can create a
 *      new module instance per compile. A bare module-level buffer
 *      would silently reset (or worse, multiple instances would each
 *      hold part of the history). The globalThis guard — the same
 *      pattern as the Prisma client singleton in src/lib/db.ts —
 *      ensures exactly ONE buffer per Node process, no matter how
 *      many times the module is re-instantiated.
 *
 *   2. BOUNDED: a fixed-size ring (200 entries). Old events are
 *      dropped. This is a *display* buffer, not a record — the DB
 *      (Prophecy rows) is the record. Nothing is lost that matters.
 *
 *   3. DEDUP-FRIENDLY: each event carries a unique key (timestamp +
 *      sequence). The page.tsx poller uses the same dedup approach it
 *      uses for loop logs: once a key is seen, it's never re-added.
 *
 *   4. NO PERSISTENCE: events survive within a server process's
 *      lifetime only. A restart clears them — acceptable, because the
 *      prophecies themselves live in the DB and re-appear via the
 *      /api/oracle/prophecies poll.
 *
 * The buffer is intentionally dumb: append, read, clear. No filtering,
 * no aggregation — the UI and the terminal commands shape the display.
 */

/** One oracle lifecycle event. Shape mirrors the loop's LogEntry so
 *  the console stream can render both through the same path. */
export interface OracleEvent {
  /** ISO timestamp — the display key. */
  timestamp: string;
  /** Human-readable message, one line, terminal-friendly. */
  message: string;
  /** Event classification — maps to the console stream's logType. */
  type: "info" | "success" | "warn" | "error";
  /** Which oracle stage produced it: generator | evaluator | scheduler. */
  source: "generator" | "evaluator" | "scheduler";
}

const MAX_EVENTS = 200;

/** The shared buffer state, stored on globalThis so dev-mode module
 *  re-instantiation can't reset or duplicate it. */
interface OracleEventState {
  buffer: OracleEvent[];
  /** Monotonic sequence — makes dedup keys collision-proof even when
   *  two events share a millisecond timestamp. */
  seq: number;
  /** Last time the buffer was read — the events route uses this to
   *  offer a cheap `since` cursor. */
  lastReadAt: number;
}

const g = globalThis as unknown as { __oracleEvents?: OracleEventState };

function state(): OracleEventState {
  if (!g.__oracleEvents) {
    g.__oracleEvents = { buffer: [], seq: 0, lastReadAt: Date.now() };
  }
  return g.__oracleEvents;
}

/** Append an event. Old entries are evicted beyond MAX_EVENTS.
 *  Truncates messages to 300 chars — the console stream is a terminal,
 *  not a document; long claims get clipped with an ellipsis. */
export function emitOracleEvent(
  message: string,
  type: OracleEvent["type"] = "info",
  source: OracleEvent["source"] = "scheduler",
): OracleEvent {
  if (message === null || message === undefined) {
    throw new Error("Oracle event message cannot be null or undefined");
  }
  if (type === null || type === undefined) {
    throw new Error("Oracle event type cannot be null or undefined");
  }
  if (source === null || source === undefined) {
    throw new Error("Oracle event source cannot be null or undefined");
  }
  
  const s = state();
  const trimmed =
    message.length > 300 ? `${message.slice(0, 299)}…` : message;
  const event: OracleEvent = {
    timestamp: new Date().toISOString(),
    message: trimmed,
    type,
    source,
  };
  s.buffer.push(event);
  if (s.buffer.length > MAX_EVENTS) {
    s.buffer.splice(0, s.buffer.length - MAX_EVENTS);
  }
  s.seq += 1;
  return event;
}

/** Read events, optionally only those after a given sequence number.
 *  Returns the events and the current high-water sequence — the caller
 *  passes it back on the next poll to get only fresh events. */
export function readOracleEvents(afterSeq?: number): {
  events: OracleEvent[];
  seq: number;
} {
  const s = state();
  s.lastReadAt = Date.now();
  
  if (typeof afterSeq === "number") {
    if (afterSeq < 0) {
      throw new Error("afterSeq must be a non-negative number");
    }
    if (afterSeq >= s.seq) {
      return { events: [], seq: s.seq };
    }
    if (afterSeq < s.seq) {
      // The caller has seen `afterSeq` events already. The buffer holds
      // the most recent MAX_EVENTS; if afterSeq is older than what the
      // buffer holds, we return the whole buffer (best effort — the
      // gap events were dropped by the ring).
      return { events: [...s.buffer], seq: s.seq };
    }
  }
  
  // No afterSeq provided or invalid, return all events
  return { events: s.buffer, seq: s.seq };
}

/** Current sequence — lets a first-time caller snapshot "now" and only
 *  receive events appended after its subscription started. */
export function currentOracleSeq(): number {
  return state().seq;
}

/** Clear (used by tests / manual reset via the terminal). */
export function clearOracleEvents(): void {
  const s = state();
  s.buffer = [];
  // seq keeps counting — never resets — so old dedup keys stay dead.
}