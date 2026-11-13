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
  /** Which oracle stage produced it: generator | evaluator | scheduler |
   *  auto-adjudicator (the deterministic self-prophecy judge from
   *  oracle-auto.ts, audit 7). */
  source: "generator" | "evaluator" | "scheduler" | "auto-adjudicator";
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
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("Oracle event message must be a non-empty string.");
  }

  // Input validation for source type
  if (typeof source !== "string" || !["generator", "evaluator", "scheduler", "auto-adjudicator"].includes(source)) {
    throw new TypeError(`Invalid event source: ${source}. Must be one of: generator, evaluator, scheduler, auto-adjudicator`);
  }

  // Validate type parameter
  if (!["info", "success", "warn", "error"].includes(type)) {
    throw new TypeError(`Invalid event type: ${type}. Must be one of: info, success, warn, error`);
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

  // ── WORKER BRIDGE (loop worker split) ────────────────────────────────
  // Since the self-enhance loop moved to mini-services/loop-worker, the
  // oracle events it generates (auto-prophecy after a cycle, self-prophecy
  // adjudication) are emitted in the WORKER process — whose ring buffer
  // nobody reads. The display ring lives in the Next.js server (the
  // console stream polls /api/oracle/events there). In the worker, dual-
  // write each event to the server's ingest endpoint so the console keeps
  // ONE ring and ONE sequence space. Fire-and-forget: a slow or down
  // server must never block or throw inside the loop's oracle paths.
  // The ingest route validates the shared token — this is display-stream
  // tamper resistance, not a security boundary.
  if (process.env.LOOP_WORKER === "1") {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    fetch(
      `${process.env.LOOP_SERVER_URL ?? "http://localhost:3000"}/api/oracle/events/ingest`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-loop-worker-token":
            process.env.LOOP_WORKER_TOKEN ?? "loop-worker-ingest-v1",
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      }
    )
    .then(() => {
      clearTimeout(timeoutId);
    })
    .catch((error) => {
      // Log the error for debugging but don't block the main flow
      console.error(`Failed to send oracle event to server (source: ${source}, type: ${type}, message: "${message}"):`, error);
    })
    .finally(() => {
      // Ensure the timeout is cleared even if the request was aborted
      clearTimeout(timeoutId);
    });
  }

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
  const currentSeq = s.seq;

  if (typeof afterSeq === "number" && Number.isInteger(afterSeq) && afterSeq >= 0) {
    if (afterSeq >= currentSeq) {
      // No new events since the last check.
      s.lastReadAt = Date.now();
      return { events: [], seq: currentSeq };
    }

    // Find the starting index of the first event whose sequence is > afterSeq.
    const bufferLength = s.buffer.length;
    let startIndex = -1;

    if (bufferLength === 0) {
        s.lastReadAt = Date.now();
        return { events: [], seq: currentSeq };
    }

    // Iterate through the buffer to find the first event whose sequence > afterSeq.
    for (let i = 0; i < bufferLength; i++) {
        // The sequence of the event at index i is: currentSeq - bufferLength + i
        const eventSeq = currentSeq - bufferLength + i;
        if (eventSeq > afterSeq) {
            startIndex = i;
            break;
        }
    }


    if (startIndex === -1) {
      // No new events found in the current buffer snapshot greater than afterSeq.
      s.lastReadAt = Date.now();
      return { events: [], seq: currentSeq };
    }

    // Get the events from startIndex to the end
    const events = s.buffer.slice(startIndex);

    s.lastReadAt = Date.now(); // Update lastReadAt after reading events
    return {
      events,
      seq: currentSeq,
    };
  }

  // No afterSeq provided or invalid, return all events
  s.lastReadAt = Date.now(); // Update lastReadAt when returning all events
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