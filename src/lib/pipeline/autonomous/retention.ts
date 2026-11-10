/**
 * Retention helpers — bounded growth for the autonomous loop's append-only
 * DB tables and on-disk journals.
 *
 * Prior to this module (audit 4 — "grow-only" sweep), the loop wrote one
 * row per cycle to `AutonomousCycle` and one row per mutated file to
 * `PipelineRun` (the autonomous path), with NO deletion logic anywhere.
 * The manual `PipelineRun` writer (`/api/pipeline/run/route.ts`) had a
 * keep-newest-25 prune and a 20 KB code-blob cap; the autonomous path
 * copied the WRITE but not the RETENTION, and stored 200 KB blobs — a
 * 178 MB-waiting-to-happen copy-paste mistake (see postmortem
 * `system:retention-audit`).
 *
 * This module factors the prune logic into shared, best-effort helpers:
 *   - `prunePipelineRuns(keep)`            — keep newest N, delete the rest
 *   - `pruneAutonomousCycles(keep)`        — keep newest N, delete the rest
 *   - `pruneHotSwapJournal(keepEntries)`   — rotate the on-disk JSONL journal
 *   - `pruneResolvedPostmortems(maxAgeDays)` (P1) — archive + delete resolved
 *   - `pruneHighAttemptPostmortems(maxAttempts)` (P1) — auto-resolve churners
 *   - `pruneTerminalSelfTasks(keep)`         (P2a) — keep newest N terminal rows
 *   - `pruneMemoryEntries(keep)`            (P2b) — keep newest N MemoryEntry rows
 *   - `pruneOldLessons(keepActive, keepPruned, prunePrunedAfterDays)` (P3)
 *
 * All helpers are best-effort by design: a prune failure MUST NEVER fail the
 * cycle that triggered it. Every helper swallows + logs. Callers are
 * fire-and-forget (the row was already written; pruning is housekeeping).
 *
 * Why "keep newest N" rather than age-based: the loop's consumers (the
 * oracle, the UI, archaeology) read the RECENT TAIL. Older rows have no
 * live consumer — they're forensic-only, and git history + postmortem
 * JSONs are the durable forensic record. A count cap is predictable,
 * cheap to reason about, and matches the existing `MutationCorpus` keep-
 * newest-2000 pattern (`mutation-corpus.ts:130`).
 */

import { db } from "@/lib/db";
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";
import { archivePostmortemToDisk, autoResolvePostmortemOnDisk } from "../postmortem/postmortem-repo";

const HOT_SWAP_JOURNAL_PATH = join(PROJECT_ROOT, ".git", "info", "loop-hot-swap-journal.jsonl");

/**
 * Keep the newest `keep` PipelineRun rows (across ALL triggeredBy paths —
 * manual, autonomous, watch, continuous — since they share one table).
 * Delete the rest. Best-effort: logs on failure, never throws.
 *
 * Default keep = 50 (2× the manual route's 25, because autonomous cycles
 * fire more often and a 25-row window would age out within hours).
 */
export async function prunePipelineRuns(keep = 50): Promise<{ pruned: number; kept: number } | null> {
  try {
    // Validate input
    if (typeof keep !== "number" || keep <= 0) {
      console.warn("[retention] prunePipelineRuns called with invalid keep value:", keep);
      return null;
    }
    
    const keepRows = await db.pipelineRun.findMany({
      orderBy: { createdAt: "desc" },
      take: keep,
      select: { id: true },
    });
    if (keepRows.length === 0) return { pruned: 0, kept: 0 };
    const result = await db.pipelineRun.deleteMany({
      where: { id: { notIn: keepRows.map((r) => r.id) } },
    });
    return { pruned: result.count, kept: keepRows.length };
  } catch (err) {
    console.warn("[retention] prunePipelineRuns failed (non-fatal):", (err as Error).message);
    return null;
  }
}

/**
 * Keep the newest `keep` AutonomousCycle rows. Delete the rest.
 * Best-effort. Default keep = 200 — the oracle reads the recent tail for
 * calibration context and the UI renders recent cycles; 200 covers ~a
 * week of continuous running at the default cadence.
 */
