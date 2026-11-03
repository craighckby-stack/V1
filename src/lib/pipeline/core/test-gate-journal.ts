/**
 * Test-gate crash journal (external audit, finding 1).
 *
 * The test gate in self-enhance-loop.ts must write the candidate to the LIVE
 * file for `bun test` to see it (tests resolve real imports). The old code
 * restored the original on test-failure and on thrown errors — but a hard
 * process crash (native segfault, SIGKILL, OOM) between the candidate write
 * and the restore left the UNVERIFIED-BY-TEST candidate live on disk:
 *
 *   - Turbopack hot-reloads it into the running app.
 *   - Worse: the next `git add -A` from ANY later push (an unrelated
 *     enhancement, a schema mutation, an operator push) silently sweeps
 *     the never-accepted candidate into a commit it was never approved for.
 *
 * This module closes that window with a write-ahead journal, the same
 * pattern databases use:
 *
 *   1. BEFORE the candidate is written, the original content is journaled
 *      to `<root>/.git/info/test-gate-journal.json`. Living inside .git/
 *      means git itself never tracks it (no .gitignore churn, never swept
 *      into `git add -A`) — the same trick as the tier-3 push-target state.
 *   2. On EVERY completion path (test-fail restore, test-pass accept,
 *      thrown-error restore) the journal is cleared.
 *   3. `recoverCrashedTestGate()` — called at test-gate entry, at runCycle
 *      start, and at the top of pushCurrentState's commit path — sees a
 *      leftover journal, restores the original, and reports what it did so
 *      the caller can log it / record a postmortem.
 *
 * Idempotent: if the journal's original already matches what's on disk
 * (crash happened before the candidate write, or after a restore that beat
 * the journal delete), recovery is a no-op that just clears the journal.
 *
 * Pure leaf module: fs + path only. No DB, no LLM, no imports from the
 * pipeline — importable from both self-enhance-loop.ts and push-target.ts
 * without cycles. Sits under core/ so the loop itself can never mutate it
 * (PROTECTED_PREFIXES, audit 3).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { PROJECT_ROOT } from "./paths";

const JOURNAL_DIR = join(PROJECT_ROOT, ".git", "info");
const JOURNAL_PATH = join(JOURNAL_DIR, "test-gate-journal.json");

interface TestGateJournal {
  /** Absolute path of the file whose candidate was about to go live. */
  filePath: string;
  /** The ORIGINAL content, restored on crash recovery. */
  originalCode: string;
  /** ISO timestamp of when the journal was armed. */
  armedAt: string;
}

/** Arm the journal: record the original content BEFORE writing the
 *  candidate. Overwrites any stale journal (a stale journal means the
 *  previous recovery never ran — but recovery is also invoked at
 *  test-gate entry, so this is defense-in-depth, not a leak). */
export function writeTestGateJournal(filePath: string, originalCode: string): void {
  try {
    mkdirSync(JOURNAL_DIR, { recursive: true });
    const entry: TestGateJournal = {
      filePath,
      originalCode,
      armedAt: new Date().toISOString(),
    };
    writeFileSync(JOURNAL_PATH, JSON.stringify(entry), "utf-8");
  } catch {
    // Journaling is best-effort crash insurance. If .git/info is somehow
    // unwritable, the test gate still functions (with the old crash
    // window) — failing the whole enhancement here would be worse.
  }
}

/** Clear the journal. Called on every test-gate completion path. */
export function clearTestGateJournal(): void {
  try {
    rmSync(JOURNAL_PATH, { force: true });
  } catch {
    /* nothing to clear / already gone */
  }
}

export interface CrashRecovery {
  recovered: boolean;
  /** True when a journal existed but the disk already matched the
   *  original (crash between journal-arm and candidate-write, or a
   *  restore that won the race with the journal delete). */
  alreadyIntact: boolean;
  filePath?: string;
  armedAt?: string;
  error?: string;
}

/** If a previous test gate crashed mid-run, restore the original content
 *  and clear the journal. Safe to call at any time — a missing journal is
 *  the common case and returns immediately. Synchronous by design: it runs
 *  on the commit path where a half-restored file must never be committed. */
export function recoverCrashedTestGate(): CrashRecovery {
  if (!existsSync(JOURNAL_PATH)) {
    return { recovered: false, alreadyIntact: false };
  }
  try {
    const raw = readFileSync(JOURNAL_PATH, "utf-8");
    const entry = JSON.parse(raw) as TestGateJournal;
    if (!entry.filePath || typeof entry.originalCode !== "string") {
      // Corrupt journal — nothing restorable. Clear it so it can't wedge
      // every future push behind a permanent "recovery failed" state.
      clearTestGateJournal();
      return { recovered: false, alreadyIntact: false, error: "corrupt journal entry — cleared" };
    }
    let onDisk = "";
    try {
      onDisk = readFileSync(entry.filePath, "utf-8");
    } catch {
      // The file itself is gone (deleted by some other path). Nothing to
      // restore — clear and report.
      clearTestGateJournal();
      return { recovered: false, alreadyIntact: false, filePath: entry.filePath, error: "target file unreadable" };
    }
    if (onDisk === entry.originalCode) {
      // Disk already holds the original — the candidate never landed (or a
      // restore already ran). Just clear the stale journal.
      clearTestGateJournal();
      return { recovered: false, alreadyIntact: true, filePath: entry.filePath, armedAt: entry.armedAt };
    }
    // The candidate (or something else) is live on disk and a journal says
    // the original was supposed to be restorable. Restore + clear.
    writeFileSync(entry.filePath, entry.originalCode, "utf-8");
    clearTestGateJournal();
    return { recovered: true, alreadyIntact: false, filePath: entry.filePath, armedAt: entry.armedAt };
  } catch {
    // Corrupt/unreadable journal (smoke-test case 4: a torn write). Nothing
    // is restorable from it — but it MUST be cleared, or every future
    // recovery (test-gate entry, runCycle start, every pushCurrentState
    // commit) hits this same dead end forever and the crash window it was
    // guarding reopens for lack of a usable journal. Clear + report.
    clearTestGateJournal();
    return { recovered: false, alreadyIntact: false, error: "journal unreadable/corrupt — cleared" };
  }
}
