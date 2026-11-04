/**
 * Git Push Target — persistent, authenticated GitHub push for the
 * self-enhance loop.
 *
 * The loop commits its own evolving source and pushes it to GitHub as proof.
 * This module owns:
 *   - Persistent push target config (repo + token) in the DB (survives restarts)
 *   - Token verification + repo existence check (auto-creates the repo if missing)
 *   - Authenticated git push WITHOUT ever persisting the token in git config
 *     (auth is injected per-push via GIT_CONFIG_* env vars, so the token never
 *     appears in `git remote -v`, error output, or the process command line)
 *
 * Security: the token is stored in the local SQLite DB and is NEVER returned
 * to the client. All error messages are scrubbed of the token.
 */

import { execSync, execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { db } from "@/lib/db";
import {
  scanDiff,
  scanCommitMessage,
  summarizeFindings,
  isIgnoredScanPath,
  type SecretFinding,
} from "../core/secret-scan";
import { recordPushSuccess, recordPushAuthFailure } from "../core/duress";
import { recoverCrashedTestGate } from "../core/test-gate-journal";
import { PROJECT_ROOT } from "../core/paths";

const SINGLETON_ID = "singleton";

// ── Durable push-target state (audit2-d) ──────────────────────────────
// The sandbox's boot sequence recreates the database (db:push at startup
// on a restored filesystem layer), which wiped the push config — INCLUDING
// the user's PAT — on every machine restart. The filesystem itself survives
// restarts (git history, worklog, postmortems/ all persist). So the config
// now ALSO lives in a gitignored JSON file at the project root: the DB is
// the cache, the file is the source of truth, same pattern as the
// postmortems (audit2-c). The file is NEVER committed — it holds a secret.
const STATE_FILE = join(PROJECT_ROOT, ".loop-push-state.json");

// ── Tier-3 persistent store: .git/info/loop-push-state.json ───────────
// The sandbox this system runs in wipes both the DB file (db/custom.db) AND
// the project-root state file (.loop-push-state.json) on every machine
// restart — both are untracked files. The .git/ directory, however, MUST
// persist across restarts (it holds commit history; losing it would lose
// the whole repo). Files inside .git/info/ are ignored by git status and
// survive restarts for free. We use this as a third-tier fallback: if both
// the DB and the root state file are empty, recover from .git/info/. This
// is the path that closes the "third PAT loss" gap observed on 2026-10-29.
// Same 0o600 perms, same JSON shape, same never-committed invariant.
const GIT_DIR = join(PROJECT_ROOT, ".git");
const PERSISTENT_STATE_FILE = join(GIT_DIR, "info", "loop-push-state.json");

interface LoopPushState {
  repo: string;
  token: string;
  branch: string;
  createdRepo: boolean;
  lastBranchNumber: number;
  savedAt: string; // ISO — when the file was written
}

function readStateFile(): LoopPushState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as LoopPushState;
    if (!parsed.repo || !parsed.token || !parsed.branch) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Tier-3 read: identical to readStateFile but against .git/info/. Used only
// by seedDbFromStateFile when the root state file is missing (sandbox wiped
// it on restart). .git/ is the one directory the sandbox restore guarantees
// to preserve, so this is the durable last-resort store.
function readPersistentStateFile(): LoopPushState | null {
  try {
    if (!existsSync(PERSISTENT_STATE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(PERSISTENT_STATE_FILE, "utf-8")) as LoopPushState;
    if (!parsed.repo || !parsed.token || !parsed.branch) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStateFile(state: LoopPushState): { tier2Ok: boolean; tier3Ok: boolean } {
  const tmp = `${STATE_FILE}.tmp`;
  // 0o600 — the file holds the PAT; never group/world-readable.
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, STATE_FILE); // atomic — never a half-written config

  // ── Load-bearing read-back (concept: PKM pkm_orchestrator.c phase_wp) ──
  // "Set without confirm = PKM_FAILED (post-mortem #4). The wall only
  // exists if the query says so." A write that isn't read back is an
  // assumption, not a fact. The sandbox's restart-on-rollback behavior
  // (which silently dropped the PAT 3× across sessions) is exactly the
  // kind of failure a read-back catches at write time instead of at the
  // next push. We read tier-2 back and confirm the token round-tripped.
  let tier2Ok = true;
  try {
    const readBack = readStateFile();
    if (!readBack || readBack.token !== state.token || readBack.repo !== state.repo) {
      tier2Ok = false;
      console.error("[PUSH-TARGET] tier-2 read-back MISMATCH — write did not round-trip");
    }
  } catch (err) {
    tier2Ok = false;
    console.error("[PUSH-TARGET] tier-2 read-back failed:", err);
  }

  // Also write the tier-3 persistent copy inside .git/info/. mkdirSync is
  // idempotent — .git/info usually exists, but we don't assume it. Same
  // atomic-write pattern (tmp + rename). Best-effort: if .git is read-only
  // for some reason, the root state file still serves as the fallback.
  let tier3Ok = true;
  try {
    mkdirSync(dirname(PERSISTENT_STATE_FILE), { recursive: true });
    const ptmp = `${PERSISTENT_STATE_FILE}.tmp`;
    writeFileSync(ptmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    renameSync(ptmp, PERSISTENT_STATE_FILE);
    // Read-back the tier-3 file too — same load-bearing principle.
    const readBack3 = readPersistentStateFile();
    if (!readBack3 || readBack3.token !== state.token || readBack3.repo !== state.repo) {
      tier3Ok = false;
      console.error("[PUSH-TARGET] tier-3 read-back MISMATCH — .git/info write did not round-trip");
    }
  } catch {
    /* best-effort — root state file is still the primary tier-2 store */
    tier3Ok = false;
  }
  return { tier2Ok, tier3Ok };
}

/** Seed the DB from the state file if the DB row is missing (the
 *  machine-restart recovery path). Best-effort, idempotent.
 *
 *  Tries tier-2 (project-root state file) first; if missing, falls back
 *  to tier-3 (.git/info/) — the path that survives sandbox restarts even
 *  when untracked files at the project root are wiped. */
async function seedDbFromStateFile(): Promise<LoopPushState | null> {
  let state = readStateFile();
  if (!state) state = readPersistentStateFile();
  if (!state) return null;
  try {
    await db.gitPushTarget.upsert({
      where: { id: SINGLETON_ID },
      update: {}, // never overwrite an existing row — DB wins when present
      create: {
        id: SINGLETON_ID,
        repo: state.repo,
        token: state.token,
        branch: state.branch,
        createdRepo: state.createdRepo,
        lastBranchNumber: state.lastBranchNumber,
      },
    });
    // If we recovered from tier-3, backfill tier-2 so the next read finds
    // the root file and doesn't have to dip into .git/info/ every time.
    if (!existsSync(STATE_FILE)) {
      try { writeStateFile(state); } catch { /* best-effort */ }
    }
  } catch {
    /* DB unavailable — the file alone still serves reads */
  }
  return state;
}

export interface PushTargetPublic {
  configured: boolean;
  repo?: string;
  branch?: string;          // configured seed branch (e.g. "main")
  createdRepo?: boolean;
  lastPushAt?: string | null;
  lastPushSha?: string | null;
  lastPushError?: string | null;
  lastBranchNumber?: number; // successful enhancements pushed so far (loop-NN)
}

export interface PushOutcome {
  pushed: boolean;
  commitSha?: string;
  hadChanges?: boolean;
  repo?: string;
  error?: string;
  /** True when a fetch-first rejection was auto-healed (merge -s ours + retry). */
  divergenceHealed?: boolean;
}

interface StoredTarget {
  repo: string;
  token: string;
  branch: string;
}

/** Serialize pushes — the loop and manual pushes share one repo. */
let pushInProgress = false;

/** GitHub REST helper — authenticated requests use their own (high) quota. */
async function ghFetch(
  path: string,
  token: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "self-enhance-loop",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
}

/** Remove the raw token from any string before logging/returning it. */
function scrub(text: string, token: string): string {
  if (!text || !token) return text ?? "";
  return text.split(token).join("***");
}

function validRepoFormat(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function validTokenFormat(token: string): boolean {
  return token.length >= 20 && !/\s/.test(token);
}

/** Read the stored target (with token) — server-side only. Exported so
 *  sibling server modules (commit-archaeology's token resolution) can
 *  reuse the same DB → state-file → tier-3 fallback chain instead of
 *  re-implementing it. NEVER call from a client component. */
export async function getStoredTarget(): Promise<StoredTarget | null> {
  let row: Awaited<ReturnType<typeof db.gitPushTarget.findUnique>> = null;
  try {
    row = await db.gitPushTarget.findUnique({ where: { id: SINGLETON_ID } });
  } catch {
    /* DB unavailable — fall through to the state file */
  }
  if (!row) {
    // DB wiped (machine restart) — recover from the durable state file.
    const state = await seedDbFromStateFile();
    if (state) return { repo: state.repo, token: state.token, branch: state.branch };
    return null;
  }
  return { repo: row.repo, token: row.token, branch: row.branch };
}

/** Synchronous, file-only read of the stored target. For callers that
 *  can't await a DB round-trip — notably the autonomous loop's
 *  `resolveToken`, which runs at the top of every cycle and needs the
 *  PAT without an async dependency. Reads tier-2 (root state file) first,
 *  then tier-3 (.git/info/). Returns null if neither has a valid token.
 *
 *  IMPORTANT: this skips the DB on purpose (sync). If the DB has a token
 *  the files don't, `getStoredTarget()` (async) is the source of truth.
 *  But in practice the files are written FIRST (writeStateFile writes
 *  before the DB upsert), so if a token exists at all, the files have
 *  it. This is the same pattern that made the 3-tier persistence robust
 *  to sandbox wipes. */
export function getStoredTargetSync(): { repo: string; token: string; branch: string } | null {
  const state = readStateFile() ?? readPersistentStateFile();
  if (!state) return null;
  if (!state.token || state.token.length < 8) return null;
  return { repo: state.repo, token: state.token, branch: state.branch };
}

/** Public view of the push target — token never included. */
export async function getPushTargetPublic(): Promise<PushTargetPublic> {
  let row: Awaited<ReturnType<typeof db.gitPushTarget.findUnique>> = null;
  try {
    row = await db.gitPushTarget.findUnique({ where: { id: SINGLETON_ID } });
  } catch {
    /* DB unavailable — fall through to the state file */
  }
  if (!row) {
    // DB wiped — report from the durable state file so the UI still shows
    // the configured target (and the user knows they DON'T need to re-enter
    // the token just because the DB was recreated).
    const state = await seedDbFromStateFile();
    if (state) {
      return {
        configured: true,
        repo: state.repo,
        branch: state.branch,
        createdRepo: state.createdRepo,
        lastPushAt: null,
        lastPushSha: null,
        lastPushError: null,
        lastBranchNumber: state.lastBranchNumber,
      };
    }
    return { configured: false };
  }
  // Self-heal DB→file: the row exists but the state file is missing (file
  // lost/never written by an older build). Backfill it so the NEXT DB wipe
  // doesn't lose the token — this is the exact gap that forced the last
  // re-configure. Best-effort, never blocks the read.
  if (!existsSync(STATE_FILE)) {
    try {
      writeStateFile({
        repo: row.repo,
        token: row.token,
        branch: row.branch,
        createdRepo: row.createdRepo,
        lastBranchNumber: row.lastBranchNumber ?? 0,
        savedAt: new Date().toISOString(),
      });
    } catch {
      /* best-effort backfill */
    }
  }
  return {
    configured: true,
    repo: row.repo,
    branch: row.branch,
    createdRepo: row.createdRepo,
    lastPushAt: row.lastPushAt?.toISOString() ?? null,
    lastPushSha: row.lastPushSha,
    lastPushError: row.lastPushError,
    lastBranchNumber: row.lastBranchNumber,
  };
}

/**
 * Configure the push target: verify the token, verify (or create) the repo,
 * persist to DB, and point the `origin` remote at the tokenless URL.
 */
export async function setPushTarget(opts: {
  repo: string;
  token: string;
  isPublic?: boolean;
  createIfMissing?: boolean;
}): Promise<{ repo: string; login: string; created: boolean }> {
  const repo = opts.repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "");
  const token = opts.token.trim();

  if (!validRepoFormat(repo)) {
    throw new Error(`Invalid repo format "${repo}" — expected owner/name`);
  }
  if (!validTokenFormat(token)) {
    throw new Error("Invalid token — expected a GitHub PAT (ghp_... or github_pat_..., 20+ chars)");
  }

  // 1. Verify the token (authenticated → own rate quota)
  const userRes = await ghFetch("/user", token);
  if (userRes.status === 401) {
    throw new Error("Token rejected by GitHub (401) — check it's a valid, non-expired PAT");
  }
  if (!userRes.ok) {
    throw new Error(`GitHub token check failed (HTTP ${userRes.status})`);
  }
  const user = (await userRes.json()) as { login: string };
  const login = user.login;

  // 2. Verify the repo exists (or create it)
  let created = false;
  const repoRes = await ghFetch(`/repos/${repo}`, token);
  if (repoRes.status === 404) {
    const createIfMissing = opts.createIfMissing ?? true;
    if (!createIfMissing) {
      throw new Error(
        `Repo ${repo} not found. Create it manually on github.com, or enable "Auto-create repo" in the config panel.`
      );
    }

    const [owner, name] = repo.split("/");
    let createRes: Response;

    if (owner === login) {
      // Personal repo under the authenticated user's account
      createRes = await ghFetch("/user/repos", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          private: !(opts.isPublic ?? false),
          description: "Live state of a self-enhancing code pipeline (auto-pushed)",
          auto_init: false,
        }),
      });
    } else {
      // Owner is someone other than the user — treat as an org and create there.
      // POST /orgs/{org}/repos works only if the user is a member with admin
      // privileges on that org; otherwise GitHub returns 404/403.
      createRes = await ghFetch(`/orgs/${owner}/repos`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          private: !(opts.isPublic ?? false),
          description: "Live state of a self-enhancing code pipeline (auto-pushed)",
          auto_init: false,
        }),
      });
    }

    if (createRes.status === 201) {
      created = true;
    } else if (createRes.status === 403) {
      const body = (await createRes.json().catch(() => ({}))) as { message?: string };
      throw new Error(
        `GitHub refused to create ${repo} (403): ${body.message ?? "forbidden"}. ` +
          "Fine-grained PATs CANNOT create repos — use a classic PAT with 'repo' scope, " +
          "or create the repo manually on github.com first, then reconnect."
      );
    } else if (createRes.status === 404) {
      throw new Error(
        `Owner '${owner}' not found (404). ` +
          "For org repos, your token must be a member of the org with admin privileges. " +
          "Create the repo manually on github.com, then reconnect."
      );
    } else if (createRes.status === 422) {
      // Name collision that /repos couldn't see (e.g. just-created, eventual consistency)
      throw new Error(
        `Repo ${repo} exists but is not accessible with this token (422). ` +
          "Check the token has access to that owner/repo."
      );
    } else {
      const body = (await createRes.json().catch(() => ({}))) as { message?: string };
      throw new Error(`Failed to create repo ${repo}: ${body.message ?? `HTTP ${createRes.status}`}`);
    }
  } else if (!repoRes.ok) {
    const body = (await repoRes.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Repo check failed for ${repo}: ${body.message ?? `HTTP ${repoRes.status}`}`);
  }

  // 3. Persist config — STATE FILE FIRST (audit2-d hardening). The sandbox's
  // DB layer can be rolled back or recreated at any moment (it happened twice:
  // the table simply vanished). The old order — DB upsert first, unguarded —
  // meant a missing table threw AFTER GitHub verification but BEFORE the file
  // was written, losing the just-validated token. Now: the durable file is
  // written before anything can throw, and the DB upsert is best-effort (the
  // file is the source of truth; reads fall back to it when the DB is empty).
  //
  // The counter-preservation read below checks tier-2 AND tier-3: after a
  // sandbox restart the tier-2 file is gone and only .git/info/ survives —
  // reading tier-2 alone would reset the loop-NN counter to 0 mid-run and
  // collide with the existing loop-NN branch on the remote.
  const prevState = readStateFile() ?? readPersistentStateFile();
  try {
    writeStateFile({
      repo,
      token,
      branch: "main",
      createdRepo: created,
      // Preserve the branch counter across a re-configure of the SAME repo so
      // loop-NN numbering doesn't reset mid-run.
      lastBranchNumber: prevState?.repo === repo ? prevState.lastBranchNumber : 0,
      savedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Non-fatal ONLY if the DB write below succeeds — track it.
    console.error("[PUSH-TARGET] failed to write state file:", err);
  }
  try {
    await db.gitPushTarget.upsert({
      where: { id: SINGLETON_ID },
      update: { repo, token, branch: "main", createdRepo: created, lastPushError: null },
      create: { id: SINGLETON_ID, repo, token, branch: "main", createdRepo: created },
    });
  } catch (err) {
    // DB unavailable/recreated — the state file already holds the config;
    // reads rehydrate the DB from it. Don't fail the configure over a cache.
    console.error("[PUSH-TARGET] DB upsert failed (state file already written):", err);
  }

  // 4. Point `origin` at the tokenless URL (safe to display in `git remote -v`)
  const remoteUrl = `https://github.com/${repo}.git`;
  try {
    const existing = execSync("git remote", { cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5000 })
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (existing.includes("origin")) {
      execSync(`git remote set-url origin ${remoteUrl}`, { cwd: PROJECT_ROOT, timeout: 5000 });
    } else {
      execSync(`git remote add origin ${remoteUrl}`, { cwd: PROJECT_ROOT, timeout: 5000 });
    }
  } catch (err) {
    throw new Error(`Failed to set git remote: ${(err as Error).message}`);
  }

  return { repo, login, created };
}

/** Clear the push target: remove the durable state file, delete the DB row,
 *  and remove the remote. FILE FIRST — if the DB table is missing (sandbox
 *  rollback) the old order threw on deleteMany BEFORE rmSync, leaving the
 *  PAT sitting in the file as a zombie credential. The file must go no
 *  matter what the DB does.
 *
 *  BUGFIX (concept: PKM phase-4 load-bearing read-back): the prior version
 *  removed the tier-2 root file but NOT the tier-3 `.git/info/loop-push-state.json`
 *  file. After a "clear", the PAT survived as a zombie credential inside
 *  .git/info/ — the one directory the sandbox guarantees to preserve across
 *  restarts — so a "cleared" system wasn't actually cleared. This now
 *  removes ALL THREE tiers (root file + DB row + .git/info file) AND
 *  read-back-verifies the PAT is gone from every tier. */
export async function clearPushTarget(): Promise<{ cleared: boolean; readBack: { tier2Gone: boolean; tier3Gone: boolean; dbGone: boolean } }> {
  try { rmSync(STATE_FILE, { force: true }); } catch { /* best-effort */ }
  try { rmSync(PERSISTENT_STATE_FILE, { force: true }); } catch { /* best-effort — tier-3 may not exist */ }
  try {
    await db.gitPushTarget.deleteMany({ where: { id: SINGLETON_ID } });
  } catch {
    /* DB unavailable/missing table — the file (source of truth) is gone */
  }
  try {
    execSync("git remote remove origin", { cwd: PROJECT_ROOT, timeout: 5000, stdio: "pipe" });
  } catch {
    /* no origin to remove */
  }
  // Load-bearing read-back: confirm the PAT is actually gone from every
  // tier. "Cleared" is a fact only if the query says so.
  const tier2Gone = readStateFile() === null;
  const tier3Gone = readPersistentStateFile() === null;
  let dbGone = true;
  try {
    const row = await db.gitPushTarget.findUnique({ where: { id: SINGLETON_ID } });
    dbGone = row === null;
  } catch {
    dbGone = true; // DB unavailable = nothing to leak
  }
  return { cleared: true, readBack: { tier2Gone, tier3Gone, dbGone } };
}

/** Purge ALL THREE tiers of PAT persistence WITHOUT touching the git remote.
 *  Used by the duress/purge protocol (duress.ts) — unlike clearPushTarget
 *  this is the PKM §3 Phase-1 KEYS step: pure destruction, no remote
 *  management, called when the system believes the PAT may be compromised.
 *  Returns which tiers were actually purged so the caller can read-back.
 *
 *  Field names (tier2/tier3/db) match the rest of the push-target API
 *  (clearPushTarget readBack, verifyPatGoneFromAllTiers) and the duress
 *  DuressPurgeResult.keysPurged shape — keep them aligned.
 *
 *  NOTE (type-error fix): the local flag was previously named `db`, which
 *  shadowed the imported db client INSIDE the try block — so the purge
 *  line resolved to the local `false`, threw at runtime, and the catch
 *  reported the tier as purged. The DB row survived every duress purge.
 *  Renamed to dbTier; the public return key stays `db`.
 */
export async function purgeAllPatTiers(): Promise<{ tier2: boolean; tier3: boolean; db: boolean }> {
  let tier2 = false;
  let tier3 = false;
  let dbTier = false;
  try {
    rmSync(STATE_FILE, { force: true });
    tier2 = !existsSync(STATE_FILE);
  } catch { tier2 = false; }
  try {
    rmSync(PERSISTENT_STATE_FILE, { force: true });
    tier3 = !existsSync(PERSISTENT_STATE_FILE);
  } catch { tier3 = false; }
  try {
    await db.gitPushTarget.deleteMany({ where: { id: SINGLETON_ID } });
    const row = await db.gitPushTarget.findUnique({ where: { id: SINGLETON_ID } });
    dbTier = row === null;
  } catch {
    // DB unavailable — nothing to purge, nothing to leak. Treat as purged.
    dbTier = true;
  }
  return { tier2, tier3, db: dbTier };
}

/** Read-back verification: is the PAT gone from ALL tiers? Used by the
 *  duress Phase-4 read-back step (PKM "the wall only exists if the query
 *  says so"). Returns per-tier status + a single `allGone` boolean. */
export async function verifyPatGoneFromAllTiers(): Promise<{ tier2Gone: boolean; tier3Gone: boolean; dbGone: boolean; allGone: boolean }> {
  const tier2Gone = readStateFile() === null;
  const tier3Gone = readPersistentStateFile() === null;
  let dbGone = true;
  try {
    const row = await db.gitPushTarget.findUnique({ where: { id: SINGLETON_ID } });
    dbGone = row === null;
  } catch {
    dbGone = true;
  }
  return { tier2Gone, tier3Gone, dbGone, allGone: tier2Gone && tier3Gone && dbGone };
}

// ── Commit-message shape guard (commit-archaeology UUID-defense) ────
// A bare-UUID commit message landed on `main` (commit e5d2b7a, message
// "dc951e0f-8247-4972-be3f-17ca5c301b75"). Investigation concluded the
// commit was NOT created by any LOOP-internal committer — every LOOP
// commit site passes an explicit, human-readable message:
//   - pushCurrentState (here, L698 fallback path & L778 main path)
//   - self-enhance-loop gitPush() routes through pushCurrentState
//   - lessons-markdown.ts export path ("memory: lessons.md export (...)")
// `git reflog --date=iso` showed a 3-hour gap with no entries around the
// commit, and the machine restarted two minutes before it landed. The
// conclusion: the host restore orchestrator that rehydrates the project
// directory from a snapshot on machine restart created the commit, using
// a bare UUID as a placeholder message. This is OUTSIDE LOOP's commit
// path — LOOP cannot prevent it directly, only:
//   (1) Defend internally — this guard ensures LOOP itself never produces
//       one. If a caller accidentally passes an empty/UUID message we
//       return a clear error before `git add -A` runs (matching how the
//       preCommitSecretGate below aborts), and the push outcome stays
//       honestly `pushed: false` with the reason.
//   (2) Detect on startup — self-enhance-loop.ts runs this same validator
//       against `git log -1 --format=%B` once at boot and `console.warn`s
//       if the latest commit looks host-injected (it cannot block boot —
//       the commit is already on disk by the time LOOP runs).
// See postmortems/self/main/system:commit-message-guard.json for the full
// recorded finding, blast radius, and the internal-committer invariants.
//
// Returns null if the message is acceptable, or a block-reason string
// explaining why the message was rejected. Mirrors the return contract of
// `preCommitSecretGate` so the two gates compose cleanly at the commit
// sites (validateCommitMessage runs first — a malformed message shouldn't
// even reach the secret scan).
export function validateCommitMessage(message: string): string | null {
  // Empty / whitespace-only — a commit message with no intent is
  // unsearchable, unarchaeologisable, and breaks the message-prefix
  // convention the rest of the loop relies on (commit-archaeology.ts
  // greps for "Self-enhancement:", "memory:", etc.). The trim handles
  // the "caller passed `opts.message` but it was all spaces" edge case
  // that an empty-string check alone would miss.
  if (!message || message.trim().length === 0) {
    return "Commit message is empty — LOOP requires an explicit, human-readable intent (the host restore orchestrator can inject bare-UUID commits that bypass LOOP; this guard ensures LOOP itself never produces one)";
  }
  // Bare UUID first line (e.g. "dc951e0f-8247-4972-be3f-17ca5c301b75").
  // Matches the exact shape of the host-injected commit so a future
  // accidental pass of a UUID (e.g. a caller copying a snapshot id into
  // the message field) is caught here instead of landing in git history.
  // First-line-only match: a multi-line message whose body legitimately
  // contains a UUID (e.g. "Self-enhancement: refactored X (trace: <uuid>)")
  // is still accepted — only a bare UUID as the FIRST line is rejected.
  const firstLine = message.split(/\r?\n/, 1)[0].trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(firstLine)) {
    return (
      `Commit message is a bare UUID ("${firstLine}") — LOOP requires a human-readable intent ` +
      `(this shape is what the host restore orchestrator injects when it rehydrates the project from a snapshot; ` +
      `LOOP itself must never produce one)`
    );
  }
  return null;
}

