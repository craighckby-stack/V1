/**
 * Operator crash-budget store — the wipe-proof tier for "this loop crashed
 * N times in a row on the same error class".
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * The autonomous loop's `runContinuousLoop` already catches per-cycle
 * throws and continues (the loop is "never-stop" by design). But a
 * sustained crash — the same error class three cycles in a row — is a
 * signal that something is structurally broken, not transient. The
 * summary's stop-priority hierarchy says: "lint/build/tests 连续 2 次失败 →
 * 人工 review" and "segfault 前置：3 次 crash → 永久 PAUSE 至手动 re-arm".
 *
 * The crash budget is the second tier of that wall. The first tier (the
 * in-memory `consecutiveCrashCount` field on the runtime) resets to 0 on
 * every process restart — so a segfault that KILLS the process and the
 * auto-restart boots a fresh instance would silently reset the count,
 * and the wall would never trip. Persisting the count to disk (same
 * .git/info/ tier as the armed-state, vault key, swap journal) makes the
 * count survive process death AND the sandbox's SQLite rollbacks.
 *
 * THE CONTRACT
 *   readCrashBudget()  → null on any read/parse failure (fail-closed:
 *                       the caller treats null as "0 crashes / no wall",
 *                       because a missing file is the fresh-install state,
 *                       not a wall. A MALFORMED file is also null — never
 *                       fabricate a wall that the operator didn't trip).
 *   writeCrashBudget() → best-effort, never throws (in-memory remains
 *                       the live source; disk is the restart tier).
 *   resetCrashBudget() → count→0, crashWall→false. Called on a
 *                       successful cycle AND on an explicit [START].
 *
 * Pure leaf: fs + path + PROJECT_ROOT only, no pipeline imports — safe
 * to load from anywhere (loop-runtime, API routes, instrumentation).
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";

const CRASH_BUDGET_FILE = join(
  PROJECT_ROOT,
  ".git/info/loop-crash-budget.json"
);

export interface CrashBudgetState {
  /** Consecutive same-class crashes. Reset to 0 on a clean cycle. */
  count: number;
  /** The error class (Error.name or constructor name) of the last crash.
   *  Different classes reset the count — only SUSTAINED same-class
   *  crashes trip the wall. A network blip followed by a segfault is 2
   *  different problems, not a pattern. */
  lastClass: string;
  /** ISO timestamp of the last crash — for the boot log line. */
  at: string;
  /** True once the wall has tripped (count >= 3). Sticky until an
   *  explicit [START] — no boot, probe, or quota event clears it. */
  crashWall: boolean;
}

/** Read the persisted crash budget. null when absent, unreadable, or
 *  malformed — the caller treats null as "0 crashes, no wall" (the
 *  fresh-install state). Never fabricate a wall from a bad read. */
export function readCrashBudget(): CrashBudgetState | null {
  try {
    const raw = readFileSync(CRASH_BUDGET_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<CrashBudgetState>;
    if (
      parsed &&
      typeof parsed.count === "number" &&
      typeof parsed.lastClass === "string" &&
      typeof parsed.at === "string" &&
      typeof parsed.crashWall === "boolean"
    ) {
      return {
        count: parsed.count,
        lastClass: parsed.lastClass,
        at: parsed.at,
        crashWall: parsed.crashWall,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the crash budget. Never throws — a persistence failure must
 *  never fail a crash-count increment that already succeeded in memory. */
export function writeCrashBudget(s: CrashBudgetState): void {
  try {
    // Ensure directory exists before writing file
    const dir = join(PROJECT_ROOT, ".git/info");
    mkdirSync(dir, { recursive: true });
    writeFileSync(CRASH_BUDGET_FILE, JSON.stringify(s, null, 2), "utf8");
  } catch {
    /* best-effort — same contract as the armed-state file */
  }
}

/** Reset the budget to a clean state. Called on a successful cycle AND
 *  on an explicit [START] (the operator's re-arm gesture). */
export function resetCrashBudget(): void {
  writeCrashBudget({
    count: 0,
    lastClass: "",
    at: new Date().toISOString(),
    crashWall: false,
  });
}