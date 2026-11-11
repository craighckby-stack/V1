/**
 * Self-enhance loop armed-intent store — the wipe-proof tier for "this loop
 * was started / rebooted".
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * The self-enhance loop's `continuous` flag lives in memory. A process
 * restart (dev-server reload, crash, sandbox reboot) resets it to false —
 * so an operator who pressed [START] or saved a Gemini key (which reboots
 * the loop) finds a dead loop after the next server recycle, and has to
 * press [START] again by hand. That defeats "automate this with system
 * start": the whole point of wiring a Gemini key + reboot is that the loop
 * keeps running on its own.
 *
 * The autonomous loop already has this pattern (./armed-state.ts,
 * `.git/info/loop-armed-state.json`). This file is the parallel tier for
 * the self-enhance loop — a SEPARATE file (`.git/info/loop-self-enhance-
 * armed.json`) so the two loops' intents never collide (you can arm the
 * autonomous loop and stop the self-enhance loop, or vice versa, and each
 * intent survives independently across restarts).
 *
 * .git/info/ is never tracked, never committed, and survives both process
 * restarts and the sandbox's SQLite rollbacks — same wipe-proof contract
 * as the autonomous loop's armed state. See armed-state.ts for the full
 * rationale.
 *
 * SEMANTICS (one boolean, written by exactly three call sites)
 *   [START]  / POST /api/self-enhance/start  → markSelfEnhanceArmed(true,  "operator-start")
 *   [REBOOT] / POST /api/self-enhance/reboot → markSelfEnhanceArmed(true,  "reboot-on-config")
 *   [STOP]   / POST /api/self-enhance/stop  → markSelfEnhanceArmed(false, "operator-stop")
 *
 * The boot auto-start (self-enhance-loop constructor) reads this file: if
 * the operator left the loop armed, the fresh process re-arms it. Safe-mode
 * (duress) and an in-flight cycle are respected — see the constructor.
 * [STOP] clears the intent so nothing auto-starts again until the next
 * explicit [START] or [SAVE · VERIFY · REBOOT].
 *
 * Pure leaf: fs + path + PROJECT_ROOT only, no pipeline imports — safe to
 * load from anywhere (self-enhance-loop constructor, API routes).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";

const ARMED_STATE_FILE = join(
  PROJECT_ROOT,
  ".git/info/loop-self-enhance-armed.json"
);

export interface SelfEnhanceArmedState {
  /** The operator's intent. true = armed (auto-run on boot). */
  armed: boolean;
  /** ISO timestamp of the last change — for the boot log line. */
  at: string;
  /** What made the change. */
  by: string;
}

/** Persist the armed intent. Never throws — a persistence failure must
 *  never fail a start/stop that already succeeded in memory (the in-memory
 *  flag remains the live source; the disk file is the restart tier). */
export function markSelfEnhanceArmed(armed: boolean, by: string): void {
  if (!PROJECT_ROOT) {
    console.error(`markSelfEnhanceArmed: PROJECT_ROOT is not defined, cannot write to ${ARMED_STATE_FILE}`);
    return;
  }
  if (typeof armed !== "boolean") {
    console.error("markSelfEnhanceArmed: 'armed' must be a boolean");
    return;
  }
  if (!by || typeof by !== "string" || by.trim().length === 0) {
    console.error("markSelfEnhanceArmed: 'by' must be a non-empty string");
    return;
  }
  try {
    const infoDir = join(PROJECT_ROOT, ".git/info");
    mkdirSync(infoDir, { recursive: true });
    const entry: SelfEnhanceArmedState = {
      armed,
      at: new Date().toISOString(),
      by,
    };
    writeFileSync(ARMED_STATE_FILE, JSON.stringify(entry, null, 2), "utf8");
  } catch (error) {
    console.error(
      `markSelfEnhanceArmed: Failed to persist armed state (armed=${armed}). Check file system permissions or PROJECT_ROOT validity. Operation failed for 'by': ${by}`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** Read the persisted intent. null when absent, unreadable, or torn —
 *  the caller treats null as "not armed" (fail-closed: a missing file
 *  must never fabricate an armed state). A MALFORMED file (bad JSON,
 *  missing `armed` boolean) is ALSO null — never fabricate armed from
 *  a bad read. */
export function readSelfEnhanceArmedState(): SelfEnhanceArmedState | null {
  if (!PROJECT_ROOT) {
    console.error("readSelfEnhanceArmedState: PROJECT_ROOT is not defined, cannot check state.");
    return null;
  }
  try {
    if (!existsSync(ARMED_STATE_FILE)) return null;
    const raw = readFileSync(ARMED_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.armed !== undefined &&
      typeof parsed.armed === "boolean" &&
      parsed.at !== undefined &&
      typeof parsed.at === "string" &&
      parsed.by !== undefined &&
      typeof parsed.by === "string" &&
      parsed.by.trim() !== "" &&
      !isNaN(Date.parse(parsed.at))
    ) {
      return {
        armed: parsed.armed,
        at: parsed.at,
        by: parsed.by,
      };
    }
    return null;
  } catch (error) {
    console.error(
      "readSelfEnhanceArmedState: Failed to read or parse armed state file at",
      ARMED_STATE_FILE,
      "Error:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}