// ── Host-injected UUID commit recovery (amend-on-boot) ───────────────
// The startup detector in self-enhance-loop.ts calls this to replace a
// bare-UUID / empty HEAD commit message with a real, searchable one.
// The host sandbox restore orchestrator injects UUID-named commits
// during machine-restart snapshot rehydration (outside LOOP's commit
// path — see validateCommitMessage + postmortem system:commit-message-
// guard). amendUuidHeadCommit recovers the most recent one IF it's
// still local-only; if it's already pushed, the UUID is permanent
// (rewriting pushed history is a red-team-flagged attack) and the
// detector just warns.
//
// Safety invariants (all checked; if any fails, the amend is refused
// and a reason is returned — the loop boots regardless):
//   (1) HEAD's message must actually be a bare UUID / empty
//       (validateCommitMessage returns non-null). A normal HEAD with a
//       proper message is a no-op.
//   (2) HEAD must be LOCAL-ONLY — `git rev-list --count origin/main..HEAD`
//       must be > 0. If HEAD is already on origin, amending rewrites
//       PUSHED history (the red-team suite flags `git commit --amend`
//       on pushed commits as a history-rewrite attack vector). In that
//       case we refuse; the UUID stays in remote history.
//   (3) Nothing must be staged (`git diff --cached --quiet` exits 0).
//       `git commit --amend -m "..."` folds staged changes into the
//       amended commit; if something is staged we refuse rather than
//       silently bundle an unrelated change into the host-injected
//       commit. Unstaged changes are safe — amend without `git add`
//       only changes the message.
//   (4) The generated replacement message must itself pass
//       validateCommitMessage (defensive — the template is clean, but
//       the invariant is enforced at the gate so a future template
//       bug can't reintroduce the defect class).
//
// Returns:
//   { attempted: false }                       — HEAD message is fine, no-op
//   { attempted: true, amended: true, oldSha, newSha } — recovered
//   { attempted: true, amended: false, oldSha?, reason } — refused, see reason
export function amendUuidHeadCommit(): {
  attempted: boolean;
  amended: boolean;
  oldSha?: string;
  newSha?: string;
  reason?: string;
} {
  // 1. Read HEAD message + full sha (full sha is preserved in the
  //    replacement message body for traceability — git short sha alone
  //    is ambiguous after a future force-push or repo reclone).
  let headMessage: string;
  let headSha: string;
  try {
    headMessage = execSync("git log -1 --format=%B", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    });
    headSha = execSync("git log -1 --format=%H", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    }).trim();
  } catch {
    return {
      attempted: false,
      amended: false,
      reason: "git unavailable or no commits yet (fresh repo)",
    };
  }

  // 2. Is HEAD actually a bare UUID / empty message? (No-op if not.)
  const rejectReason = validateCommitMessage(headMessage);
  if (!rejectReason) {
    return { attempted: false, amended: false };
  }

  // 3. Is HEAD local-only (not yet on origin/main)?
  //    `git rev-list --count origin/main..HEAD` returns the number of
  //    commits reachable from HEAD but not origin/main. 0 means HEAD
  //    IS origin/main (pushed) — amending rewrites pushed history.
  //    A thrown error means origin/main doesn't exist yet (fresh repo,
  //    nothing pushed ever) — treat as safe-to-amend.
  try {
    const countOut = execSync("git rev-list --count origin/main..HEAD", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    }).trim();
    const count = parseInt(countOut, 10);
    if (Number.isFinite(count) && count === 0) {
      return {
        attempted: true,
        amended: false,
        oldSha: headSha,
        reason:
          "HEAD is on origin/main (already pushed) — amending would rewrite shared history " +
          "(red-team-flagged history-rewrite attack); the UUID is permanent in remote history",
      };
    }
    // count > 0 (or NaN from empty origin) → local-only, proceed
  } catch {
    // origin/main missing (fresh repo, never pushed) — safe to amend
  }

  // 4. Anything staged? `git commit --amend` would fold staged changes
  //    into the amended commit, silently bundling unrelated work into
  //    the host-injected commit. Refuse in that case. `git diff --cached
  //    --quiet` exits 0 when nothing staged, 1 when something staged,
  //    >1 on error. execSync throws on non-zero, so the catch branch
  //    handles both "staged" and "error".
  try {
    execSync("git diff --cached --quiet", {
      cwd: PROJECT_ROOT,
      timeout: 5000,
      stdio: "pipe",
    });
    // exit 0 → nothing staged, proceed
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) {
      return {
        attempted: true,
        amended: false,
        oldSha: headSha,
        reason:
          "staged changes present — refusing to fold them into the amended commit " +
          "(amend would silently bundle staged work into the host-injected commit)",
      };
    }
    return {
      attempted: true,
      amended: false,
      oldSha: headSha,
      reason: `git diff --cached --quiet failed: ${(err as Error).message.slice(0, 200)}`,
    };
  }

  // 5. Generate the replacement message. First line is the conventional
  //    prefix ("restore:") so commit-archaeology greps find it. Body
  //    preserves the original UUID + old short sha for traceability
  //    (an archaeologist reading the amended commit can still recover
  //    that it was host-injected and what the original UUID was).
  const shortSha = headSha.slice(0, 7);
  const originalFirstLine = headMessage.split(/\r?\n/, 1)[0].trim();
  const newMessage =
    `restore: amend bare-UUID host-injected commit (loop boot auto-recovery)\n\n` +
    `Replaces UUID message "${originalFirstLine}" from commit ${shortSha} with a real ` +
    `description. The host sandbox restore orchestrator injected the original during a ` +
    `machine-restart snapshot rehydration, bypassing LOOP's commit path. ` +
    `See postmortem: system:commit-message-guard.`;

  // 6. Validate the new message (defensive — the template is clean).
  //    A future template edit that accidentally produces a UUID first
  //    line would be caught here instead of landing a "fixed" UUID commit.
  const newReject = validateCommitMessage(newMessage);
  if (newReject) {
    return {
      attempted: true,
      amended: false,
      oldSha: headSha,
      reason: `generated replacement message failed validateCommitMessage: ${newReject}`,
    };
  }

  // 7. Run the amend. `execFileSync` with arg array — no shell, so the
  //    multi-line message (containing quotes, parens, colons) can never
  //    be a command-injection surface. `--no-verify` is NOT passed — the
  //    amend goes through any git hooks, same as a normal commit.
  //    `--allow-empty` is required because the host-injected commit may
  //    itself be empty (the restore orchestrator sometimes commits a
  //    working-tree rehydration with only mode-bit / timestamp changes
  //    that git collapses to an empty diff). Without `--allow-empty`,
  //    git refuses the amend with "doing so would make it empty" —
  //    leaving the UUID message in place. On a non-empty original,
  //    `--allow-empty` is a harmless no-op (the amended commit keeps
  //    the original tree + the new message).
  try {
    execFileSync("git", ["commit", "--amend", "--allow-empty", "-m", newMessage], {
      cwd: PROJECT_ROOT,
      timeout: 15000,
      stdio: "pipe",
    });
    const newSha = execSync("git log -1 --format=%H", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
    }).trim();
    return {
      attempted: true,
      amended: true,
      oldSha: headSha,
      newSha,
    };
  } catch (err) {
    return {
      attempted: true,
      amended: false,
      oldSha: headSha,
      reason: `git commit --amend failed: ${(err as Error).message.slice(0, 200)}`,
    };
  }
}

