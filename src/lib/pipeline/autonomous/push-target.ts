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
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";

const PROJECT_ROOT = "/home/z/my-project";
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

function writeStateFile(state: LoopPushState): void {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, STATE_FILE); // atomic — never a half-written config
}

/** Seed the DB from the state file if the DB row is missing (the
 *  machine-restart recovery path). Best-effort, idempotent. */
async function seedDbFromStateFile(): Promise<LoopPushState | null> {
  const state = readStateFile();
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

/** Read the stored target (with token) — server-side only. */
async function getStoredTarget(): Promise<StoredTarget | null> {
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

  // 3. Persist config (upsert the singleton row + durable state file)
  await db.gitPushTarget.upsert({
    where: { id: SINGLETON_ID },
    update: { repo, token, branch: "main", createdRepo: created, lastPushError: null },
    create: { id: SINGLETON_ID, repo, token, branch: "main", createdRepo: created },
  });
  // Write-through to the durable state file (survives DB wipes). The branch
  // counter is preserved from the existing file so a re-configure doesn't
  // reset loop-NN numbering mid-run.
  const prevState = readStateFile();
  try {
    writeStateFile({
      repo,
      token,
      branch: "main",
      createdRepo: created,
      lastBranchNumber: prevState?.repo === repo ? prevState.lastBranchNumber : 0,
      savedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Non-fatal: the DB row is written; the file is the durability bonus.
    console.error("[PUSH-TARGET] failed to write state file:", err);
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

/** Clear the push target: delete the DB row, remove the durable state
 *  file, and remove the remote. */
export async function clearPushTarget(): Promise<{ cleared: boolean }> {
  await db.gitPushTarget.deleteMany({ where: { id: SINGLETON_ID } });
  try { rmSync(STATE_FILE, { force: true }); } catch { /* best-effort */ }
  try {
    execSync("git remote remove origin", { cwd: PROJECT_ROOT, timeout: 5000, stdio: "pipe" });
  } catch {
    /* no origin to remove */
  }
  return { cleared: true };
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
      } else if (/could not read Username|Authentication failed|403/.test(stderr)) {
        hint = " (GitHub rejected the credentials — the token may be invalid/revoked or lack repo access; reconfigure with 'push <token> <owner/repo>')";
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
 * Read the last successful enhancement's branch number from the DB.
 * Returns 0 when no push target is configured or the counter has never
 * been bumped (i.e. no enhancement has fully succeeded yet).
 *
 * The next enhancement will push to `loop-{N+1}` (zero-padded to 2).
 */
export async function getLastBranchNumber(): Promise<number> {
  let row: Awaited<ReturnType<typeof db.gitPushTarget.findUnique>> = null;
  try {
    row = await db.gitPushTarget.findUnique({ where: { id: SINGLETON_ID } });
  } catch {
    /* DB unavailable — fall through */
  }
  if (row) return row.lastBranchNumber ?? 0;
  // DB wiped — the durable state file carries the counter.
  return readStateFile()?.lastBranchNumber ?? 0;
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
  // Write-through to the durable state file (survives DB wipes).
  const state = readStateFile();
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
