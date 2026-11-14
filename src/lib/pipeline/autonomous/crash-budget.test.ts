import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import {
  readCrashBudget,
  writeCrashBudget,
  resetCrashBudget,
  type CrashBudgetState,
} from "./crash-budget";
import {
  existsSync,
  writeFileSync,
  unlinkSync,
  copyFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";

/**
 * Characterization tests for the operator crash-budget store.
 *
 * WHY THE PATH IS RE-DERIVED LOCALLY
 * ────────────────────────────────
 * `crash-budget.ts` resolves its file to `PROJECT_ROOT/.git/info/loop-crash-
 * budget.json`. The same `PROJECT_ROOT` is imported here, so the path the
 * tests manipulate is byte-identical to the path the production code reads
 * and writes — in BOTH execution modes:
 *
 *   - sandbox (loop/ratchet runner): PROJECT_ROOT is the throwaway copy at
 *     `.loop-sandbox/verify-XXXX/`, which has NO `.git/info/`. The file is
 *     absent on entry, any `writeCrashBudget`/`resetCrashBudget` call creates
 *     it inside the sandbox, and the sandbox is deleted on exit. Nothing
 *     the tests do can escape.
 *   - direct `bun test`: PROJECT_ROOT is the real project root, and the
 *     live `.git/info/loop-crash-budget.json` may hold the operator's real
 *     crash count. `beforeAll`/`afterAll` below back it up and restore it
 *     so a test run can NEVER pollute the live state.
 *
 * This is the contract TEST-ATTACKER flagged the previous file for
 * violating: the old tests constructed inline objects and asserted on
 * those (tautological), AND they called `writeCrashBudget`/`resetCrashBudget`
 * against the live file (side-effect pollution). Both are gone now.
 */
const CRASH_BUDGET_FILE = join(PROJECT_ROOT, ".git/info/loop-crash-budget.json");
const BACKUP_FILE = `${CRASH_BUDGET_FILE}.test-backup`;

let hadOriginalFile: boolean;

beforeAll(() => {
  // Defend the live state when running directly (not via the sandbox).
  // Inside the sandbox the file is absent, so this is a no-op there.
  hadOriginalFile = existsSync(CRASH_BUDGET_FILE);
  if (hadOriginalFile) {
    mkdirSync(join(CRASH_BUDGET_FILE, ".."), { recursive: true });
    copyFileSync(CRASH_BUDGET_FILE, BACKUP_FILE);
    unlinkSync(CRASH_BUDGET_FILE);
  }
});

afterAll(() => {
  // Always clear any test-written state, then restore the operator's file
  // if we moved it. Runs on every exit path (success, failure, exception).
  if (existsSync(CRASH_BUDGET_FILE)) unlinkSync(CRASH_BUDGET_FILE);
  if (hadOriginalFile) {
    copyFileSync(BACKUP_FILE, CRASH_BUDGET_FILE);
    unlinkSync(BACKUP_FILE);
  }
});

beforeEach(() => {
  // Each test starts from a known (file-absent) baseline. A write left
  // behind by a previous test would otherwise leak into the next one.
  if (existsSync(CRASH_BUDGET_FILE)) unlinkSync(CRASH_BUDGET_FILE);
});

describe("crash-budget", () => {
  // ── readCrashBudget ────────────────────────────────────────────────

  test("readCrashBudget returns null when the file is absent", () => {
    expect(existsSync(CRASH_BUDGET_FILE)).toBe(false);
    expect(readCrashBudget()).toBeNull();
  });

  test("readCrashBudget returns null for malformed JSON", () => {
    mkdirSync(join(CRASH_BUDGET_FILE, ".."), { recursive: true });
    writeFileSync(CRASH_BUDGET_FILE, "{ this is not valid json,,,", "utf8");
    expect(readCrashBudget()).toBeNull();
  });

  test("readCrashBudget returns null when required fields are missing", () => {
    mkdirSync(join(CRASH_BUDGET_FILE, ".."), { recursive: true });
    writeFileSync(CRASH_BUDGET_FILE, JSON.stringify({ count: 2 }), "utf8");
    expect(readCrashBudget()).toBeNull();
  });

  test("readCrashBudget returns null when field types are wrong", () => {
    mkdirSync(join(CRASH_BUDGET_FILE, ".."), { recursive: true });
    writeFileSync(
      CRASH_BUDGET_FILE,
      JSON.stringify({
        count: "two", // string, not number
        lastClass: "TypeError",
        at: "2023-01-01T00:00:00.000Z",
        crashWall: false,
      }),
      "utf8"
    );
    expect(readCrashBudget()).toBeNull();
  });

  test("readCrashBudget returns null when crashWall is not a boolean", () => {
    mkdirSync(join(CRASH_BUDGET_FILE, ".."), { recursive: true });
    writeFileSync(
      CRASH_BUDGET_FILE,
      JSON.stringify({
        count: 1,
        lastClass: "Error",
        at: "2023-01-01T00:00:00.000Z",
        crashWall: "yes", // string, not boolean
      }),
      "utf8"
    );
    expect(readCrashBudget()).toBeNull();
  });

  test("readCrashBudget returns the stored state when the file is well-formed", () => {
    const state: CrashBudgetState = {
      count: 2,
      lastClass: "TypeError",
      at: "2023-01-01T00:00:00.000Z",
      crashWall: false,
    };
    mkdirSync(join(CRASH_BUDGET_FILE, ".."), { recursive: true });
    writeFileSync(CRASH_BUDGET_FILE, JSON.stringify(state), "utf8");
    expect(readCrashBudget()).toEqual(state);
  });

  // ── writeCrashBudget ──────────────────────────────────────────────

  test("writeCrashBudget throws when state is null", () => {
    expect(() => writeCrashBudget(null as unknown as CrashBudgetState)).toThrow(
      /cannot be null or undefined/i
    );
  });

  test("writeCrashBudget throws when state is undefined", () => {
    expect(() => writeCrashBudget(undefined as unknown as CrashBudgetState)).toThrow(
      /cannot be null or undefined/i
    );
  });

  test("writeCrashBudget throws for an empty object (missing required fields)", () => {
    expect(() => writeCrashBudget({} as CrashBudgetState)).toThrow(
      /Invalid crash budget state/
    );
  });

  test("writeCrashBudget throws for wrong field types", () => {
    expect(() =>
      writeCrashBudget({
        count: "not a number" as unknown as number,
        lastClass: "TypeError",
        at: "2023-01-01T00:00:00.000Z",
        crashWall: false,
      } as CrashBudgetState)
    ).toThrow(/Invalid crash budget state/);
  });

  test("writeCrashBudget throws for a negative count", () => {
    expect(() =>
      writeCrashBudget({
        count: -1,
        lastClass: "TypeError",
        at: "2023-01-01T00:00:00.000Z",
        crashWall: false,
      } as CrashBudgetState)
    ).toThrow(/Invalid crash budget state/);
  });

  test("writeCrashBudget round-trips a valid state through readCrashBudget", () => {
    const state: CrashBudgetState = {
      count: 3,
      lastClass: "RangeError",
      at: "2024-05-06T07:08:09.000Z",
      crashWall: true,
    };
    writeCrashBudget(state);
    expect(readCrashBudget()).toEqual(state);
  });

  // ── resetCrashBudget ──────────────────────────────────────────────

  test("resetCrashBudget writes a clean state: count=0, lastClass='', crashWall=false", () => {
    resetCrashBudget();
    const read = readCrashBudget();
    expect(read).not.toBeNull();
    expect(read!.count).toBe(0);
    expect(read!.lastClass).toBe("");
    expect(read!.crashWall).toBe(false);
    // `at` must be a parseable ISO timestamp — the operator's boot log
    // line reads this field and renders it.
    expect(typeof read!.at).toBe("string");
    expect(() => new Date(read!.at).toISOString()).not.toThrow();
  });

  test("resetCrashBudget clears a previously tripped wall", () => {
    // Trip the wall: 5 sustained same-class crashes, wall is sticky.
    writeCrashBudget({
      count: 5,
      lastClass: "SegfaultError",
      at: "2020-01-01T00:00:00.000Z",
      crashWall: true,
    });
    expect(readCrashBudget()?.crashWall).toBe(true);

    // The operator's re-arm gesture ([START]) must clear it.
    resetCrashBudget();

    const after = readCrashBudget();
    expect(after).not.toBeNull();
    expect(after!.crashWall).toBe(false);
    expect(after!.count).toBe(0);
    expect(after!.lastClass).toBe("");
  });
});