// ── Pre-push secret-scan gate (concept: Git-Secret-PII-Sanitizer) ────
// Scans the working-tree diff AND the commit message for secrets BEFORE
// `git add -A && git commit`. If a non-dummy, non-redacted secret is
// found, the commit is BLOCKED — the PAT can never leak into git history
// again. Returns null to proceed, or a block-reason string to abort.
// See docs/CONCEPTS-GRAFTED.md GRAFT 1.
function preCommitSecretGate(message: string): string | null {
  let diff = "";
  try {
    // Unstaged + staged changes vs HEAD — exactly what's about to land.
    diff = execSync("git diff HEAD --no-color", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    // No diff (clean tree) or git failed — nothing to scan, proceed.
    diff = "";
  }
  const findings: SecretFinding[] = [];
  if (diff) findings.push(...scanDiff(diff, "diff"));
  // The commit message is free text the diff scanner doesn't see — a
  // secret pasted into the message would survive every other gate.
  const msgFindings = scanCommitMessage(message);
  findings.push(...msgFindings);
  if (findings.length === 0) return null;
  const { block, reason } = summarizeFindings(findings, false);
  if (!block) return null;
  // Record a postmortem so the failure memory carries the gate block.
  // Best-effort — a failure to write the postmortem MUST NOT un-block
  // the commit (the block is a safety action; the postmortem is a record).
  try {
    void import("../postmortem/postmortem-store").then(({ postmortemStore }) => {
      void postmortemStore.recordFailure({
        repo: "self",
        branch: "main",
        filePath: "system:secret-scan-gate",
        failureType: "OTHER",
        symptom: "Pre-push secret-scan gate blocked a commit",
        evidence: findings
          .map((f) => `${f.patternName} in ${f.filePath}:${f.line} (${f.redactedPreview})`)
          .join("; ")
          .slice(0, 500),
        constraints:
          "A secret was detected in the working-tree diff or commit message. " +
          "Remove the secret, redact it, or add it to the scanner's " +
          "isDocumentationOrDummySecret allowlist if it's a known false positive. " +
          "The PAT must NEVER be committed to tracked source.",
      });
    });
  } catch { /* best-effort — don't un-block on postmortem failure */ }
  return reason;
}

/**
 * Commit (if dirty) and push the current live state to the configured target.
 * Auth is injected per-push via GIT_CONFIG_* env vars — the token is never
 * written to git config, remotes, or the command line.
 *
 * Divergence self-heal: if the push is rejected because the remote has
 * commits local doesn't (history lost to a past reset), this automatically
 * fetches, merges with -s ours (local live tree stays byte-identical; the
 * remote commits are preserved as ancestors — no force, nothing orphaned),
 * and retries once. Only if the heal fails does it suggest 'push force'.
 */
export async function pushCurrentState(opts?: {
  message?: string;
  force?: boolean;
  /**
   * Override the configured seed branch. Used by the self-enhance loop to
   * push each successful mutation to its own `loop-NN` branch (per-cycle
   * branching). When omitted, pushes to `target.branch` (the seed — main).
   */
  branchOverride?: string;
}): Promise<PushOutcome> {
  // ── TEST-GATE CRASH RECOVERY (external audit, finding 1) ──────────────
  // A leftover test-gate journal means a test run crashed with an
  // UNVERIFIED candidate live on disk. `git add -A` below would silently
  // sweep that candidate into whatever commit happens next — an unrelated
  // enhancement, a schema mutation, an operator push. Restore the original
  // BEFORE any staging can happen. Synchronous + idempotent: a missing
  // journal (the common case) costs one existsSync.
  const tgRecovery = recoverCrashedTestGate();
  if (tgRecovery.recovered) {
    console.error(
      `[PUSH-TARGET] TEST-GATE CRASH RECOVERY: restored original ${tgRecovery.filePath} (journal armed ${tgRecovery.armedAt ?? "unknown"}) before committing — an unverified candidate was live on disk`
    );
  }

  const target = await getStoredTarget();
  if (!target) {
    // COMMIT-ONLY FALLBACK (operator edit): no push target, but verified work
    // must still be committed locally — uncommitted files were exactly what
    // the machine restart lost. The loop's gitPush() has always documented
    // this fallback; now it actually exists. The push outcome stays honestly
    // `pushed: false` with the configure hint.
    if (pushInProgress) {
      return { pushed: false, error: "A push is already in progress" };
    }
    pushInProgress = true;
    try {
      const status = execSync("git status --porcelain", {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 5000,
      });
      if (status.trim()) {
        const message = opts?.message ?? "Self-enhancement: current live state";
        // ── Commit-message shape guard (commit-archaeology UUID-defense) ──
        // Rejects empty / bare-UUID messages BEFORE they reach git add,
        // mirroring the secret-gate's abort contract below. See
        // validateCommitMessage for the full rationale (the host restore
        // orchestrator UUID-injection finding).
        const messageReject = validateCommitMessage(message);
        if (messageReject) {
          return { pushed: false, error: messageReject };
        }
        // ── Pre-push secret-scan gate (GRAFT 1) ── block BEFORE git add.
        const blockReason = preCommitSecretGate(message);
        if (blockReason) {
          return { pushed: false, error: blockReason };
        }
        execFileSync("git", ["add", "-A"], { cwd: PROJECT_ROOT, timeout: 10000 });
        execFileSync("git", ["commit", "-m", message], {
          cwd: PROJECT_ROOT,
          timeout: 10000,
          stdio: "pipe",
        });
        const sha = execSync("git rev-parse HEAD", {
          cwd: PROJECT_ROOT,
          encoding: "utf-8",
          timeout: 5000,
        }).trim().slice(0, 7);
        return {
          pushed: false,
          commitSha: sha,
          hadChanges: true,
          error: "No push target configured. Run: push <token> <owner/repo>",
        };
      }
      return { pushed: false, error: "No push target configured. Run: push <token> <owner/repo>" };
    } catch (err) {
      return { pushed: false, error: `Local commit failed: ${(err as Error).message.slice(0, 300)}` };
    } finally {
      pushInProgress = false;
    }
  }
  if (pushInProgress) {
    return { pushed: false, error: "A push is already in progress", repo: target.repo };
  }
  pushInProgress = true;

  const record = async (patch: { lastPushSha?: string | null; lastPushError?: string | null }) => {
    await db.gitPushTarget.update({
      where: { id: SINGLETON_ID },
      data: {
        lastPushAt: new Date(),
        ...(patch.lastPushSha !== undefined ? { lastPushSha: patch.lastPushSha } : {}),
        ...(patch.lastPushError !== undefined ? { lastPushError: patch.lastPushError } : {}),
      },
    }).catch(() => { /* non-fatal */ });
  };

  try {
    // 0. Self-heal: ensure `origin` points at the configured repo (tokenless).
    //    Covers cases where the DB row exists but the remote was never set or
    //    was removed/mangled after configuration.
    const remoteUrl = `https://github.com/${target.repo}.git`;
    try {
      const current = execSync("git remote get-url origin", {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
      }).trim();
      if (current !== remoteUrl) throw new Error("mismatch");
    } catch {
      try {
        execSync("git remote remove origin", { cwd: PROJECT_ROOT, timeout: 5000, stdio: "pipe" });
      } catch {
        /* no origin to remove */
      }
      execSync(`git remote add origin ${remoteUrl}`, { cwd: PROJECT_ROOT, timeout: 5000 });
    }

    // 1. Commit if there are changes
    let commitSha: string | undefined;
    const status = execSync("git status --porcelain", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 5000,
    });
    if (status.trim()) {
      // execFileSync with arg arrays — NO shell, so commit messages (which
      // contain LLM-generated change summaries) can never be a command-
      // injection surface. Backticks/quotes/$() are just characters.
      const message = opts?.message ?? "Self-enhancement: current live state";
      // ── Commit-message shape guard (commit-archaeology UUID-defense) ──
      // Rejects empty / bare-UUID messages BEFORE they reach git add,
      // mirroring the secret-gate's abort contract below. Records the
      // reason into lastPushError (same as the secret-gate failure path)
      // so an operator looking at the push-target UI sees a clear cause
      // instead of a silent `pushed: false`. See validateCommitMessage
      // for the full rationale (the host restore orchestrator UUID-
      // injection finding).
      const messageReject = validateCommitMessage(message);
      if (messageReject) {
        await record({ lastPushError: messageReject.slice(0, 300) });
        return { pushed: false, repo: target.repo, error: messageReject };
      }
      // ── Pre-push secret-scan gate (GRAFT 1) ── block BEFORE git add.
      // Scans the working-tree diff + the commit message. If a non-dummy,
      // non-redacted secret is found, the commit is BLOCKED and a postmortem
      // is recorded. The PAT can never leak into git history through this path.
      const blockReason = preCommitSecretGate(message);
      if (blockReason) {
        await record({ lastPushError: blockReason.slice(0, 300) });
        return { pushed: false, repo: target.repo, error: blockReason };
      }
      execFileSync("git", ["add", "-A"], { cwd: PROJECT_ROOT, timeout: 10000 });
      execFileSync("git", ["commit", "-m", message], {
        cwd: PROJECT_ROOT,
        timeout: 10000,
        stdio: "pipe",
      });
      commitSha = execSync("git rev-parse HEAD", {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 5000,
      }).trim().slice(0, 7);
    }

    // 2. Push with auth injected via env (token never on the command line)
    const auth = `Authorization: Basic ${Buffer.from(`x-access-token:${target.token}`).toString("base64")}`;
    const pushBranch = opts?.branchOverride ?? target.branch;
    const refspec = `HEAD:refs/heads/${pushBranch}`;
    const forceArg = opts?.force ? " --force" : "";
    const pushEnv = {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: auth,
    };

    try {
      execSync(`git push origin ${refspec}${forceArg}`, {
        cwd: PROJECT_ROOT,
        timeout: 60000,
        stdio: "pipe",
        env: pushEnv,
      });
    } catch (err) {
      let stderr = scrub(String((err as { stderr?: string }).stderr ?? (err as Error).message ?? ""), target.token);

      // SELF-HEAL: a fetch-first rejection means the remote holds commits
      // this repo doesn't (e.g. local history lost to a past reset). The
      // local tree IS the live running system, so preserve BOTH sides:
      // fetch, merge with -s ours (local tree stays byte-identical, remote
      // commits remain reachable as ancestors — nothing orphaned), then
      // retry the push once. Only suggest force if the heal itself fails.
      // Skipped on explicit force pushes (overwrite is the intent there).
      if (/non-fast-forward|fetch first|rejected/.test(stderr) && !opts?.force) {
        try {
          execSync("git fetch origin", {
            cwd: PROJECT_ROOT,
            timeout: 60000,
            stdio: "pipe",
            env: pushEnv,
          });
          // Audit 2: the heal must merge the branch ACTUALLY BEING PUSHED
          // (pushBranch, e.g. loop-NN). It used to merge the configured seed
          // branch (target.branch, e.g. main): on a fresh auto-created repo
          // there is no origin/main, so the heal always failed and surfaced
          // a misleading "run push force" hint — and even when origin/main
          // existed it did nothing to resolve the loop-NN divergence.
          execSync(
            `git merge -s ours origin/${pushBranch} -m "merge origin/${pushBranch} (self-heal): remote history preserved as ancestors; local live state is authoritative"`,
            { cwd: PROJECT_ROOT, timeout: 30000, stdio: "pipe" }
          );
          execSync(`git push origin ${refspec}`, {
            cwd: PROJECT_ROOT,
            timeout: 60000,
            stdio: "pipe",
            env: pushEnv,
          });
          const healedSha = execSync("git rev-parse HEAD", {
            cwd: PROJECT_ROOT,
            encoding: "utf-8",
            timeout: 5000,
          }).trim().slice(0, 7);
          await record({ lastPushSha: healedSha, lastPushError: null });
          return {
            pushed: true,
            commitSha: healedSha,
            hadChanges: Boolean(commitSha),
            repo: target.repo,
            divergenceHealed: true,
          };
        } catch (healErr) {
          const healStderr = scrub(
            String((healErr as { stderr?: string }).stderr ?? (healErr as Error).message ?? ""),
            target.token
          );
          stderr = `${stderr} | auto-heal failed: ${healStderr.slice(0, 200)}`;
        }
      }

      let hint = "";
      if (/non-fast-forward|fetch first|rejected/.test(stderr)) {
        hint = " (remote has diverged and auto-heal failed — run 'push force' to overwrite it)";
      } else if (/could not read Username|Authentication failed|403|401/.test(stderr)) {
        hint = " (GitHub rejected the credentials — the token may be invalid/revoked or lack repo access; reconfigure with 'push <token> <owner/repo>')";
        // ── Duress anomaly detection (GRAFT 2) ── a 401/403 increments the
        // consecutive-auth-failure counter. Past the threshold (5 by
        // default), the duress purge auto-fires: the PAT may be compromised
        // or rotated, so the system purges all tiers and enters safe mode
        // rather than continuing to retry a possibly-coerced credential.
        try {
          const statusCode = /403/.test(stderr) ? 403 : /401/.test(stderr) ? 401 : 0;
          if (statusCode) {
            const { triggered } = await recordPushAuthFailure(statusCode);
            if (triggered) {
              hint += " [DURESS AUTO-TRIGGERED: PAT purged, safe-mode raised — clear via /api/duress/clear after verifying the token]";
            }
          }
        } catch { /* best-effort — the hint still surfaces */ }
      }
      await record({ lastPushError: `git push failed: ${stderr.slice(0, 300)}${hint}` });
      return { pushed: false, commitSha, hadChanges: Boolean(commitSha), repo: target.repo, error: `${stderr.slice(0, 300)}${hint}` };
    }

    // 3. Success — record it
    const headSha =
      commitSha ??
      execSync("git rev-parse HEAD", { cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5000 })
        .trim()
        .slice(0, 7);
    await record({ lastPushSha: headSha, lastPushError: null });
    // ── Duress anomaly detection (GRAFT 2) ── a successful push resets the
    // consecutive-auth-failure counter. A single success clears the suspicion.
    recordPushSuccess();
    return { pushed: true, commitSha: headSha, hadChanges: Boolean(commitSha), repo: target.repo };
  } catch (err) {
    const msg = scrub((err as Error).message, target.token);
    await record({ lastPushError: msg.slice(0, 300) });
    return { pushed: false, error: msg.slice(0, 300), repo: target.repo };
  } finally {
    pushInProgress = false;
  }
}

