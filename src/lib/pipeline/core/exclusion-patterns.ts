/**
 * Shared exclusion patterns for scan + AST-diff + commit-archaeology
 * (concept: Commit-puller repo's LOCKFILE_AND_GENERATED_PATTERNS +
 * LEDGER_OR_META_PATTERNS).
 *
 * Two kinds of files are excluded from "real source" analysis:
 *
 *   1. LOCKFILE / GENERATED — package-lock.json, yarn.lock, *.lock,
 *      protobuf-generated (_pb2.py, *.pb.go, *.pb.cc), etc. These
 *      change on every dependency bump or proto regen; counting them
 *      as "source the loop can refactor" wastes LLM calls and pollutes
 *      commit-archaeology (a commit that ONLY bumps a lockfile is not a
 *      "wrong" or "correct" source change).
 *
 *   2. LEDGER / META — the engine's own outputs (CORRECT.md, WRONG.md,
 *      postmortems/*.json, metadata.json, README, CHANGELOG, RAW_GIT_LOG,
 *      SUMMARY). Counting these as "source" causes CIRCULAR tracking
 *      pollution: the engine re-analyzes its own outputs and labels
 *      its own ledger updates as commits.
 *
 * Centralized here so scan (loop-runtime's file selection), AST-diff
 * (symbol-retention skip list), and commit-archaeology (wrong/correct
 * pairing) all use the SAME definitions. Adding a pattern here excludes
 * it everywhere at once — no more drift between the three lists.
 */

/** Lockfiles + machine-generated source. Mutating these is a build
 *  artifact, not a human-authored change. */
export const LOCKFILE_AND_GENERATED_PATTERNS: ReadonlyArray<RegExp> = [
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /bun\.lock$/i,
  /bun\.lockb$/i,
  /\.lock$/i,
  /_pb2\.py$/i,
  /\.pb\.go$/i,
  /\.pb\.cc$/i,
  /\.pb\.h$/i,
  /\.g\.py$/i,
  /\.g\.yaml$/i,
  /generated.*\.(ts|js|go|py)$/i,
  /\.gen\.(ts|js)$/i,
  /__generated__\//i,
  /auto-generated/i,
];

/** The engine's own ledger / meta outputs. Counting these as "source"
 *  causes circular re-analysis. */
export const LEDGER_OR_META_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:.*\/)?(?:CORRECT|WRONG|stuff|COMMITS_LEDGER|RAW_GIT_LOG|SUMMARY|metadata|README|CHANGELOG)(?:-[^/]+)?\.(?:md|json|txt)$/i,
  /^postmortems\//i,
  /^\.loop-push-state\.json$/i,
  /^dev\.log$/i,
];

export function isLockfileOrGeneratedFile(path: string): boolean {
  return LOCKFILE_AND_GENERATED_PATTERNS.some((p) => p.test(path));
}

export function isLedgerOrMetaFile(path: string): boolean {
  return LEDGER_OR_META_PATTERNS.some((p) => p.test(path));
}

/** A commit whose EVERY file is lockfile/generated OR ledger/meta is
 *  NOT a real source change — skip it in commit-archaeology pairing
 *  (it would otherwise pollute the wrong/correct counts). Returns true
 *  when the commit has at least one REAL source file. */
export function hasCoreSourceFiles(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.some((f) => !isLockfileOrGeneratedFile(f) && !isLedgerOrMetaFile(f));
}
