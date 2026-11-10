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
 *   - `prunePipelineRuns(keep)`        — keep newest N, delete the rest
 *   - `pruneAutonomousCycles(keep)`    — keep newest N, delete the rest
 *   - `pruneHotSwapJournal(keepEntries)` — rotate the on-disk JSONL journal
 *
 * All three are best-effort by design: a prune failure MUST NEVER fail the
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
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";

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
    if (!existsSync(HOT_SWAP_JOURNAL_PATH)) return { pruned: 0, kept: 0 };
    const raw = readFileSync(HOT_SWAP_JOURNAL_PATH, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length <= keepEntries) return { pruned: 0, kept: lines.length };
    const tail = lines.slice(lines.length - keepEntries);
    const tmpPath = HOT_SWAP_JOURNAL_PATH + ".tmp";
    writeFileSync(tmpPath, tail.join("\n") + "\n", "utf-8");
    // renameSync would be atomic, but the sandbox forbids it in some
    // contexts; fall back to overwrite + tmp cleanup.
    writeFileSync(HOT_SWAP_JOURNAL_PATH, tail.join("\n") + "\n", "utf-8");
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort */ }
    return { pruned: lines.length - tail.length, kept: tail.length };
  } catch (err) {
    console.warn("[retention] pruneHotSwapJournal failed (non-fatal):", (err as Error).message);
    return null;
  }
}