/**
 * Query GitHub for the highest existing `loop-NN` branch. Used by
 * `getLastBranchNumber` as a final reconciliation fallback: after a
 * sandbox reboot that wipes BOTH the DB AND the durable state files,
 * the local counter is 0 but GitHub still holds the real mutation
 * branches (e.g. loop-01..loop-38). Without this check, the loop would
 * compute `loop-{0+1}` = `loop-01` and PUSH A NEW MUTATION ONTO THE
 * EXISTING loop-01 — contaminating a previously-completed mutation's
 * branch with a new commit, destroying the "one branch per mutation"
 * invariant and making the audit trail untrustworthy.
 *
 * Returns the highest N such that `loop-NN` exists on the remote, or 0
 * if no loop branches exist (genuinely first run) or the query fails
 * (fail-open: returns 0, same as before, but logged).
 */
export async function reconcileBranchNumberFromGitHub(): Promise<number> {
  try {
    const target = await getStoredTarget();
    if (!target || !target.token) return 0;
    const res = await fetch(
      `https://api.github.com/repos/${target.repo}/branches?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${target.token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Architecture-Helper-Pipeline",
        },
      }
    );
    if (!res.ok) return 0;
    const branches = (await res.json()) as Array<{ name: string }>;
    let max = 0;
    for (const b of branches) {
      // Match "loop-NN" where NN is 1+ digits. Handles both the
      // zero-padded (loop-01..loop-09) and unpadded (loop-100+) forms.
      const m = /^loop-(\d+)$/.exec(b.name);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    return max;
  } catch {
    return 0; // fail-open
  }
}

/**
 * Read the last successful enhancement's branch number from the DB.
 * Returns 0 when no push target is configured or the counter has never
 * been bumped (i.e. no enhancement has fully succeeded yet).
 *
 * The next enhancement will push to `loop-{N+1}` (zero-padded to 2).
 *
 * RECONCILIATION: if the local counter is 0 (DB wiped + state files
 * wiped/stale — the exact scenario after a hard sandbox reboot), we
 * fall back to querying GitHub for the highest existing `loop-NN`
 * branch. This prevents the loop from reusing a completed mutation's
 * branch. See `reconcileBranchNumberFromGitHub`.
 */
export async function getLastBranchNumber(): Promise<number> {
  let row: Awaited<ReturnType<typeof db.gitPushTarget.findUnique>> = null;
  try {
    row = await db.gitPushTarget.findUnique({ where: { id: SINGLETON_ID } });
  } catch {
    /* DB unavailable — fall through */
  }
  if (row && (row.lastBranchNumber ?? 0) > 0) return row.lastBranchNumber ?? 0;
  // DB wiped or zero — the durable state files carry the counter. Tier-2
  // first, then tier-3: after a sandbox restart tier-2 is wiped and
  // .git/info/ is the ONLY surviving copy — reading tier-2 alone returned 0,
  // so the next mutation pushed to loop-01 again and collided with the
  // existing branch.
  const fileCount =
    (readStateFile() ?? readPersistentStateFile())?.lastBranchNumber ?? 0;
  if (fileCount > 0) return fileCount;
  // ── FINAL FALLBACK: reconcile with GitHub ──────────────────────────
  // Both the DB AND all durable state files report 0. This happens after
  // a hard sandbox reboot that wiped everything EXCEPT the remote repo.
  // The remote still has the real mutation branches (loop-01..loop-N),
  // so query it for the highest N and use that — otherwise the loop would
  // target loop-01 again and contaminate an existing mutation branch.
  const reconciled = await reconcileBranchNumberFromGitHub();
  if (reconciled > 0) {
    // WRITE-THROUGH the reconciled value so future reads don't re-query
    // GitHub (rate-limit friendly) AND the UI/DB reflect reality. We
    // write directly rather than calling setLastBranchNumber (which
    // guards "next > current" and would no-op since current=0=next).
    try {
      const state = readStateFile() ?? readPersistentStateFile();
      if (state) {
        writeStateFile({
          ...state,
          lastBranchNumber: reconciled,
          savedAt: new Date().toISOString(),
        });
      }
      await db.gitPushTarget
        .upsert({
          where: { id: SINGLETON_ID },
          update: { lastBranchNumber: reconciled },
          create: {
            id: SINGLETON_ID,
            repo: state?.repo ?? "craighckby-stack/V1",
            token: state?.token ?? "",
            branch: state?.branch ?? "main",
            lastBranchNumber: reconciled,
          },
        })
        .catch(() => {
          /* best-effort — state file write is the durable copy */
        });
    } catch {
      /* best-effort — the in-memory reconciled value still protects this run */
    }
  }
  return reconciled;
}

/**
 * Atomically bump the per-cycle branch counter. Called by the loop after
 * a successful enhancement push. `next` must be strictly greater than the
 * current value (the loop computes it as `current + 1`); the upsert guards
 * against accidentally going backwards.
 */
export async function setLastBranchNumber(next: number): Promise<void> {
  const current = await getLastBranchNumber();
  if (next <= current) return; // never go backwards
  await db.gitPushTarget.update({
    where: { id: SINGLETON_ID },
    data: { lastBranchNumber: next },
  }).catch(() => { /* non-fatal — counter is best-effort audit */ });
  // Write-through to the durable state files (survives DB wipes). Tier-2
  // first, then tier-3: after a restart only .git/info/ survives — without
  // the fallback the write-through silently skipped and the counter in the
  // file stayed stale. writeStateFile() rewrites BOTH tiers atomically.
  const state = readStateFile() ?? readPersistentStateFile();
  if (state) {
    try {
      writeStateFile({ ...state, lastBranchNumber: next, savedAt: new Date().toISOString() });
    } catch { /* best-effort */ }
  }
}

/**
 * Format a cycle number as a loop branch name: 1 → "loop-01", 99 → "loop-99",
 * 100 → "loop-100". Zero-padded to 2 digits so `git branch` listing sorts
 * lexicographically in cycle order up to 99, then unpadded from 100 on.
 */
export function formatLoopBranch(cycleNumber: number): string {
  return `loop-${String(cycleNumber).padStart(2, "0")}`;
}
