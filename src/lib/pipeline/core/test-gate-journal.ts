/**
 * Test-gate crash journal — write-ahead insurance from the first fix of
 * external audit finding 1, now DEFENSE-IN-DEPTH for the sandbox era.
 *
 * History: the original test gate wrote the candidate to the LIVE file so
 * `bun test` could import it, and restored the original on test-failure —
 * but a hard process crash (native segfault, SIGKILL, OOM) between the
 * candidate write and the restore left the UNVERIFIED-BY-TEST candidate
 * live on disk: Turbopack hot-reloaded it, and the next `git add -A`
 * silently swept it into an unrelated commit.
 *
 * Fix v1 (this module): a write-ahead journal — the original content is
 * recorded to `<root>/.git/info/test-gate-journal.json` BEFORE the
 * candidate write (living inside .git/ means git itself never tracks it),
 * cleared on every completion path, and `recoverCrashedTestGate()` —
 * called at test-gate entry, runCycle start, and pushCurrentState's commit
 * path — restores the original after a crash. This closed the
 * crash-stranding consequence but NOT the exposure window itself: the
 * candidate was still live during the test run.
 *
 * Fix v2 (current): core/sandbox-test.ts — the test gate now runs
 * candidates inside a disposable sandbox copy of the project and NEVER
 * writes them to the live tree, eliminating the window entirely.
 *
 * This module stays because a journal armed by the v1 implementation can
 * still exist on disk after an upgrade (or after a hot-swap rollback to a
 * v1-era module), and because the recovery entry points double as a guard
 * for any future code path that reintroduces live writes. The recovery
 * callers in self-enhance-loop.ts and push-target.ts remain; only the
 * arming call was removed with the v1 test gate.
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
// Audit 3 (F13): a journal older than this is stale archaeology, not
// crash insurance — recovery clears it WITHOUT restoring (a stale
// "original" could silently revert committed work).
const JOURNAL_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

interface TestGateJournal {
  /** Absolute path of the file whose candidate was about to go live. */
  filePath: string;
  /** The ORIGINAL content, restored on crash recovery. */
  originalCode: string;
  /** ISO timestamp of when the journal was armed. */
  armedAt: string;
}

/** Arm the journal: record the original content BEFORE writing a
 *  candidate to a live file. NOT called by the current test gate — the
 *  sandbox (core/sandbox-test.ts) made live writes unnecessary — but kept
 *  exported for any future verified code path that must write live, and
 *  for tooling/tests of this module. Overwrites any stale journal (a
 *  stale journal means the previous recovery never ran — but recovery is
 *  also invoked at test-gate entry, so this is defense-in-depth). */
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
    // unwritable, the caller's own restore path still functions — failing
    // the whole enhancement here would be worse.
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
    // ── JOURNAL AGE EXPIRY (audit 3, F13) ───────────────────────────
    // A stale journal whose "original" predates a subsequently COMMITTED
    // file state used to overwrite the live file with the old original on
    // the next push — silently reverting verified, committed work. The
    // journal exists to cover a crash WINDOW (seconds); an entry older
    // than JOURNAL_MAX_AGE_MS is archaeology, not crash insurance — clear
    // it without touching the file.
    const armedAtMs = Date.parse(entry.armedAt);
    if (Number.isFinite(armedAtMs) && Date.now() - armedAtMs > JOURNAL_MAX_AGE_MS) {
      clearTestGateJournal();
      return {
        recovered: false,
        alreadyIntact: false,
        filePath: entry.filePath,
        armedAt: entry.armedAt,
        error: `journal expired (armed ${entry.armedAt} > ${JOURNAL_MAX_AGE_MS / 60000}min ago) — cleared WITHOUT restore; disk state may be legitimately newer`,
      };
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
