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
import { join } from "path";
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
  /** The CANDIDATE content that was about to be written. Crash recovery
   *  restores the original ONLY when the disk holds exactly this — if the
   *  disk holds anything else, a later VERIFIED write landed and reverting
   *  would clobber it (adversarial-review fix, 2026-11-17). Optional for
   *  backward compatibility with pre-fix journals; a journal without it is
   *  cleared WITHOUT restoring (fail-safe: never revert what we can't
   *  verify). */
  candidateCode?: string;
  /** ISO timestamp of when the journal was armed. */
  armedAt: string;
}

/** Arm the journal: record the original content BEFORE writing a
 *  candidate to a live file. NOT called by the current test gate — the
 *  sandbox (core/sandbox-test.ts) made live writes unnecessary — but kept
 *  exported for any future verified code path that must write live, and
 *  for tooling/tests of this module. Overwrites any stale journal (a
 *  stale journal means the previous recovery never ran — but recovery is
 *  also invoked at test-gate entry, so this is defense-in-depth).
 *
 *  `candidateCode` is REQUIRED for recovery to ever restore: see the
 *  TestGateJournal interface — recovery only reverts a disk state it can
 *  positively identify as the crashed candidate. */
export function writeTestGateJournal(filePath: string, originalCode: string, candidateCode?: string): void {
  try {
    mkdirSync(JOURNAL_DIR, { recursive: true });
    const entry: TestGateJournal = {
      filePath,
      originalCode,
      candidateCode,
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
    // ── VERIFIED-RESTORE (adversarial review, 2026-11-17) ─────────────
    // The old behavior restored the original whenever disk != original —
    // treating ANY disk change as a crashed candidate. That was a silent
    // clobber window: a VERIFIED later write (a gated, committed mutation,
    // an operator edit, a chat-task apply) landing inside the 1-hour
    // journal window would be REVERTED to the stale original on the next
    // push, silently destroying verified work. Now the restore fires only
    // when the disk can be POSITIVELY identified as the crashed
    // candidate (disk === candidateCode):
    //   disk === candidateCode → crash stranded the unverified candidate
    //     mid-write → restore the original (the journal's whole purpose).
    //   disk === anything else (or the journal predates candidate
    //     tracking) → we cannot verify what happened → DO NOT TOUCH the
    //     file; clear the journal and report. Fail-safe direction: never
    //     revert content we can't vouch for. In the v2 sandbox world
    //     (no live candidate writes at all), disk != original is always a
    //     legitimate later write, so declining is strictly correct.
    if (
      typeof entry.candidateCode === "string" &&
      entry.candidateCode.length > 0 &&
      onDisk === entry.candidateCode
    ) {
      writeFileSync(entry.filePath, entry.originalCode, "utf-8");
      clearTestGateJournal();
      return { recovered: true, alreadyIntact: false, filePath: entry.filePath, armedAt: entry.armedAt };
    }
    // Unknown disk state — a verified write (most likely) or a legacy
    // journal without candidateCode. Clear WITHOUT restoring.
    clearTestGateJournal();
    return {
      recovered: false,
      alreadyIntact: false,
      filePath: entry.filePath,
      armedAt: entry.armedAt,
      error:
        "journal did not match disk state (disk holds a later verified write, or the journal predates candidate tracking) — cleared WITHOUT restore; disk state left untouched",
    };
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
