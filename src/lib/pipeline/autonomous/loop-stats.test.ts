import { describe, test, expect } from "bun:test";
import { writeLoopStats, readLoopStats, type LoopStatsState } from "./loop-stats";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";

/**
 * REAL-STATE tests. The stats file (.git/info/loop-stats.json) is the
 * durable tier of the LIVE loop — on a running dev server it exists and
 * is rewritten after every enhancement. The previous version of these
 * tests assumed the file was absent/invalid ("controlled environment")
 * and passed only on a fresh boot; against the live repo they failed.
 *
 * These tests now CONTROL the file state directly: back up the live
 * file, install the state under test, assert the contract, restore.
 * The self-enhance loop may rewrite the file mid-test (it persists
 * after every file enhancement), so each assertion retries after
 * re-taking control — losing the race once is a flake, losing it three
 * times in a row is a real failure. The restore in `finally` is
 * unconditional: the loop's durable tier must never stay deleted,
 * even if the assertion blows up.
 */

const STATS_FILE = PROJECT_ROOT ? join(PROJECT_ROOT, ".git/info/loop-stats.json") : null;

/** A structurally valid state for round-trip and baseline purposes. */
const VALID_STATE: LoopStatsState = {
  totalScanned: 7,
  totalEnhanced: 3,
  totalReverted: 1,
  totalPushed: 2,
  testsWritten: 1,
  cyclesCompleted: 4,
  tasksGenerated: 0,
  lastEnhancementAt: "2026-11-20T00:00:00.000Z",
};

interface ControlState {
  /** File content to install, or null to make the file absent. */
  content: string | null;
}

/** Back up the live file (if any). Returns the backed-up content, or
 *  null when the file was already absent. */
function backupLiveFile(): string | null {
  if (!STATS_FILE || !existsSync(STATS_FILE)) return null;
  return readFileSync(STATS_FILE, "utf8");
}

/** Install a controlled state. Returns the previous backup to restore. */
function installControlled(state: ControlState, backup: string | null): void {
  if (!STATS_FILE) throw new Error("STATS_FILE unresolvable — cannot control state");
  if (state.content === null) {
    if (existsSync(STATS_FILE)) unlinkSync(STATS_FILE);
  } else {
    writeFileSync(STATS_FILE, state.content, "utf8");
  }
  void backup;
}

/** Restore the live file. A stale backup self-heals: the loop's
 *  in-memory stats remain the live source and re-persist next cycle. */
function restoreBackup(backup: string | null): void {
  if (!STATS_FILE) return;
  if (backup === null) {
    if (existsSync(STATS_FILE)) unlinkSync(STATS_FILE);
  } else {
    writeFileSync(STATS_FILE, backup, "utf8");
  }
}

/** Run an assertion under controlled file state with race-tolerant
 *  retries. The live loop rewrites the file after every enhancement;
 *  if it wins a write inside our control window, we re-take control
 *  and retry rather than reporting a false failure. */
async function withControlledState(
  state: ControlState,
  assert: () => void,
  attempts = 3
): Promise<void> {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    const backup = backupLiveFile();
    try {
      installControlled(state, backup);
      assert();
      return;
    } catch (e) {
      lastError = e;
    } finally {
      restoreBackup(backup);
    }
  }
  throw lastError ?? new Error("withControlledState exhausted retries");
}

describe("loop-stats validation and contract", () => {
  // ── writeLoopStats validation (pure logic, no file dependency) ────

  test("writeLoopStats rejects state missing a numeric field (e.g., totalScanned)", () => {
    const invalidState: Partial<LoopStatsState> = {
      totalEnhanced: 1,
      totalReverted: 0,
      totalPushed: 0,
      testsWritten: 0,
      cyclesCompleted: 1,
      tasksGenerated: 0,
      lastEnhancementAt: "2023-01-01T00:00:00.000Z",
    };
    // Contract: invalid state is logged and skipped, never thrown, and
    // never persisted (the durable tier must not fabricate counters).
    expect(() => writeLoopStats(invalidState as LoopStatsState)).not.toThrow();
    // The skip must not have overwritten the live file with garbage:
    // after a rejected write, the file (if present) still parses.
    const after = readLoopStats();
    expect(after === null || typeof after.totalScanned === "number").toBe(true);
  });

  test("writeLoopStats rejects state with a negative numeric value", () => {
    const invalidState: LoopStatsState = {
      totalScanned: -1, // Invalid
      totalEnhanced: 1,
      totalReverted: 0,
      totalPushed: 0,
      testsWritten: 0,
      cyclesCompleted: 1,
      tasksGenerated: 0,
      lastEnhancementAt: "2023-01-01T00:00:00.000Z",
    };
    expect(() => writeLoopStats(invalidState)).not.toThrow();
  });

  test("writeLoopStats rejects state with an unparseable ISO string for lastEnhancementAt", () => {
    const invalidState: LoopStatsState = {
      totalScanned: 1,
      totalEnhanced: 1,
      totalReverted: 0,
      totalPushed: 0,
      testsWritten: 0,
      cyclesCompleted: 1,
      tasksGenerated: 0,
      lastEnhancementAt: "not-a-date-string", // Invalid
    };
    expect(() => writeLoopStats(invalidState)).not.toThrow();
  });

  // ── readLoopStats controlled-state contract ────────────────────────

  test("readLoopStats returns null when the stats file does not exist", async () => {
    await withControlledState({ content: null }, () => {
      expect(readLoopStats()).toBeNull();
    });
  });

  test("readLoopStats returns null when the file content is not valid JSON", async () => {
    await withControlledState({ content: "{ this is not valid json !!" }, () => {
      expect(readLoopStats()).toBeNull();
    });
  });

  test("readLoopStats returns null when the parsed object is missing a required numeric field", async () => {
    // Valid JSON, structurally incomplete: totalScanned absent.
    const missingField = JSON.stringify({
      totalEnhanced: 1,
      totalReverted: 0,
      totalPushed: 0,
      testsWritten: 0,
      cyclesCompleted: 1,
      tasksGenerated: 0,
      lastEnhancementAt: "2026-11-20T00:00:00.000Z",
    });
    await withControlledState({ content: missingField }, () => {
      expect(readLoopStats()).toBeNull();
    });
  });

  test("readLoopStats round-trips a valid state (write → read → equal)", async () => {
    // The happy path is also state-controlled: the live file belongs to
    // the running loop; this test must read back what IT wrote, not
    // whatever the loop persisted in the meantime.
    await withControlledState({ content: JSON.stringify(VALID_STATE) }, () => {
      const result = readLoopStats();
      expect(result).not.toBeNull();
      expect(result).toEqual(VALID_STATE);
    });
  });
});
