/**
 * git-log.ts — shared git-log helper for per-file provenance.
 *
 * Extracted from /api/provenance/route.ts so both the operator-facing
 * provenance route AND the loop's provenance-digest builder share ONE
 * implementation. Pure leaf: child_process.spawn + path only. No DB, no
 * circulars. Fail-soft: returns [] on any error (git not available, file
 * not tracked, spawn failure) — the caller's prompt proceeds without
 * the provenance block rather than crashing the cycle.
 *
 * The loop calls gitLogForFile once per file per cycle (before the LLM
 * call). The cost is ~50ms for a file with ~15 commits — dominated by
 * the git spawn, not the parse. Capped by `take` (default 0 = all).
 */

import { spawn } from "child_process";

export interface GitLogEntry {
  /** Short SHA (7 chars from %h). */
  sha: string;
  /** Author name (%an). */
  author: string;
  /** ISO date (%ad, e.g. "2026-11-03 10:29:03 +0000"). */
  at: string;
  /** Commit subject (%s, first line only). */
  message: string;
}

/** Classify a git commit message into an actor.
 *  - "loop"     = "Self-enhancement: <file>" (the autonomous loop's own commits)
 *  - "operator" = everything else (manual pushes, audits, original authoring)
 *  Shared by the provenance route (operator-facing) and the digest builder
 *  (loop-facing) so both surfaces agree on who did what. */
export function classifyCommitActor(message: string): "loop" | "operator" {
  if (message.startsWith("Self-enhancement:")) return "loop";
  return "operator";
}

/** Run `git log --follow` for a path and parse the %h|%an|%ad|%s lines.
 *  Returns [] on any error (git not available, file not tracked, etc.)
 *  — the rest of the caller's flow still proceeds.
 *
 *  `take` (default 0 = no limit) caps the number of commits returned
 *  (newest-first). The loop's digest builder passes take=5 (recent
 *  history is most relevant); the operator-facing route passes 0 (full
 *  timeline for the `provenance` command).
 *
 *  `repoPath` is the cwd for the git command (typically PROJECT_ROOT). */
export function gitLogForFile(
  repoPath: string,
  filePath: string,
  take = 0,
): Promise<GitLogEntry[]> {
  return new Promise((resolve) => {
    const args = [
      "log",
      "--follow",
      `--pretty=format:%h|%an|%ad|%s`,
      "--date=iso",
      ...(take > 0 ? [`-n`, String(take)] : []),
      "--",
      filePath,
    ];
    const git = spawn("git", args, { cwd: repoPath });
    let out = "";
    let err = "";
    git.stdout.on("data", (d) => (out += d.toString()));
    git.stderr.on("data", (d) => (err += d.toString()));
    git.on("error", () => resolve([]));
    git.on("close", () => {
      if (!out.trim()) return resolve([]);
      resolve(
        out
          .trim()
          .split("\n")
          .map((line) => {
            const i1 = line.indexOf("|");
            const i2 = line.indexOf("|", i1 + 1);
            const i3 = line.indexOf("|", i2 + 1);
            if (i1 < 0 || i2 < 0 || i3 < 0) return null;
            return {
              sha: line.slice(0, i1),
              author: line.slice(i1 + 1, i2),
              at: line.slice(i2 + 1, i3),
              message: line.slice(i3 + 1),
            };
          })
          .filter((v): v is GitLogEntry => v !== null),
      );
    });
  });
}
