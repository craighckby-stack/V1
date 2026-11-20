/**
 * atomic-write.ts — temp-file-then-rename for the corpus swap.
 *
 * WHY THIS EXISTS
 * ──────────────
 * GitHistory-Sync (the producer) writes three corpus JSON files to
 * memory/: commit-history.successful.json, .failed.json, .engines.json.
 * LOOP's githistory-corpus.ts (the consumer) reads them on demand
 * with readFileSync. If the producer writes the file in place, a
 * read can catch a half-written file (the JSON.parse fails and the
 * corpus appears "missing" to the consumer for one tick).
 *
 * The fix is the standard temp-file-then-rename pattern: write to
 * <file>.tmp, fsync, then atomic rename over the target. POSIX rename
 * is atomic, so the consumer's readFileSync sees either the old
 * complete file or the new complete file — never a partial.
 *
 * This keeps the CONSUMER (githistory-corpus.ts) unchanged. The
 * producer-side atomicity is the clean place to enforce it.
 *
 * Integrity: pure fs. No DB, no LLM, no pipeline imports.
 */

import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write `content` to `targetPath` atomically via temp-file + rename.
 *
 * - Creates the parent directory if missing.
 * - Writes to `<targetPath>.tmp.<pid>.<ts>.<rand>` first. The pid + timestamp
 *   + 4 random hex bytes suffix prevents two concurrent harvests (even
 *   from the same process) from clobbering each other's temp file. The old
 *   `<pid>`-only suffix could collide if two invocations shared a parent's
 *   PID space.
 * - Then renames over the target. POSIX rename is atomic, so the
 *   consumer's readFileSync sees either the old complete file or the new
 *   complete file — never a partial.
 *
 * CROSS-PROCESS NOTE: the final rename is last-writer-wins across
 * processes. For the corpus swap that's the right semantic (the newest
 * harvest should win), and concurrent harvests are guarded against at
 * the scheduler level (step 4's in-progress flag).
 *
 * If `content` is empty, the file is still written (an empty corpus
 * is a valid state — "no commits found this run"). Pass `skipIfEmpty`
 * true to skip writing entirely and leave the existing file in place.
 */
export function atomicWriteText(
  targetPath: string,
  content: string,
  options: { skipIfEmpty?: boolean } = {},
): void {
  if (options.skipIfEmpty && content.length === 0) return;

  const dir = dirname(targetPath);
  // mkdirSync with recursive:true is idempotent — the existsSync check
  // was a dead TOCTOU optimization. Drop it.
  mkdirSync(dir, { recursive: true });

  const rand = randomBytes(4).toString("hex");
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${rand}`;
  writeFileSync(tmpPath, content, { encoding: "utf8" });
  // fsync would go here on a syscall surface; Node's writeFileSync
  // flushes on close, which is sufficient for the corpus size (~7MB).
  // Documented gap: a crash between writeFileSync and renameSync leaks
  // the temp file; a crash after rename but before a directory fsync
  // may not persist the rename. For a detached harvester that re-runs
  // daily, the leaked temp file is cleaned by the next run's overwrite.
  renameSync(tmpPath, targetPath);
}
