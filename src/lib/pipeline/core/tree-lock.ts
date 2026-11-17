/**
 * Tree lock — mutual exclusion for live-tree writers (audit 3, F10).
 *
 * Two independent subsystems write the live source tree:
 *   1. the self-enhance loop (enhanceFile: gated candidate → live write →
 *      commit → push)
 *   2. chat-task's applyTaskPlan (operator-approved plan → write → tsc →
 *      rollback-or-commit)
 *
 * They used to race: a chat-task rollback could silently revert a fully
 * gated, already-pushed enhancement, and the loop's `git add -A` could
 * sweep a half-applied multi-file plan into an unrelated commit. Both
 * critical sections now hold this lock for their write→commit span.
 *
 * ── CROSS-PROCESS UPGRADE (2026-11-17) ──────────────────────────────
 * The worker split moved the loop into a dedicated Bun process
 * (mini-services/loop-worker, :3004) while chat-task / merge-back /
 * schema-gate / manual-push run inside the Next.js server (:3000). The
 * original module-level `busy` flag only serialized writers WITHIN one
 * process — the two processes could hold "the lock" simultaneously, and
 * only enhanceFile's own TOCTOU SHA re-read caught the collision (and
 * only on the loop side). The lock is now backed by a lock FILE
 * (.git/info/loop-tree.lock) so the mutual exclusion holds across
 * processes:
 *
 *   - Acquire: exclusive-create (flag: "wx") with a JSON owner record
 *     {token, pid, holder, acquiredAt}. EEXIST → someone holds it.
 *   - Stale-lock breaking: the primary crash signal is holder-PID
 *     LIVENESS (`process.kill(pid, 0)` — ESRCH means the holder died,
 *     EPERM means it exists under another uid). A crashed holder's lock
 *     is broken immediately by the next waiter; no human intervention.
 *     A 15-minute age bound is the secondary signal (covers pid-reuse
 *     false-positives). A corrupt/empty lock file (crash between create
 *     and write) is broken on sight.
 *   - Release: read-verify-owner (token + pid must match OURS) before
 *     unlinking — a waiter that broke a stale lock can never delete a
 *     fresh lock another process legitimately created in the meantime.
 *   - In-process FIFO waiter queue preserved (the pre-upgrade semantics):
 *     same-process callers queue fairly instead of polling against each
 *     other; cross-process contention polls at 150ms.
 *   - Wait timeout: 10 minutes, then a clear error. The longest
 *     legitimate critical section is chat-task's whole plan
 *     (LLM + gates + tsc × up to 5 files) and merge-back's tsc gate
 *     (~3.5 min) — 10 min covers both with headroom. Callers already
 *     treat a thrown lock error as a failed/deferred attempt.
 *
 * NESTING IS FORBIDDEN: a nested withTreeLock call from inside a held
 * critical section would self-deadlock (the waiter queue waits for
 * `busy = false`, which only the outer fn's finally can set). All
 * current call sites are top-level entry points — verified 2026-11-17.
 * If a nested need ever appears, thread the outer token through.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { PROJECT_ROOT } from "./paths";

const LOCK_DIR = join(PROJECT_ROOT, ".git", "info");
const LOCK_PATH = join(LOCK_DIR, "loop-tree.lock");

/** Poll interval while another process holds the lock. */
const LOCK_POLL_MS = 150;
/** Give up waiting after this long — throw so the caller records a
 *  failed/deferred attempt instead of hanging its cycle forever. */
const LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
/** Hard staleness bound. The PRIMARY stale signal is holder-pid death
 *  (checked every poll — instant recovery after a crash); this age cap
 *  only covers the pid-reuse edge case where a dead holder's pid was
 *  recycled by an unrelated process. Longest legit hold ≈ 5 min
 *  (chat-task whole plan), so 15 min never breaks a live holder. */
const LOCK_STALE_MS = 15 * 60 * 1000;

interface LockFileContent {
  /** Random per-acquire token — release verifies ownership by it. */
  token: string;
  /** Holder process pid — liveness-checked by waiters. */
  pid: number;
  /** Human-readable holder name for timeout error messages. */
  holder: string;
  /** Epoch ms when the lock was acquired. */
  acquiredAt: number;
}

function holderName(): string {
  // The worker sets LOOP_WORKER=1 (see mini-services/loop-worker/index.ts).
  return process.env.LOOP_WORKER === "1" ? "loop-worker" : "next-server";
}