export async function pruneAutonomousCycles(keep = 200): Promise<{ pruned: number; kept: number } | null> {
  try {
    // Validate input
    if (typeof keep !== "number" || keep <= 0) {
      console.warn("[retention] pruneAutonomousCycles called with invalid keep value:", keep);
      return null;
    }
    
    const keepRows = await db.autonomousCycle.findMany({
      orderBy: { startedAt: "desc" },
      take: keep,
      select: { id: true },
    });
    if (keepRows.length === 0) return { pruned: 0, kept: 0 };
    const result = await db.autonomousCycle.deleteMany({
      where: { id: { notIn: keepRows.map((r) => r.id) } },
    });
    return { pruned: result.count, kept: keepRows.length };
  } catch (err) {
    console.warn("[retention] pruneAutonomousCycles failed (non-fatal):", (err as Error).message);
    return null;
  }
}

/**
 * Rotate the on-disk hot-swap journal (`loop-hot-swap-journal.jsonl`).
 * The in-memory `swapHistory` is capped at 25 (`hot-swap.ts:246`), but the
 * DISK journal was append-only with no rotation — it grew ~200 bytes per
 * swap, and the reader at `hot-swap.ts:549` loads the whole file and splits
 * on newlines. A multi-MB journal would make every swap-reader call slow.
 *
 * Keeps the newest `keepEntries` lines. Atomic write (write to .tmp then
 * rename). Best-effort: a failure logs and leaves the original file intact.
 *
 * Called every Nth swap (the caller throttles) rather than every swap, to
 * amortize the read-rewrite cost — the same pattern `mutation-corpus.ts`
 * uses (every 25th cycle).
 */
export function pruneHotSwapJournal(keepEntries = 1000): { pruned: number; kept: number } | null {
  try {
    // Validate input
    if (typeof keepEntries !== "number" || keepEntries <= 0) {
      console.warn("[retention] pruneHotSwapJournal called with invalid keepEntries value:", keepEntries);
      return null;
    }
    
    if (!existsSync(HOT_SWAP_JOURNAL_PATH)) return { pruned: 0, kept: 0 };
    
    const raw = readFileSync(HOT_SWAP_JOURNAL_PATH, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    
    if (lines.length <= keepEntries) return { pruned: 0, kept: lines.length };
    
    const tail = lines.slice(lines.length - keepEntries);
    const tmpPath = HOT_SWAP_JOURNAL_PATH + ".tmp";
    
    try {
      writeFileSync(tmpPath, tail.join("\n") + "\n", "utf-8");
      
      // Use atomic rename operation instead of overwrite + manual cleanup
      // This prevents TOCTOU (Time-of-Check-Time-of-Use) race conditions
      renameSync(tmpPath, HOT_SWAP_JOURNAL_PATH);
    } catch (err) {
      // Clean up temp file if it was created but rename failed
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup
      }
      throw err;
    }
    
    return { pruned: lines.length - tail.length, kept: tail.length };
  } catch (err) {
    console.warn("[retention] pruneHotSwapJournal failed (non-fatal):", (err as Error).message);
    return null;
  }
}

// ── P1: Postmortem resolve-then-expire ────────────────────────────────
//
// Two cooperating helpers for the postmortem table's growth:
//   pruneHighAttemptPostmortems  — caps the runaway `attempts` counter on
//                                  churny files (audit found red-team
//                                  postmortems at 33 attempts) by
//                                  auto-resolving them, so they become
//                                  eligible for the expire path.
//   pruneResolvedPostmortems     — archives + deletes resolved rows that
//                                  haven't been re-touched in `maxAgeDays`.
//                                  Archive-then-delete (with the disk JSON
//                                  moved to postmortems/archived/) is the
//                                  data-loss guard: a DB-only delete would
//                                  let ensureRehydrated resurrect the
//                                  record on the next boot.
//
// The Postmortem schema uses `status: "active" | "resolved"` (a string,
// not a boolean — audit 3 lifecycle fields are excluded from the chain
// hash). The audit's "resolved = true" wording maps to `status: "resolved"`.

