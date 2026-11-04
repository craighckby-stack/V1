/**
 * Repo-backed postmortem persistence.
 *
 * Source of truth for postmortem records: JSON files committed to the repo
 * under `postmortems/<repo>/<branch>/<filepath>.json`. SQLite (in
 * postmortem-store.ts) is now a CACHE over this — wiped-DB amnesia is over:
 * the failure memory lives in git history, survives process restarts, and
 * is auditable alongside the mutations it constrained.
 *
 * Why one file per (repo, branch, filePath):
 *   - Matches the existing @@unique([targetRepo, branch, filePath]) invariant
 *   - Git diffs are per-file, so a constraint update shows up as one-file churn
 *     instead of a single megablob changing every time
 *   - A reviewer reading the repo can `ls postmortems/` and see exactly which
 *     files have failed and why
 *
 * Atomic writes (write to *.tmp, rename): the loop reads these on every
 * cycle and Turbopack's file watcher sees them — a half-written JSON would
 * either crash the reader or get hot-reloaded mid-flush. The tmp+rename
 * makes the swap atomic at the filesystem level.
 *
 * No DB dependency, no network, no LLM — pure leaf module. The only state
 * is the filesystem.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync, rmSync } from "fs";
import { join, dirname, relative, sep } from "path";
import type { PostmortemRecord, PostmortemFailureType } from "./postmortem-store";

import { PROJECT_ROOT } from "../core/paths";
const POSTMORTEM_DIR = join(PROJECT_ROOT, "postmortems");

/** Sanitize a repo slug like "craighckby-stack/V1" into a single path
 *  component (the "/" would otherwise nest a real directory). */
function sanitizeRepo(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]/g, "__");
}

/** Sanitize a branch name the same way. Branch names routinely contain
 *  "/" ("feature/x", "fix/y") — unsanitized, the writer would nest real
 *  directories (postmortems/<repo>/feature/x/...) while the reader
 *  enumerates only IMMEDIATE children and matches "feature", never
 *  "feature/x" — so every branch-filtered lookup and the wiped-DB
 *  rehydration silently missed those records (external audit, finding 3).
 *  sanitize("main") === "main", so existing on-disk records stay valid. */
function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, "__");
}

/** Split a source filePath into safe path segments for the postmortem
 *  tree:
 *    - split on "/" (and "\\" — a Windows-style separator must not become
 *      a filename character here)
 *    - drop empty segments and "."
 *    - drop every ".." segment — AUDIT 3 (F4a): the seed endpoint
 *      previously allowed traversal, and an unsanitized ".." would let
 *      the join escape postmortems/<repo>/<branch>/ into the wider tree
 *      (path.join normalizes it away). Defense in depth: the route is
 *      being fixed separately; every caller of the mapping (write, read,
 *      delete) is protected regardless of where the filePath came from. */
function safeSegments(filePath: string): string[] {
  return filePath
    .split(/[\\/]+/)
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
}

/** Join sanitized repo/branch + safe segments + a trailing ".json" onto
 *  an extension-less-or-not basename. Shared by both filename forms. */
function joinPostmortemPath(
  repo: string,
  branch: string,
  segments: string[],
  suffix: string
): string {
  const dirs = segments.slice(0, -1);
  const name = `${segments.length > 0 ? segments[segments.length - 1] : "postmortem"}${suffix}`;
  return join(POSTMORTEM_DIR, sanitizeRepo(repo), sanitizeBranch(branch), ...dirs, name);
}

/** Turn a relative source path like "src/lib/pipeline/emg/debate.ts"
 *  into a safe JSON filename.
 *
 *  CURRENT form (AUDIT 3, F14): the FULL basename with its source
 *  extension plus ".json" — "a/x.ts" → "a/x.ts.json", "a/x.tsx" →
 *  "a/x.tsx.json". The pre-F14 form stripped the extension, so "a/x.ts"
 *  and "a/x.tsx" both mapped to "a/x.json": the second write silently
 *  overwrote the first record's memory, and after a DB wipe the
 *  resurrected file was the wrong one's. Extension-less source paths
 *  ("system:duress", "red-team:rt-*") map identically under both forms,
 *  so they have no legacy twin.
 *
 *  AUDIT 3 (F4a): ".." segments are dropped (see safeSegments) so the
 *  join can never escape postmortems/<repo>/<branch>/. */
function relativePathToPostmortemFile(repo: string, branch: string, filePath: string): string {
  // Keep the FULL basename with extension; keep directory structure.
  return joinPostmortemPath(repo, branch, safeSegments(filePath), ".json");
}