/** True if the pid is running (EPERM = exists under another uid = alive). */
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockFile(): LockFileContent | null {
  try {
    const raw = readFileSync(LOCK_PATH, "utf-8");
    const parsed = JSON.parse(raw) as LockFileContent;
    if (!parsed || typeof parsed.token !== "string" || typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null; // missing, empty (crash between create+write), or corrupt
  }
}

/** Break the lock ONLY if it is provably stale: holder pid dead, or
 *  older than LOCK_STALE_MS, or unreadable/corrupt. Returns true when a
 *  break happened (the caller may retry the acquire immediately). */
function breakStaleLock(): boolean {
  const content = readLockFile();
  if (!content) {
    // Missing → nothing to break (acquire will just succeed). Empty/
    // corrupt (crash between create and write, or torn pre-atomic write)
    // → break so the lock doesn't wedge every future writer.
    try {
      rmSync(LOCK_PATH, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  const dead = !pidAlive(content.pid);
  const ancient = Date.now() - content.acquiredAt > LOCK_STALE_MS;
  if (dead || ancient) {
    try {
      rmSync(LOCK_PATH, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Try to create the lock file exclusively. Returns the owner token on
 *  success, null when another (live, fresh) holder owns it. */
function tryAcquireFileLock(): string | null {
  try {
    mkdirSync(LOCK_DIR, { recursive: true });
  } catch {
    /* .git/info exists in practice; the wx write below will surface a
       real failure if the directory truly can't be created */
  }
  const token = randomUUID();
  const content: LockFileContent = {
    token,
    pid: process.pid,
    holder: holderName(),
    acquiredAt: Date.now(),
  };
  try {
    // "wx" = exclusive create — atomic; EEXIST when held. Lock file under
    // .git/info (survives sandbox restarts, never tracked by git).
    writeFileSync(LOCK_PATH, JSON.stringify(content), { flag: "wx", mode: 0o600 });
    return token;
  } catch {
    return null;
  }
}

/** Release ONLY if we still own it (token + pid match). If a waiter broke
 *  our stale lock and another process acquired a fresh one, our unlink
 *  must not delete THEIR lock — the ownership check makes that impossible. */
function releaseFileLock(token: string): void {
  try {
    const content = readLockFile();
    if (content && content.token === token && content.pid === process.pid) {
      rmSync(LOCK_PATH, { force: true });
    }
  } catch {
    /* best-effort — a leftover lock is broken by the pid-liveness check
       on the next acquire attempt after this process exits */
  }
}

let busy = false;
const waiters: Array<() => void> = [];

/** True while a live-tree critical section is in flight in THIS process
 *  (diagnostics — cross-process state lives in the lock file). */
export function isTreeLocked(): boolean {
  return busy;
}

/** Diagnostics for the status API: who holds the cross-process lock, if
 *  anyone. Pure file read — safe to call from any route. */
export function treeLockInfo(): {
  held: boolean;
  holder?: string;
  pid?: number;
  heldForMs?: number;
  mine: boolean;
} {
  const content = readLockFile();
  if (!content) return { held: false, mine: false };
  return {
    held: true,
    holder: content.holder,
    pid: content.pid,
    heldForMs: Date.now() - content.acquiredAt,
    mine: content.pid === process.pid,
  };
}

/**
 * Run `fn` while holding the tree lock — now across processes. Same-process
 * concurrent callers queue in FIFO order; other-process holders are polled
 * (with stale-lock breaking for crashed holders). The lock is released even
 * if `fn` throws. Throws (with a diagnostic message naming the holder) if
 * the lock cannot be acquired within LOCK_WAIT_TIMEOUT_MS.
 */
export async function withTreeLock<T>(fn: () => Promise<T> | T): Promise<T> {
  // ── In-process FIFO (pre-upgrade semantics, preserved) ──────────────
  while (busy) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  busy = true;
  let fileToken: string | null = null;
  try {
    // ── Cross-process acquire (poll + stale-break) ────────────────────
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    for (;;) {
      fileToken = tryAcquireFileLock();
      if (fileToken) break;
      // Held elsewhere. Break it if the holder provably died or the lock
      // went ancient — then retry immediately; otherwise wait a poll.
      if (breakStaleLock()) continue;
      if (Date.now() > deadline) {
        const holder = readLockFile();
        throw new Error(
          `tree lock busy: ${holder?.holder ?? "unknown"} (pid ${holder?.pid ?? "?"}) has held the ` +
          `cross-process tree lock past the ${Math.round(LOCK_WAIT_TIMEOUT_MS / 60000)}min wait limit — ` +
          `if that process is wedged, restart it; a crashed holder's lock self-clears`
        );
      }
      await new Promise<void>((r) => setTimeout(r, LOCK_POLL_MS));
    }
    return await fn();
  } finally {
    if (fileToken) releaseFileLock(fileToken);
    busy = false;
    const next = waiters.shift();
    if (next) next();
  }
}