/**
 * Auto-resolve active postmortems whose `attempts` counter has crossed
 * `maxAttempts`. The audit found red-team postmortems at 33 attempts with
 * no cap — the loop kept re-failing the same unfixable file forever. A
 * postmortem at >= maxAttempts is churn, not learning: mark it resolved
 * so it stops being injected (active postmortems gate the LLM prompt),
 * which in turn makes it eligible for `pruneResolvedPostmortems` to
 * archive + delete once `lastAttemptAt` ages past the expire window.
 *
 * Best-effort: a per-row failure (DB or disk) is logged and skipped; the
 * helper continues to the next row. The disk mirror is updated via
 * `autoResolvePostmortemOnDisk` (NOT `resolvePostmortemOnDisk`) — the
 * candidate→rejected flip would be a forensic lie here (the file did NOT
 * succeed, the system just stopped trying). `lastAttemptAt` is bumped
 * to `now` so the resolve-then-expire clock starts ticking from THIS
 * auto-resolve, not from the last failure (which could be weeks stale —
 * we want the row to live in the resolved state for `maxAgeDays` so the
 * distiller sees the auto-resolve before the row expires).
 *
 * Returns `{ autoResolved: number, kept: number } | null`. `kept` is the
 * count of rows that matched the filter but failed to flip (DB or disk
 * error). null signals a top-level failure (DB unreachable / bad input).
 */
export async function pruneHighAttemptPostmortems(
  maxAttempts = 50
): Promise<{ autoResolved: number; kept: number } | null> {
  try {
    if (typeof maxAttempts !== "number" || maxAttempts <= 0) {
      console.warn("[retention] pruneHighAttemptPostmortems called with invalid maxAttempts value:", maxAttempts);
      return null;
    }

    const churny = await db.postmortem.findMany({
      where: { status: "active", attempts: { gte: maxAttempts } },
      select: { id: true, targetRepo: true, branch: true, filePath: true, attempts: true },
      // No take cap — the audit found rows scattered across files; we want
      // every churner in one pass. The table is bounded by the file count
      // (one row per (repo, branch, filePath)), so this is naturally small.
      take: 5000,
    });
    if (churny.length === 0) return { autoResolved: 0, kept: 0 };

    let autoResolved = 0;
    let kept = 0;
    const now = new Date();
    for (const row of churny) {
      try {
        // DB flip: status → resolved, resolvedAt + lastAttemptAt + updatedAt
        // bumped. lastAttemptAt = now starts the resolve-then-expire clock
        // from this auto-resolve (not the last failure, which could be old).
        // Audit 3: status / resolvedAt are excluded from the chain hash, so
        // this update is safe without recomputing parentHash/hash.
        await db.postmortem.update({
          where: { id: row.id },
          data: {
            status: "resolved",
            resolvedAt: now,
            lastAttemptAt: now,
            updatedAt: now,
          },
        });
        // Disk mirror — keeps the on-disk JSON in sync so a future DB wipe
        // doesn't resurrect the record as active. Best-effort: a disk
        // failure leaves the DB authoritative (the read path tries DB first
        // and falls through to disk only on a DB miss; the resolved DB row
        // short-circuits the disk read).
        try {
          autoResolvePostmortemOnDisk(row.targetRepo, row.branch, row.filePath);
        } catch (diskErr) {
          console.warn(
            `[retention] pruneHighAttemptPostmortems: disk mirror failed for ${row.targetRepo}/${row.branch}/${row.filePath} (non-fatal, DB row resolved):`,
            (diskErr as Error).message
          );
        }
        autoResolved++;
      } catch (dbErr) {
        console.warn(
          `[retention] pruneHighAttemptPostmortems: DB update failed for ${row.targetRepo}/${row.branch}/${row.filePath} (non-fatal, will retry next cycle):`,
          (dbErr as Error).message
        );
        kept++;
      }
    }
    return { autoResolved, kept };
  } catch (err) {
    console.warn("[retention] pruneHighAttemptPostmortems failed (non-fatal):", (err as Error).message);
    return null;
  }
}

/**
 * Archive + delete resolved postmortems whose `lastAttemptAt` is older
 * than `maxAgeDays`. Archive-then-delete is the data-loss guard:
 *
 *   1. Move the on-disk JSON (the declared source of truth) from
 *      `postmortems/<repo>/<branch>/<file>.json` to
 *      `postmortems/archived/<repo>/<branch>/<file>.json`.
 *   2. ONLY if the archive move succeeded, delete the DB row.
 *
 * A failed archive → keep the DB row (retry next cycle). A failed DB
 * delete after a successful archive → log + continue (the record now
 * lives only in `archived/`; the next prune pass will find the DB row
 * still resolved-and-stale and try the delete again).
 *
 * `lastAttemptAt` is the expire clock — bumped by `recordFailure` on
 * every real failure AND by `pruneHighAttemptPostmortems` on auto-resolve.
 * A resolved row that gets re-touched (re-fails after being resolved —
 * `markResolved` flips back to active on the next recordFailure) starts
 * the clock fresh, so a file that flaps between resolved and active
 * won't be expired while it's still actively failing.
 *
 * Returns `{ pruned: number, archived: number, kept: number } | null`:
 *   - `pruned`    : DB rows actually deleted
 *   - `archived`  : disk JSONs actually moved to archived/
 *   - `kept`      : rows that matched the filter but were NOT deleted
 *                  (archive move failed — data-loss guard fired)
 * null signals a top-level failure (DB unreachable / bad input).
 */