/** LEGACY form (pre-F14): source extension stripped + ".json" —
 *  "a/x.ts" → "a/x.json". READ-ONLY: the ~dozens of files already on
 *  disk in this shape keep loading (readPostmortemFromDisk tries the
 *  current form first and falls back to this), while every new write
 *  lands in the current form and removes its legacy twin
 *  (writePostmortemToDisk). Never used for writing. */
function legacyPathToPostmortemFile(repo: string, branch: string, filePath: string): string {
  const noExt = filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
  return joinPostmortemPath(repo, branch, safeSegments(noExt), ".json");
}

/** Every on-disk filename a (repo, branch, filePath) record may occupy,
 *  in lookup order: current F14 form first, legacy extension-less form
 *  second (audit 3, F14). Deduped — for extension-less source paths the
 *  two coincide. Readers try them in order; deleters remove all of them. */
function postmortemFileCandidates(repo: string, branch: string, filePath: string): string[] {
  const current = relativePathToPostmortemFile(repo, branch, filePath);
  const legacy = legacyPathToPostmortemFile(repo, branch, filePath);
  return legacy === current ? [current] : [current, legacy];
}

/** Reverse: turn a postmortem filename back into a source filePath for
 *  listActive / enumeration (walkAndCollect). Current-form filenames
 *  embed the full basename, so the extension is derived from the JSON
 *  filename itself; legacy extension-less files lost that information
 *  when they were written and keep the pre-F14 ".ts" default. See
 *  walkAndCollect. */
interface DiscoveredRecord {
  repo: string;
  branch: string;
  filePath: string;
  record: PostmortemRecord;
}

/** Shape written to disk. Stable, hand-readable, git-diff-friendly.
 *  Matches PostmortemRecord but with ISO timestamp strings (no Date
 *  objects in JSON) and no `id` field (the path IS the id).
 *
 *  Schema 2 (added 2026-10-29): adds verificationStatus, parentHash, hash
 *  for the tamper-evident chain + CANDIDATE→VERIFIED lifecycle. Schema-1
 *  files are still readable (the new fields default to verified/null),
 *  so a repo with old on-disk postmortems doesn't need a migration. */
interface PostmortemFile {
  targetRepo: string;
  branch: string;
  filePath: string;
  status: "active" | "resolved";
  verificationStatus?: "verified" | "candidate" | "rejected"; // schema 2+; defaults to "verified" for schema-1 files
  failureType: PostmortemFailureType;
  symptom: string;
  evidence: string;
  constraints: string;
  attempts: number;
  parentHash?: string | null; // schema 2+; null for schema-1 files
  hash?: string | null;         // schema 2+; null for schema-1 files
  lastAttemptAt: string; // ISO
  resolvedAt: string | null; // ISO or null
  createdAt: string; // ISO
  updatedAt: string; // ISO
  /** Schema version — bump if the shape ever changes, so old files can be
   *  migrated or rejected cleanly instead of misparsed. */
  schema: 1 | 2;
}

const SCHEMA_VERSION = 2 as const;
const COMPATIBLE_SCHEMAS = new Set<number>([1, 2]);

function nowIso(): string {
  return new Date().toISOString();
}

function toFileShape(rec: PostmortemRecord): PostmortemFile {
  return {
    targetRepo: rec.targetRepo,
    branch: rec.branch,
    filePath: rec.filePath,
    status: rec.status,
    verificationStatus: rec.verificationStatus,
    failureType: rec.failureType,
    symptom: rec.symptom,
    evidence: rec.evidence,
    constraints: rec.constraints,
    attempts: rec.attempts,
    parentHash: rec.parentHash,
    hash: rec.hash,
    lastAttemptAt: rec.lastAttemptAt,
    resolvedAt: rec.resolvedAt,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    schema: SCHEMA_VERSION,
  };
}

