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
 * Module-level state is fine here: the lock only needs to serialize
 * writers within one process/module instance (the hot-swap path pauses
 * both writers via pauseLoop() before swapping, and a fresh module
 * instance starts with a free lock).
 */

let busy = false;
const waiters: Array<() => void> = [];

/** True while a live-tree critical section is in flight (diagnostics). */
export function isTreeLocked(): boolean {
  return busy;
}

/**
 * Run `fn` while holding the tree lock. Concurrent callers queue in FIFO
 * order. The lock is released even if `fn` throws.
 */
export async function withTreeLock<T>(fn: () => Promise<T> | T): Promise<T> {
  while (busy) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
    const next = waiters.shift();
    if (next) next();
  }
}