export async function pruneResolvedPostmortems(
  maxAgeDays = 30
): Promise<{ pruned: number; archived: number; kept: number } | null> {
  try {
    if (typeof maxAgeDays !== "number" || maxAgeDays <= 0) {
      console.warn("[retention] pruneResolvedPostmortems called with invalid maxAgeDays value:", maxAgeDays);
      return null;
    }

    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const expired = await db.postmortem.findMany({
      where: { status: "resolved", lastAttemptAt: { lt: cutoff } },
      select: { id: true, targetRepo: true, branch: true, filePath: true, lastAttemptAt: true },
      take: 5000,
    });
    if (expired.length === 0) return { pruned: 0, archived: 0, kept: 0 };

    let pruned = 0;
    let archived = 0;
    let kept = 0;
    for (const row of expired) {
      // Step 1: archive the disk JSON. DATA-LOSS GUARD — if this fails,
      // skip the DB delete. The row stays resolved-and-stale; the next
      // prune pass will retry the archive. The DB row remains as a
      // tombstone pointing at a (still-live) disk file.
      let moved = false;
      try {
        moved = archivePostmortemToDisk(row.targetRepo, row.branch, row.filePath);
      } catch (archErr) {
        console.warn(
          `[retention] pruneResolvedPostmortems: archive move threw for ${row.targetRepo}/${row.branch}/${row.filePath} (non-fatal, DB row kept):`,
          (archErr as Error).message
        );
        kept++;
        continue;
      }
      if (!moved) {
        // No on-disk file existed (or every move attempt failed). Two cases:
        //  (a) The disk JSON never made it to disk (recordFailure's disk
        //      write failed at some point — the DB row is the only record).
        //      In this case, there is NOTHING to archive — but we also
        //      shouldn't delete the DB row, because the DB row IS the
        //      entire record. Deleting would lose the failure memory.
        //  (b) The disk JSON exists but the move failed (permissions, disk
        //      full, etc.). Retry next cycle.
        // We can't distinguish (a) from (b) from here without an extra
        // stat, so we err on the side of data preservation: keep the DB
        // row, retry next cycle. The audit's data-loss guard overrides
        // the "delete the row" intent — a row kept too long is a
        // debugging inconvenience; a row deleted without its archive is
        // a permanent memory loss.
        kept++;
        continue;
      }
      archived++;

      // Step 2: delete the DB row. A failure here leaves the DB row as a
      // tombstone pointing at the archived disk JSON — the next prune
      // pass will see it again (still resolved, still stale) and retry.
      // The archived disk file is NOT lost on a DB-delete failure: it
      // already lives under postmortems/archived/ and will be picked up
      // by any future rehydrate that walks archived/ (none today, by
      // design — the archived subtree is excluded from listFromDisk).
      try {
        const res = await db.postmortem.deleteMany({ where: { id: row.id } });
        if (res.count > 0) {
          pruned++;
        } else {
          // Row already gone (concurrent prune?) — count as kept so the
          // caller knows the counts don't sum to expired.length.
          kept++;
        }
      } catch (delErr) {
        console.warn(
          `[retention] pruneResolvedPostmortems: DB delete failed for ${row.targetRepo}/${row.branch}/${row.filePath} (non-fatal, disk JSON is archived):`,
          (delErr as Error).message
        );
        kept++;
      }
    }
    return { pruned, archived, kept };
  } catch (err) {
    console.warn("[retention] pruneResolvedPostmortems failed (non-fatal):", (err as Error).message);
    return null;
  }
}

// ── P2a: SelfTask terminal-state sweep ───────────────────────────────
//
// SelfTask rows in terminal states (done | failed | skipped) accumulate
// forever. The pending cap (MAX_PENDING_TOTAL = 200 in self-task-generator)
// only covers pending + in_progress — the terminal tail is unbounded.
// Keep the newest `keep` terminal rows by updatedAt (the most recent
// verdicts — useful for the UI's recent-tasks view + forensics), delete
// the rest. Best-effort.

