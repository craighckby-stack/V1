/**
 * Atomic file write — tmp + rename.
 *
 * A bare writeFileSync leaves a TORN file visible to concurrent readers
 * (and to git's `add -A`) if the process dies mid-write: the config JSONs
 * under .git/info/ are read on every boot and a half-written armed-state
 * file would read as corrupt (fail-safe, but silently disarms). rename(2)
 * is atomic on POSIX — a reader either sees the complete old file or the
 * complete new one, never a partial.
 *
 * The tmp file lives in the SAME directory as the target (same filesystem)
 * so the rename is a metadata operation, not a copy. The tmp name includes
 * the pid so two processes writing the same target never clobber each
 * other's tmp file.
 */
import { writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";

/** Write `data` to `filePath` atomically: write to `<path>.tmp.<pid>` in
 *  the same directory, then rename over the target. Creates parent
 *  directories (same contract the previous inline mkdirSync calls had). */
export function atomicWriteFileSync(filePath: string, data: string, mode?: number): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, data, mode !== undefined ? { encoding: "utf-8", mode } : "utf-8");
  renameSync(tmp, filePath);
}
