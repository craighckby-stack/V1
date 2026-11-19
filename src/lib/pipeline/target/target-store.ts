/**
 * Target Store — persistent configuration for external-target mode.
 *
 * Uses the SystemFlag KV table (the generic key/value store the duress
 * and hot-swap systems already use) so NO schema migration is needed —
 * important because the dev server and loop worker run against the live
 * DB and `db:push` mid-flight is operator-level risk.
 *
 * Keys:
 *   target-repo:config    → JSON TargetRepoConfig (repo, base branch)
 *   target-repo:last-run  → JSON TargetRunRecord (the honest audit trail)
 *
 * Token resolution: a client-supplied token wins (the /api/github/*
 * routes' contract via getUsableToken), else the SEALED push-target PAT
 * the operator already configured via [CONFIG] is reused (opened
 * server-side via getStoredTarget, NEVER returned to any client), else
 * null → unauthenticated access (public repos only, GitHub's 60 req/hr).
 *
 * This module is the ONLY place target-mode config lives. The runner and
 * the routes both go through it, so `target off` truly disconnects every
 * entry point at once.
 */

import { db } from "@/lib/db";
import { getStoredTarget } from "../autonomous/push-target";

export interface TargetRepoConfig {
  /** owner/name (normalized — no scheme, no .git suffix). */
  repo: string;
  /** Base branch mutations are derived from. null = repo default. */
  branch: string | null;
  updatedAt: string;
}

export type TargetRunStatus =
  | "pushed"
  | "rejected"
  | "no-work"
  | "dry-run"
  | "failed";

export interface TargetRunRecord {
  at: string;
  repo: string;
  status: TargetRunStatus;
  /** Target-repo-relative path attempted, when one was chosen. */
  file?: string;
  /** Branch the mutation landed on (pushed) or would have landed on. */
  branch?: string;
  commitSha?: string;
  /** Short honest reason for the status (gate name, error, …). */
  reason?: string;
}

const CONFIG_KEY = "target-repo:config";
const LAST_RUN_KEY = "target-repo:last-run";

/** Normalize "https://github.com/owner/name.git" → "owner/name". */
export function normalizeTargetRepo(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

/** owner/name — letters, digits, dot, dash, underscore; no "..", no spaces. */
export function validTargetRepoFormat(repo: string): boolean {
  if (!repo || repo.includes("..") || repo.length > 120) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo);
}

/** Branch ref sanity: no whitespace, no leading '-', no "..", ≤120 chars. */
export function validTargetBranchFormat(branch: string): boolean {
  if (!branch || branch.length > 120) return false;
  if (/[\s~^:?*[\\\u0000-\u001f]/.test(branch)) return false;
  if (branch.startsWith("-") || branch.endsWith(".lock") || branch.includes("..")) return false;
  return true;
}

/** Read the target config (null = not configured). */
export async function getTargetConfig(): Promise<TargetRepoConfig | null> {
  try {
    const row = await db.systemFlag.findUnique({ where: { key: CONFIG_KEY } });
    if (!row || !row.value) return null;
    const parsed = JSON.parse(row.value) as TargetRepoConfig;
    if (!parsed || !parsed.repo || !validTargetRepoFormat(parsed.repo)) {
      console.error(`Target config found but invalid format for repo: ${parsed?.repo || 'Unknown'}`);
      return null;
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`Failed to parse target config JSON for key ${CONFIG_KEY}:`, error);
    } else {
      console.error(`Database error while fetching target config ${CONFIG_KEY}:`, error);
    }
    return null;
  }
}

/** Validate + persist the target config. Throws with an honest message. */
export async function setTargetConfig(
  repoRaw: string | null | undefined,
  branch?: string | null
): Promise<TargetRepoConfig> {
  if (typeof repoRaw !== 'string') {
    throw new Error("Repository raw string must be a string to set target configuration.");
  }
  const repo = normalizeTargetRepo(repoRaw);
  if (!validTargetRepoFormat(repo)) {
    throw new Error(`Invalid repo format "${repoRaw}" — expected owner/name`);
  }
  let branchValue: string | null = null;
  if (branch !== undefined && branch !== null) {
    const b = String(branch).trim();
    if (b.length > 0) {
      if (!validTargetBranchFormat(b)) {
        throw new Error(`Invalid branch "${b}"`);
      } else {
        branchValue = b;
      }
    } else {
      // If branch was provided but empty/whitespace, treat as null (repo default)
      branchValue = null;
    }
  }
  
  const config: TargetRepoConfig = {
    repo,
    branch: branchValue,
    updatedAt: new Date().toISOString(),
  };
  await db.systemFlag.upsert({
    where: { key: CONFIG_KEY },
    update: {
      value: JSON.stringify(config),
      setBy: "target-mode",
      reason: "operator set target repository",
      updatedAt: new Date(),
    },
    create: {
      key: CONFIG_KEY,
      value: JSON.stringify(config),
      setBy: "target-mode",
      reason: "operator set target repository",
    },
  });
  return config;
}

/** Disconnect the target (idempotent). Returns true if a config existed. */
export async function clearTargetConfig(): Promise<boolean> {
  try {
    const existing = await db.systemFlag.findUnique({ where: { key: CONFIG_KEY } });
    if (!existing) return false;
    await db.systemFlag.delete({ where: { key: CONFIG_KEY } });
    return true;
  } catch (error) {
    console.error(`Failed to clear target configuration ${CONFIG_KEY}:`, error);
    return false;
  }
}

/** Append-only audit trail: the outcome of the last run attempt. */
export async function recordTargetRun(rec: TargetRunRecord): Promise<void> {
  try {
    await db.systemFlag.upsert({
      where: { key: LAST_RUN_KEY },
      update: {
        value: JSON.stringify(rec),
        setBy: "target-mode",
        reason: `run ${rec.status}`,
        updatedAt: new Date(),
      },
      create: {
        key: LAST_RUN_KEY,
        value: JSON.stringify(rec),
        setBy: "target-mode",
        reason: `run ${rec.status}`,
      },
    });
  } catch (error) {
    console.error(`Failed to record target run audit trail ${LAST_RUN_KEY}:`, error);
    // the audit trail must never crash a run that already completed
  }
}

export async function getTargetLastRun(): Promise<TargetRunRecord | null> {
  try {
    const row = await db.systemFlag.findUnique({ where: { key: LAST_RUN_KEY } });
    if (!row || !row.value) return null;
    return JSON.parse(row.value) as TargetRunRecord;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`Failed to parse last run record JSON for key ${LAST_RUN_KEY}:`, error);
    } else {
      console.error(`Database error while fetching last run record ${LAST_RUN_KEY}:`, error);
    }
    return null;
  }
}

/**
 * Resolve the GitHub credential for a target run:
 * client token → stored (sealed) push-target PAT → null (unauthenticated).
 * The token NEVER leaves the server; callers use it in Authorization
 * headers only.
 */
export async function resolveTargetToken(clientToken?: string): Promise<string | null> {
  const client = clientToken ?? "";
  if (client.length >= 8) return client;
  const stored = await getStoredTarget().catch(() => null);
  if (stored && stored.token && stored.token.length >= 8) return stored.token;
  return null;
}