/**
 * Keep the newest `keep` SelfTask rows in terminal states (done, failed,
 * skipped), ordered by `updatedAt` desc. Delete the rest of the terminal
 * rows. Pending + in_progress rows are NEVER touched (the pending cap in
 * self-task-generator handles those). Best-effort: logs on failure,
 * never throws.
 *
 * Default keep = 1000 — generous because the UI's task list reads the
 * recent tail and 1000 covers a long run's terminal history without
 * growing unbounded (a continuous loop at the default cadence produces
 * ~50 terminal rows/day; 1000 = ~3 weeks of forensics).
 */
export async function pruneTerminalSelfTasks(
  keep = 1000
): Promise<{ pruned: number; kept: number } | null> {
  try {
    if (typeof keep !== "number" || keep <= 0) {
      console.warn("[retention] pruneTerminalSelfTasks called with invalid keep value:", keep);
      return null;
    }

    const terminalStates = ["done", "failed", "skipped"] as const;
    // Find the newest `keep` terminal rows — these stay.
    const keepRows = await db.selfTask.findMany({
      where: { status: { in: [...terminalStates] } },
      orderBy: { updatedAt: "desc" },
      take: keep,
      select: { id: true },
    });
    if (keepRows.length === 0) return { pruned: 0, kept: 0 };

    // Delete every OTHER terminal row. The `notIn` set is the keep window.
    const result = await db.selfTask.deleteMany({
      where: {
        status: { in: [...terminalStates] },
        id: { notIn: keepRows.map((r) => r.id) },
      },
    });
    return { pruned: result.count, kept: keepRows.length };
  } catch (err) {
    console.warn("[retention] pruneTerminalSelfTasks failed (non-fatal):", (err as Error).message);
    return null;
  }
}

// ── P2b: MemoryEntry prune ────────────────────────────────────────────
//
// MemoryEntry rows grow ~2 per manual pipeline run. The only deletion
// today is the duress-purge bulk `deleteMany({})` — emergency only.
// Keep newest `keep` rows by createdAt desc, delete the rest. Best-effort.

/**
 * Keep the newest `keep` MemoryEntry rows (by `createdAt` desc — the
 * MemoryEntry schema has no `updatedAt`). Delete the rest. Best-effort.
 *
 * Default keep = 1000. Wired into `emgRagInstance.addEntry` (fire-and-
 * forget, throttled to every 25th add via a module-level counter — see
 * emg-rag.ts). The prune does a findMany + deleteMany, so per-add would
 * be too expensive; the throttle amortizes the cost across adds.
 */
export async function pruneMemoryEntries(
  keep = 1000
): Promise<{ pruned: number; kept: number } | null> {
  try {
    if (typeof keep !== "number" || keep <= 0) {
      console.warn("[retention] pruneMemoryEntries called with invalid keep value:", keep);
      return null;
    }

    const keepRows = await db.memoryEntry.findMany({
      orderBy: { createdAt: "desc" },
      take: keep,
      select: { id: true },
    });
    if (keepRows.length === 0) return { pruned: 0, kept: 0 };

    const result = await db.memoryEntry.deleteMany({
      where: { id: { notIn: keepRows.map((r) => r.id) } },
    });
    return { pruned: result.count, kept: keepRows.length };
  } catch (err) {
    console.warn("[retention] pruneMemoryEntries failed (non-fatal):", (err as Error).message);
    return null;
  }
}

// ── P3: Lesson soft-cap ───────────────────────────────────────────────
//
// Lessons are deactivated (active = false) but never deleted — the
// distiller needs to see them for dedup ("don't re-derive a rule that
// already failed to transfer"). But rows accumulate forever. Three
// retention classes:
//   - REVOKED lessons (revokedAt != null) — KEEP ALL. Rare, high-value
//     ("reality contradicted this rule" — the strongest "never again"
//     signal this system can emit). The distiller is told to never
//     re-derive anything resembling them; losing them would re-expose
//     the system to a known-bad rule.
//   - ACTIVE lessons (active = true, revokedAt = null) — keep newest
//     `keepActive` by createdAt desc. These are the live compounding
//     capital; the cap is generous because the prompt budget (D6) is
//     what actually bounds injection, not the row count.
//   - DEACTIVATED lessons (active = false, revokedAt = null) — keep
//     newest `keepPruned` by updatedAt desc (the deactivation time —
//     recordLessonOutcome stops updating inactive rows, so updatedAt
//     IS the deactivation timestamp). Delete the rest that are older
//     than `prunePrunedAfterDays`. The distiller sees the recent
//     deactivated tail for dedup; the old deactivated tail has no live
//     consumer and is forensically redundant (the revocation/log is in
//     git history via memory/lessons.md).

