/**
 * Operator last-touch store — the wipe-proof tier for the dead-man's
 * switch.
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * The autonomous loop, once armed, runs by itself whenever the LLM quota
 * gate is open — across process restarts (the armed-state file persists
 * the intent) and across DB rolls. That is the whole point of "run by
 * itself when quota is available": arm once, walk away, the loop works.
 *
 * The dead-man's switch is the SAFETY COUNTERWEIGHT to that autonomy.
 * If the operator has not touched the system in N hours (default 24h),
 * the loop auto-PAUSES — no boot auto-arm, no quota-driven resume. The
 * operator has to press [START] again to re-arm. This stops a runaway
 * loop from quietly burning API quota for days while the operator is on
 * vacation; the operator must check in at least once a day for the
 * autonomy to keep running.
 *
 * "Touched" means: an explicit [START], [STOP], or config PATCH. The
 * internal quota-driven backoff and the recovery probe are NOT touches
 * — they are the loop running itself, not the operator touching it.
 *
 * THE CONTRACT
 *   markOperatorTouch()   → writes now() to disk. Called from the
 *                           runtime's start() / stop() / updateConfig()
 *                           methods (and ONLY from there). Best-effort,
 *                           never throws — the in-memory state is the
 *                           live source.
 *   readOperatorTouch()   → null when absent, unreadable, or torn.
 *                           Treated by isDeadMansTripped() as "tripped"
 *                           (an unreadable file must never fabricate
 *                           "operator just touched it").
 *   isDeadMansTripped()   → true when now - lastTouch > thresholdMs, OR
 *                           when no touch has ever been recorded. The
 *                           threshold default is 24h.
 *
 * Pure leaf: fs + path + PROJECT_ROOT only.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";

const OPERATOR_TOUCH_FILE = join(
  PROJECT_ROOT,
  ".git/info/loop-operator-touch.json"
);

/** Default dead-man's threshold: 24 hours. The loop must be touched
 *  (started/stopped/config-patched) at least once per day or it
 *  auto-pauses. */
export const DEFAULT_DEAD_MANS_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface OperatorTouchState {
  /** ISO timestamp of the last [START]/[STOP]/config PATCH. */
  at: string;
  /** What made the change — same shape as armed-state's `by`. */
  by: string;
}

/** Record an operator touch. `by` should match the caller's gesture
 *  ("operator-start" | "operator-stop" | "config-patch"). Never throws —
 *  a persistence failure must not fail a start/stop that already
 *  succeeded in memory. */
export function markOperatorTouch(by: string, now: Date = new Date()): void {
  if (!by || typeof by !== "string" || by.trim() === "") {
    throw new Error("markOperatorTouch: 'by' parameter must be a non-empty string");
  }
  
  try {
    // Validate PROJECT_ROOT to prevent path traversal
    if (PROJECT_ROOT.includes("..") || PROJECT_ROOT.includes("~")) {
      throw new Error("Invalid PROJECT_ROOT path");
    }
    
    mkdirSync(join(PROJECT_ROOT, ".git/info"), { recursive: true });
    const entry: OperatorTouchState = { at: now.toISOString(), by };
    writeFileSync(OPERATOR_TOUCH_FILE, JSON.stringify(entry, null, 2), "utf8");
  } catch (error) {
    /* best-effort - log the error for debugging if needed */
    if (error instanceof Error) {
      console.error("Failed to write operator touch file:", error.message);
    } else {
      console.error("Failed to write operator touch file:", error);
    }
  }
}

/** Read the persisted touch. null when absent, unreadable, or malformed —
 *  the caller (isDeadMansTripped) treats null as "tripped" (never
 *  fabricate a recent touch from a missing or bad file). */
export function readOperatorTouch(): OperatorTouchState | null {
  try {
    const raw = readFileSync(OPERATOR_TOUCH_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<OperatorTouchState>;
    if (parsed && typeof parsed.at === "string" && typeof parsed.by === "string") {
      // Validate timestamp format before returning
      const timestamp = Date.parse(parsed.at);
      if (!isNaN(timestamp)) {
        return {
          at: parsed.at,
          by: parsed.by,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the dead-man's switch is tripped: the last touch was
 *  more than `thresholdMs` ago, OR no touch has ever been recorded
 *  (a never-touched system must not auto-arm forever). Fail-closed:
 *  an unreadable touch file is treated as tripped (never fabricate a
 *  recent touch from a bad read). */
export function isDeadMansTripped(
  thresholdMs: number = DEFAULT_DEAD_MANS_THRESHOLD_MS,
  now: Date = new Date()
): boolean {
  if (typeof thresholdMs !== "number" || thresholdMs < 0) {
    throw new Error("isDeadMansTripped: 'thresholdMs' must be a non-negative number");
  }
  
  const state = readOperatorTouch();
  if (!state || !state.at) return true; // never touched → tripped
  const lastTouch = Date.parse(state.at);
  if (!Number.isFinite(lastTouch)) return true; // bad timestamp → tripped
  return now.getTime() - lastTouch > thresholdMs;
}