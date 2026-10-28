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

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync } from "fs";
import { join, dirname, relative, sep } from "path";
import type { PostmortemRecord, PostmortemFailureType } from "./postmortem-store";

const PROJECT_ROOT = "/home/z/my-project";
const POSTMORTEM_DIR = join(PROJECT_ROOT, "postmortems");

/** Sanitize a repo slug like "craighckby-stack/V1" into a single path
 *  component (the "/" would otherwise nest a real directory). */
function sanitizeRepo(repo: string): string {
  if (repo == null) {
    throw new Error("Repo cannot be null or undefined");
  }
  return repo.replace(/[^a-zA-Z0-9._-]/g, "__");
}

/** Turn a relative source path like "src/lib/pipeline/emg/debate.ts"
 *  into a safe JSON filename with no extension collision. The ".json"
 *  suffix replaces the source extension so "debate.ts" → "debate.json"
 *  (a directory tree of them is unambiguous and git-friendly). */
function relativePathToPostmortemFile(repo: string, branch: string, filePath: string): string {
  if (repo == null || branch == null || filePath == null) {
    throw new Error("Repo, branch, and filePath cannot be null or undefined");
  }
  // Strip the source extension; keep directory structure.
  const noExt = filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
  return join(POSTMORTEM_DIR, sanitizeRepo(repo), branch, `${noExt}.json`);
}

/** Reverse: turn a postmortem filename back into (repo, branch, filePath)
 *  for listActive / enumeration. The source extension is unknowable from
 *  the filename alone (we stripped it), so we return ".ts" as the default
 *  — the only extension the loop mutates. */
interface DiscoveredRecord {
  repo: string;
  branch: string;
  filePath: string;
  record: PostmortemRecord;
}

/** Shape written to disk. Stable, hand-readable, git-diff-friendly.
 *  Matches PostmortemRecord but with ISO timestamp strings (no Date
 *  objects in JSON) and no `id` field (the path IS the id). */
interface PostmortemFile {
  targetRepo: string;
  branch: string;
  filePath: string;
  status: "active" | "resolved";
  failureType: PostmortemFailureType;
  symptom: string;
  evidence: string;
  constraints: string;
  attempts: number;
  lastAttemptAt: string; // ISO
  resolvedAt: string | null; // ISO or null
  createdAt: string; // ISO
  updatedAt: string; // ISO
  /** Schema version — bump if the shape ever changes, so old files can be
   *  migrated or rejected cleanly instead of misparsed. */
  schema: 1;
}

