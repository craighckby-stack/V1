/**
 * Git Push Target — persistent, authenticated GitHub push.
 *
 * The loop/chat-task commits evolving source and pushes it to GitHub as proof.
 * This module owns:
 *   - Persistent push target config (repo + token) in the DB (survives restarts)
 *   - Authenticated git push WITHOUT persisting the token in git config
 *     (auth is injected per-push via GIT_CONFIG_* env vars)
 *
 * Security: the token is stored in the local SQLite DB (untracked) and is
 * NEVER returned to the client. All error messages are scrubbed of the token.
 */

import { execSync } from "child_process";
import { db } from "@/lib/db";

const PROJECT_ROOT = "/home/z/my-project";
const SINGLETON_ID = "singleton";

export interface PushTargetPublic {
  configured: boolean;
  repo?: string;
  branch?: string;
  createdRepo?: boolean;
  lastPushAt?: string | null;
  lastPushSha?: string | null;
  lastPushError?: string | null;
}

export interface PushOutcome {
  pushed: boolean;
  commitSha?: string;
  hadChanges?: boolean;
  repo?: string;
  error?: string;
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

const MIN_TOKEN_LENGTH = 20;

function validTokenFormat(token: string): boolean {
  return token.length >= MIN_TOKEN_LENGTH && !/\s/.test(token);
}

/** Read the stored target (with token) — server-side only. */
async function getStoredTarget(): Promise<StoredTarget | null> {
  const row = await db.gitPushTarget.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return null;
  return { repo: row.repo, token: row.token, branch: row.branch };
}

/** Public view of the push target — token never included. */
export async function getPushTargetPublic(): Promise<PushTargetPublic> {
  const row = await db.gitPushTarget.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return { configured: false };
  return {
    configured: true,
    repo: row.repo,
    branch: row.branch,
    createdRepo: row.createdRepo,
    lastPushAt: row.lastPushAt?.toISOString() ?? null,
    lastPushSha: row.lastPushSha,
    lastPushError: row.lastPushError,
  };
}

/**
 * Configure the push target: verify the token, verify the repo,
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

  // 1. Verify the token
  const userRes = await ghFetch("/user", token);
  const UNAUTHORIZED_STATUS = 401;
  if (userRes.status === UNAUTHORIZED_STATUS) {
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
  const NOT_FOUND_STATUS = 404;
  if (repoRes.status === NOT_FOUND_STATUS) {
    const createIfMissing = opts.createIfMissing ?? true;
    if (!createIfMissing) {
      throw new Error(
        `Repo ${repo} not found. Create it manually on github.com, or enable auto-create.`
      );
    }

    const [owner, name] = repo.split("/");
    let createRes: Response;

    if (owner === login) {
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

    const CREATED_STATUS = 201;
    if (createRes.status === CREATED_STATUS) {
      created = true;
    } else if (createRes.status === FORBIDDEN_STATUS) {
      throw new Error(
        "GitHub refused to create the repo (403). Fine-grained PATs CANNOT create repos — use a classic PAT with 'repo' scope, or create the repo manually first."
      );
    } else if (createRes.status === 404) {
      throw new Error(
        `Owner '${owner}' not found (404). For org repos, the token must administer that org.`
      );
    } else if (createRes.status === 422) {
      throw new Error(`Repo ${repo} exists but is not accessible with this token (422).`);
    } else {
      const body = (await createRes.json().catch(() => ({}))) as { message?: string };
      throw new Error(`Failed to create repo ${repo}: ${body.message ?? `HTTP ${createRes.status}`}`);
    }
  } else if (!repoRes.ok) {
    const body = (await repoRes.json().catch(() => ({}))) as { message?: string };
    throw new Error(`Repo check failed for ${repo}: ${body.message ?? `HTTP ${repoRes.status}`}`);
  }

  // 3. Persist config
  await db.gitPushTarget.upsert({
    where: { id: SINGLETON_ID },
    update: { repo, token, branch: "main", createdRepo: created, lastPushError: null },
    create: { id: SINGLETON_ID, repo, token, branch: "main", createdRepo: created },
  });

  // 4. Point `origin` at the tokenless URL
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

/** Clear the push target. */
export async function clearPushTarget(): Promise<{ cleared: boolean }> {
  await db.gitPushTarget.deleteMany({ where: { id: SINGLETON_ID } });
  try {
    execSync("git remote remove origin", { cwd: PROJECT_ROOT, timeout: 5000, stdio: "pipe" });
  } catch {
    // No origin to remove or failed to remove — non-critical
  }
  return { cleared: true };
}

/**
 * Commit (if dirty) and push the current live state to the configured target.
 * Auth is injected per-push via GIT_CONFIG_* env vars — the token is never
 * written to git config, remotes, or the command line.
 */
export async function pushCurrentState(opts?: {
  message?: string;
  force?: boolean;
}): Promise<PushOutcome> {
  const target = await getStoredTarget();
  if (!target) {
    return { pushed: false, error: "No push target configured" };
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
    // 0. Self-heal: ensure `origin` points at the configured repo
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
        // No origin to remove or failed to remove — non-critical
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
      const message = (opts?.message ?? "Self-enhancement: current live state").replace(/"/g, '\\"').slice(0, 300);
      execSync("git add -A", { cwd: PROJECT_ROOT, timeout: 10000 });
      // Use a temp file for the commit message to handle multi-line safely
      const msgFile = "/tmp/commit-msg.txt";
      const { writeFileSync, unlinkSync } = await import("fs");
      writeFileSync(msgFile, (opts?.message ?? "Self-enhancement: current live state"), "utf-8");
      try {
        execSync(`git commit -F ${msgFile}`, { cwd: PROJECT_ROOT, timeout: 10000, stdio: "pipe" });
      } finally {
        try { unlinkSync(msgFile); } catch { /* ignore temp file cleanup */ }
      }
      commitSha = execSync("git rev-parse HEAD", {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 5000,
      }).trim().slice(0, 7);
    }

    // 2. Push with auth injected via env
    const auth = `Authorization: Basic ${Buffer.from(`x-access-token:${target.token}`).toString("base64")}`;
    const refspec = `HEAD:refs/heads/${target.branch}`;
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
      const stderr = scrub(String((err as { stderr?: string }).stderr ?? (err as Error).message ?? ""), target.token);
      let hint = "";
      if (/non-fast-forward|fetch first|rejected/.test(stderr)) {
        hint = " (remote has diverged — force-push required)";
      } else if (/could not read Username|Authentication failed|403/.test(stderr)) {
        hint = " (GitHub rejected the credentials — token may be invalid/revoked)";
      }
      await record({ lastPushError: `git push failed: ${stderr.slice(0, 300)}${hint}` });
      return { pushed: false, commitSha, hadChanges: Boolean(commitSha), repo: target.repo, error: `${stderr.slice(0, 300)}${hint}` };
    }

    // 3. Success
    const headSha =
      commitSha ??
      execSync("git rev-parse HEAD", { cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5000 })
        .trim()
        .slice(0, 7);
    await record({ lastPushSha: headSha, lastPushError: null });
    return { pushed: true, commitSha: headSha, hadChanges: Boolean(commitSha), repo: target.repo };
  } catch (err) {
    const msg = scrub((err as Error).message, target?.token ?? "");
    await record({ lastPushError: msg.slice(0, 300) });
    return { pushed: false, error: msg.slice(0, 300), repo: target?.repo };
  } finally {
    pushInProgress = false;
  }
}

const FORBIDDEN_STATUS = 403;