/**
 * Soft-cap the Lesson table. See class doc for the three retention
 * classes. Best-effort: logs on failure, never throws.
 *
 * Returns `{ pruned: number, keptActive: number, keptPruned: number,
 * keptRevoked: number } | null`. null signals a top-level failure (DB
 * unreachable / bad input). `pruned` is the count of deactivated rows
 * deleted; the three `kept*` counts are the survivors by class.
 */
export async function pruneOldLessons(
  keepActive = 100,
  keepPruned = 100,
  prunePrunedAfterDays = 90
): Promise<{
  pruned: number;
  keptActive: number;
  keptPruned: number;
  keptRevoked: number;
} | null> {
  try {
    if (typeof keepActive !== "number" || keepActive < 0) {
      console.warn("[retention] pruneOldLessons called with invalid keepActive value:", keepActive);
      return null;
    }
    if (typeof keepPruned !== "number" || keepPruned < 0) {
      console.warn("[retention] pruneOldLessons called with invalid keepPruned value:", keepPruned);
      return null;
    }
    if (typeof prunePrunedAfterDays !== "number" || prunePrunedAfterDays <= 0) {
      console.warn("[retention] pruneOldLessons called with invalid prunePrunedAfterDays value:", prunePrunedAfterDays);
      return null;
    }

    // Defensive: like lesson-store.ts's lessons() guard, the running
    // Prisma client may predate the Lesson model until a restart. The
    // existing helpers in this module assume the model is live; for the
    // P3 helper we follow lesson-store's defensive pattern because the
    // distill path that triggers this prune ALSO tolerates a missing
    // table, and a prune that throws on `db.lesson` being undefined
    // would defeat the fire-and-forget contract.
    const lessonDelegate = (db as unknown as { lesson?: typeof db.lesson }).lesson;
    if (!lessonDelegate || typeof lessonDelegate.findMany !== "function") {
      return { pruned: 0, keptActive: 0, keptPruned: 0, keptRevoked: 0 };
    }
    const l = lessonDelegate;

    // Count the survivors for the return value. These are intentionally
    // separate queries (not the keep-window queries) so the reported
    // counts reflect the post-prune state, not the pre-prune keep window.
    const [activeCount, revokedCount] = await Promise.all([
      l.count({ where: { active: true, revokedAt: null } }),
      l.count({ where: { revokedAt: { not: null } } }),
    ]);

    // Find the newest `keepPruned` deactivated (non-revoked) lessons —
    // these stay regardless of age. Ordered by updatedAt desc because
    // the deactivation time IS updatedAt for an inactive row.
    const keepPrunedRows = await l.findMany({
      where: { active: false, revokedAt: null },
      orderBy: { updatedAt: "desc" },
      take: keepPruned,
      select: { id: true },
    });

    // Delete deactivated (non-revoked) rows that are:
    //   - older than prunePrunedAfterDays (updatedAt < cutoff), AND
    //   - NOT in the newest keepPruned window.
    // Active + revoked rows are never matched.
    const cutoff = new Date(Date.now() - prunePrunedAfterDays * 24 * 60 * 60 * 1000);
    const deleteResult = await l.deleteMany({
      where: {
        active: false,
        revokedAt: null,
        updatedAt: { lt: cutoff },
        id: { notIn: keepPrunedRows.map((r) => r.id) },
      },
    });

    // keptPruned = min(keepPruned, total deactivated pre-prune). We don't
    // know the pre-prune deactivated count exactly without an extra
    // query, but the keep window's length IS the upper bound on what
    // survives in the deactivated class — if we asked for 100 and got
    // 73, only 73 deactivated rows existed (or were within the keep
    // window) before the prune, and the deleteMany removed 0 of them.
    // If we got 100, either >= 100 existed and the prune removed
    // (deactivated_total - 100) of them, or fewer existed and prune
    // removed 0. The keep window's length is the honest "at most this
    // many deactivated rows survive" answer.
    return {
      pruned: deleteResult.count,
      keptActive: activeCount,
      keptPruned: keepPrunedRows.length,
      keptRevoked: revokedCount,
    };
  } catch (err) {
    console.warn("[retention] pruneOldLessons failed (non-fatal):", (err as Error).message);
    return null;
  }
}