const SCHEMA_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function toFileShape(rec: PostmortemRecord): PostmortemFile {
  return {
    targetRepo: rec.targetRepo,
    branch: rec.branch,
    filePath: rec.filePath,
    status: rec.status,
    failureType: rec.failureType,
    symptom: rec.symptom,
    evidence: rec.evidence,
    constraints: rec.constraints,
    attempts: rec.attempts,
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
    failureType: f.failureType,
    symptom: f.symptom,
    evidence: f.evidence,
    constraints: f.constraints,
    attempts: f.attempts,
    lastAttemptAt: f.lastAttemptAt,
    resolvedAt: f.resolvedAt,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

/** Write a postmortem record to disk atomically. Creates the directory
 *  tree if needed. Throws on failure so the caller can fall back. */
export function writePostmortemToDisk(rec: PostmortemRecord): void {
  if (rec == null) {
    throw new Error("Postmortem record cannot be null or undefined");
  }
  const absPath = relativePathToPostmortemFile(rec.targetRepo, rec.branch, rec.filePath);
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const file: PostmortemFile = toFileShape(rec);
  const json = JSON.stringify(file, null, 2) + "\n";
  // Atomic write: *.tmp then rename. Prevents the loop (or Turbopack's
  // watcher) from reading a half-flushed file.
  const tmpPath = `${absPath}.tmp`;
  writeFileSync(tmpPath, json, "utf-8");
  
  // Check if file exists before renaming to prevent race condition
  if (existsSync(absPath)) {
    // If file exists, remove it first to ensure rename succeeds
    require("fs").unlinkSync(absPath);
  }
  renameSync(tmpPath, absPath);
}

/** Read a single postmortem record from disk. Returns null if the file
 *  doesn't exist or fails schema validation. */
export function readPostmortemFromDisk(
  repo: string,
  branch: string,
  filePath: string
): PostmortemRecord | null {
  if (repo == null || branch == null || filePath == null) {
    throw new Error("Repo, branch, and filePath cannot be null or undefined");
  }
  const absPath = relativePathToPostmortemFile(repo, branch, filePath);
  if (!existsSync(absPath)) return null;
  try {
    const raw = readFileSync(absPath, "utf-8");
    const parsed = JSON.parse(raw) as PostmortemFile;
    if (parsed.schema !== SCHEMA_VERSION) {
      // Unknown schema — ignore rather than misparse. A future migration
      // path can read + upgrade; for now, the SQLite cache still serves
      // and the next recordFailure will overwrite with the current shape.
      return null;
    }
    // Sanity: the file must be for THIS (repo, branch, filePath) — a
    // misplaced file shouldn't poison a different file's constraints.
    if (parsed.targetRepo !== repo || parsed.branch !== branch || parsed.filePath !== filePath) {
      return null;
    }
    return fromFileShape(parsed);
  } catch {
    return null;
  }
}

/** Mark an on-disk postmortem as resolved (status + resolvedAt timestamp).
 *  Does NOT delete the file — resolved records stay in git history as
 *  "this file failed, then was fixed" audit trail. getActivePostmortem
 *  skips resolved records; listActive can optionally include them. */
export function resolvePostmortemOnDisk(
  repo: string,
  branch: string,
  filePath: string
): void {
  if (repo == null || branch == null || filePath == null) {
    throw new Error("Repo, branch, and filePath cannot be null or undefined");
  }
  const existing = readPostmortemFromDisk(repo, branch, filePath);
  if (!existing) {
    throw new Error(`Cannot resolve non-existent postmortem: ${repo}/${branch}/${filePath}`);
  }
  if (existing.status === "resolved") return;
  existing.status = "resolved";
  existing.resolvedAt = nowIso();
  existing.updatedAt = nowIso();
  writePostmortemToDisk(existing);
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
    const branchDirs = readdirSync(repoPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (!branch || e.name === branch));
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
  } catch (error) {
    // Log the error but continue processing other directories
    console.error(`Error reading directory ${dir}:`, error);
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
        if (parsed.schema !== SCHEMA_VERSION) continue;
        
        // Reconstruct filePath from the path under postmortems/<repo>/<branch>/
        const rel = relative(join(POSTMORTEM_DIR, repoSlug, branch), fullPath)
          .replace(/\.json$/, ".ts") // default ext — see relativePathToPostmortemFile
          .split(sep)
          .join("/");
        
        // Use the filePath from the file if it exists and matches the expected path
        // Otherwise fall back to the reconstructed path
        let filePath = parsed.filePath;
        if (!filePath || filePath !== rel) {
          filePath = rel;
        }
        
        out.push(fromFileShape({ ...parsed, filePath }));
      } catch (error) {
        /* unreadable JSON — skip */
        console.error(`Error reading postmortem file ${fullPath}:`, error);
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
  if (upsert == null) {
    throw new Error("Upsert function cannot be null or undefined - rehydration requires a valid upsert function");
  }
  const records = listAllPostmortemsFromDisk();
  let count = 0;
  for (const rec of records) {
    try {
      await upsert(rec);
      count++;
    } catch (error) {
      /* ignore individual failures — best-effort rehydration */
      console.error(`Error upserting postmortem record ${rec.id}:`, error);
    }
  }
  return count;
}

/** Project root for tests / inspection. Not used internally. */
export function getPostmortemDir(): string {
  return POSTMORTEM_DIR;
}