function fromFileShape(f: PostmortemFile): PostmortemRecord {
  return {
    // Reconstruct a stable id from the path so callers that compare by id
    // (the UI's delete endpoint) still work — the path IS the id.
    id: `${f.targetRepo}/${f.branch}/${f.filePath}`,
    targetRepo: f.targetRepo,
    branch: f.branch,
    filePath: f.filePath,
    status: f.status,
    // Schema-1 files predate the verification lifecycle — treat them as
    // verified (they were all recorded from real observed failures).
    verificationStatus: f.verificationStatus ?? "verified",
    failureType: f.failureType,
    symptom: f.symptom,
    evidence: f.evidence,
    constraints: f.constraints,
    attempts: f.attempts,
    // Schema-1 files predate the chain — null hashes are honest (the
    // chain just resumes from the next schema-2 record).
    parentHash: f.parentHash ?? null,
    hash: f.hash ?? null,
    lastAttemptAt: f.lastAttemptAt,
    resolvedAt: f.resolvedAt,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

/** Write a postmortem record to disk atomically. Creates the directory
 *  tree if needed. Throws on failure so the caller can fall back. */
export function writePostmortemToDisk(rec: PostmortemRecord): void {
  const absPath = relativePathToPostmortemFile(rec.targetRepo, rec.branch, rec.filePath);
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const file: PostmortemFile = toFileShape(rec);
  const json = JSON.stringify(file, null, 2) + "\n";
  // Atomic write: *.tmp then rename. Prevents the loop (or Turbopack's
  // watcher) from reading a half-flushed file.
  const tmpPath = `${absPath}.tmp`;
  writeFileSync(tmpPath, json, "utf-8");
  renameSync(tmpPath, absPath);
  // AUDIT 3 (F14): if this record previously lived in the legacy
  // extension-less form, that file is now a STALE TWIN of the one just
  // written — same record, two files. The twin would resurrect the record
  // after a dismiss that removed only one of them, and listFromDisk would
  // enumerate the record twice. Remove it; best-effort (a missing twin is
  // the common case once the tree has migrated).
  const legacy = legacyPathToPostmortemFile(rec.targetRepo, rec.branch, rec.filePath);
  if (legacy !== absPath) {
    try {
      rmSync(legacy, { force: true });
    } catch {
      /* best-effort — the current-form file is already authoritative */
    }
  }
}

/** Read a single postmortem record from disk. Returns null if the file
 *  doesn't exist or fails schema validation.
 *
 *  AUDIT 3 (F14): tries the CURRENT filename form (full basename +
 *  ".json") first, then falls back to the LEGACY extension-less form, so
 *  the ~dozens of pre-F14 on-disk files keep loading. A candidate that
 *  exists but fails to parse / schema-check / identity-check falls
 *  through to the next candidate instead of failing the whole read. */
export function readPostmortemFromDisk(
  repo: string,
  branch: string,
  filePath: string
): PostmortemRecord | null {
  for (const absPath of postmortemFileCandidates(repo, branch, filePath)) {
    if (!existsSync(absPath)) continue;
    try {
      const raw = readFileSync(absPath, "utf-8");
      const parsed = JSON.parse(raw) as PostmortemFile;
      if (!COMPATIBLE_SCHEMAS.has(parsed.schema)) {
        // Unknown schema — ignore rather than misparse; try the twin.
        continue;
      }
      // Sanity: the file must be for THIS (repo, branch, filePath) — a
      // misplaced file shouldn't poison a different file's constraints.
      if (parsed.targetRepo !== repo || parsed.branch !== branch || parsed.filePath !== filePath) {
        continue;
      }
      return fromFileShape(parsed);
    } catch {
      continue; // unreadable JSON — try the twin before giving up
    }
  }
  return null;
}

/** Mark an on-disk postmortem as resolved (status + resolvedAt timestamp).
 *  Does NOT delete the file — resolved records stay in git history as
 *  "this file failed, then was fixed" audit trail. getActivePostmortem
 *  skips resolved records; listActive can optionally include them.
 *
 *  Also flips a CANDIDATE to REJECTED on resolve: the external claim was
 *  contradicted by the file succeeding without the claimed failure
 *  occurring. (A VERIFIED record stays verified — the failure was real,
 *  it's now fixed.) Mirrors the DB-side markResolved two-phase update.
 *
 *  AUDIT 3: no rehash here (or in markResolved) — the lifecycle fields
 *  this flips (status, verificationStatus, resolvedAt) are EXCLUDED from
 *  the chain's hashed content (see canonicalPostmortemContent in
 *  postmortem-store.ts), so this legitimate lifecycle flip can never
 *  register as content tampering. The record's stored hash keeps
 *  verifying across the resolve. */
export function resolvePostmortemOnDisk(
  repo: string,
  branch: string,
  filePath: string
): void {
  const existing = readPostmortemFromDisk(repo, branch, filePath);
  if (!existing) return; // nothing to resolve
  if (existing.status === "resolved") return;
  existing.status = "resolved";
  if (existing.verificationStatus === "candidate") {
    existing.verificationStatus = "rejected";
  }
  existing.resolvedAt = nowIso();
  existing.updatedAt = nowIso();
  writePostmortemToDisk(existing);
}

/** Remove a postmortem's on-disk file(s) — the UI "dismiss" path
 *  (postmortem-store.delete).
 *
 *  AUDIT 3 (defect 2): delete() used to remove only the SQLite row while
 *  the disk JSON is the declared source of truth, so ensureRehydrated
 *  re-imported the file on the next boot and the dismissed record
 *  resurrected. This removes EVERY filename form the record may occupy
 *  (current F14 form + legacy extension-less twin) so no stale copy can
 *  resurrect it. Best-effort and never throws — a missing file is a
 *  no-op, not a failure; an unreadable one must not fail the DB delete.
 *  Returns true when at least one file was actually removed. */
export function deletePostmortemFromDisk(
  repo: string,
  branch: string,
  filePath: string
): boolean {
  let removed = false;
  for (const absPath of postmortemFileCandidates(repo, branch, filePath)) {
    try {
      if (!existsSync(absPath)) continue;
      rmSync(absPath, { force: true });
      removed = true;
    } catch {
      /* best-effort — never let a file problem fail the DB delete */
    }
  }
  return removed;
}

/** Walk the postmortems/ tree and return every record (active + resolved).
 *  Used by listActive and by the SQLite-rehydration path. */
export function listAllPostmortemsFromDisk(): PostmortemRecord[] {
  return listFromDisk(undefined, undefined);
}

/** List postmortems from disk, optionally filtered by repo/branch.
 *  Used when the DB is wiped and we need to rehydrate, or by listActive
 *  when the DB miss should fall through to the repo. */
export function listFromDisk(repo?: string, branch?: string): PostmortemRecord[] {
  const out: PostmortemRecord[] = [];
  if (!existsSync(POSTMORTEM_DIR)) return out;

  // postmortems/<repo>/<branch>/<...dirs...>/<file>.json
  const repoFilter = repo ? sanitizeRepo(repo) : null;
  const repoDirs = readdirSync(POSTMORTEM_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (!repoFilter || e.name === repoFilter));

  for (const repoDir of repoDirs) {
    const repoPath = join(POSTMORTEM_DIR, repoDir.name);
    // Branch filter compares SANITIZED names — the on-disk dir for
    // "feature/x" is "feature__x" (see sanitizeBranch).
    const branchFilter = branch ? sanitizeBranch(branch) : null;
    const branchDirs = readdirSync(repoPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (!branchFilter || e.name === branchFilter));
    for (const branchDir of branchDirs) {
      const branchPath = join(repoPath, branchDir.name);
      walkAndCollect(branchPath, branchDir.name, repoDir.name, out);
    }
  }
  return out;
}

function walkAndCollect(dir: string, branch: string, repoSlug: string, out: PostmortemRecord[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndCollect(fullPath, branch, repoSlug, out);
    } else if (entry.name.endsWith(".json")) {
      try {
        const raw = readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(raw) as PostmortemFile;
        if (!COMPATIBLE_SCHEMAS.has(parsed.schema)) continue;
        // Reconstruct filePath from the path under postmortems/<repo>/<branch>/.
        // AUDIT 3 (F14): current-form filenames embed the FULL source
        // basename — "a/x.ts.json" → "a/x.ts", "a/x.tsx.json" → "a/x.tsx" —
        // so the extension is derived from the JSON filename itself (any
        // known source extension is preserved as-is). Legacy extension-less
        // files ("a/x.json") destroyed that information when they were
        // written; those keep the pre-F14 heuristic (default ".ts", the
        // only extension the loop mutates). The in-file filePath is
        // preferred whenever present — it carries the truth for both forms;
        // the reconstruction is only the fallback.
        const rel = relative(join(POSTMORTEM_DIR, repoSlug, branch), fullPath)
          .split(sep)
          .join("/");
        let reconstructed = rel.replace(/\.json$/, "");
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(reconstructed)) reconstructed += ".ts";
        const filePath = parsed.filePath || reconstructed;
        out.push(fromFileShape({ ...parsed, filePath }));
      } catch {
        /* unreadable JSON — skip */
      }
    }
  }
}

/** Rehydrate SQLite from disk. Called once at startup if the DB has fewer
 *  rows than the repo (the wiped-DB recovery path). Idempotent: skips
 *  records that already exist in the DB. Returns the count imported.
 *  Caller must pass a write function (to avoid a circular import on db). */
export async function rehydrateSqliteFromDisk(
  upsert: (rec: PostmortemRecord) => Promise<void>
): Promise<number> {
  const records = listAllPostmortemsFromDisk();
  let count = 0;
  for (const rec of records) {
    try {
      await upsert(rec);
      count++;
    } catch {
      /* ignore individual failures — best-effort rehydration */
    }
  }
  return count;
}

