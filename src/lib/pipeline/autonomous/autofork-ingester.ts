/**
 * autofork-ingester.ts — the loop learns from curated reference repos.
 *
 * WHAT THIS IS
 * ───────────
 * The auto-fork direction the operator mused about ("IBM deepseek
 * deepmind"): instead of the operator manually dropping files into
 * `dropbox/<system>/`, the loop AUTONOMOUSLY fetches curated
 * reference repos and ingests them through the SAME candidate →
 * verified → promoted lifecycle as the dropbox.
 *
 * This is the dropbox ingester generalized to a GitHub source. The
 * distill + seed logic is SHARED (exported from dropbox-ingester) so
 * both ingesters produce the same candidate-lesson shape; only the
 * source label + the file-fetch path differ.
 *
 * THE SEED LIST (operator-curated, the trust decision)
 * ───────────────────────────────────────────────────
 * `autofork-seeds.json` at the project root lists the reference repos
 * the operator vouches for. The default seed list is 3 well-known,
 * clearly-licensed repos (react, next.js, prisma). The operator edits
 * the file to add/remove repos. The loop CAN'T add repos to its own
 * seed list — the file is in the protected control surface (the loop
 * could learn from a repo the operator hasn't vetted, which is a
 * trust boundary the operator must own).
 *
 * DEDUP (the blob-sha manifest)
 * ────────────────────────────
 * A manifest at `.git/info/loop-autofork-manifest.json` records every
 * ingested (repo, path, blobSha) tuple. On each scan, the picker
 * skips files whose blobSha is already in the manifest. So re-running
 * a scan on a repo that hasn't changed is O(0) LLM calls — the
 * manifest dedupes by content hash, not by path.
 *
 * THE CURIOSITY DRIVE (the autonomous trigger)
 * ───────────────────────────────────────────
 * Auto-fork is wired to the curiosity drive (like the dropbox): when
 * the drive fires (the loop is bored + health is flat), it runs one
 * `ingestAutoFork` as part of the curious cycle. One repo per scan,
 * up to MAX_FILES_PER_REPO files — budget-capped so a 500-file repo
 * doesn't burn the LLM quota in one cycle.
 *
 * THE TRUST MODEL (identical to the dropbox)
 * ───────────────────────────────────────────
 * Candidate lessons seed as `source: "autofork"`, `system: <repo>`,
 * `kind: "judgment"`. The bandit scores them — helpful ones rise into
 * the prompt, harmful ones sink. Never PROCEDURE (permanent operating
 * constraint) — that's operator-promotion only. The autonomous
 * distiller's sourceCount filters to `source: "autonomous"` postmortems,
 * so auto-fork lessons never inflate the aggregate.
 *
 * LICENSE (the honest concern)
 * ────────────────────────────
 * The distill prompt explicitly says "Extract PATTERNS and PRINCIPLES,
 * never code snippets." The loop learns rules ("never remove error
 * handling"), not source. This is the same as a human reading a book
 * and learning patterns — fair use for learning. The candidate lessons
 * are general imperatives, not copied code. The operator reviews
 * promotions (a lesson only becomes a permanent PROCEDURE on operator
 * confirmation, never automatically).
 *
 * PERFORMANCE
 * ───────────
 * One GitHub tree fetch + up to MAX_FILES_PER_REPO file fetches + up
 * to MAX_FILES_PER_REPO LLM calls per scan. Capped at MAX_FILES_PER_REPO=3
 * and one repo per scan. Best-effort: any failure (API rate limit,
 * LLM unavailable, repo gone) skips that file/repo and continues.
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { db } from "@/lib/db";
import { PROJECT_ROOT } from "../core/paths";
import { atomicWriteFileSync } from "../core/atomic-file";
import {
  getRepoDefaultBranch,
  listTargetTree,
  fetchTargetFile,
} from "../target/target-github";
import { rankCandidateFilesBroad } from "../core/auto-picker";
import { resolveTargetToken } from "../target/target-store";
import { distillCandidateLessons, seedCandidateLesson } from "./dropbox-ingester";

/** The seed list (operator-curated). Tracked in git so it's versioned;
 *  the operator edits this file to add/remove reference repos. */
const SEEDS_PATH = join(PROJECT_ROOT, "autofork-seeds.json");

/** The dedup manifest. Lives in .git/info/ (wipe-proof, never tracked). */
const MANIFEST_PATH = join(PROJECT_ROOT, ".git/info/loop-autofork-manifest.json");

/** Max files to ingest per repo per scan (budget cap — the LLM call
 *  is the cost). 3 keeps one scan under ~15s even on a slow LLM. */
const MAX_FILES_PER_REPO = 3;

interface SeedEntry {
  repo: string;
  branch?: string;
  reason: string;
  enabled: boolean;
}

interface ManifestEntry {
  /** The blob sha at the fetched ref — the dedupe key. */
  blobSha: string;
  /** When this file was ingested (ISO). */
  ingestedAt: string;
  /** How many candidate lessons were distilled from it. */
  lessonsDistilled: number;
}

interface Manifest {
  /** Key: `${repo}/${path}` — the unique file identity. */
  [fileKey: string]: ManifestEntry;
}

interface AutoForkResult {
  scanned: number;
  reposScanned: number;
  filesIngested: number;
  lessonsDistilled: number;
  skipped: string[];
  errors: string[];
}

/** Read the seed list. Returns [] if the file is absent/unreadable. */
function readSeeds(): SeedEntry[] {
  if (!existsSync(SEEDS_PATH)) return [];
  try {
    const raw = readFileSync(SEEDS_PATH, "utf8");
    const parsed = JSON.parse(raw) as SeedEntry[];
    if (!Array.isArray(parsed)) {
      console.error(`[autofork-ingester] Seeds file ${SEEDS_PATH} content is not a JSON array.`);
      return [];
    }
    return parsed.filter((s): s is SeedEntry => typeof s.repo === "string" && s.enabled !== false);
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`[autofork-ingester] Failed to parse JSON from seeds file ${SEEDS_PATH}:`, error.message);
    } else if (error instanceof Error) {
      console.error(`[autofork-ingester] Failed to read or process seeds file ${SEEDS_PATH}:`, error.message);
    } else {
      console.error(`[autofork-ingester] Failed to read or process seeds file ${SEEDS_PATH}:`, String(error));
    }
    return [];
  }
}

/** Read the dedup manifest. Returns {} if absent/unreadable. */
function readManifest(): Manifest {
  try {
    if (!existsSync(MANIFEST_PATH)) return {};
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

/** Write the manifest atomically. Best-effort. */
function writeManifest(manifest: Manifest): void {
  try {
    mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
    atomicWriteFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  } catch {
    /* best-effort: manifest write failure doesn't stop ingestion */
  }
}

/** Scan the curated seed repos and ingest the highest-signal new files.
 *  Returns the ingest result. Best-effort: never throws.
 *
 *  This is the main entry point. Called by:
 *    - the curiosity drive (one repo per firing cycle, budget-capped)
 *    - the `autofork scan` console command (operator-triggered full scan)
 *
 *  `clientToken` (optional) overrides the sealed PAT — the operator can
 *  paste a fresh token via the `autofork scan` command if the sealed one
 *  is rate-limited. */
export async function ingestAutoFork(
  clientTokenOrRepo?: string,
  repoOverride?: string,
): Promise<AutoForkResult> {
  // Two calling conventions:
  //   ingestAutoFork(token)                 — scan the next enabled seed
  //   ingestAutoFork(token, "deepseek-ai/deepseek-harness") — scan a specific repo
  // The curiosity drive calls the first; the operator's `autofork scan <repo>`
  // calls the second.
  if (repoOverride && clientTokenOrRepo) {
    // Ambiguous call: operator specified a repo AND a token. Prioritize repo context.
    // We use the token if provided, but the repo context is primary for this path.
  }
  const clientToken = clientTokenOrRepo;
  const targetRepo = repoOverride;
  const result: AutoForkResult = {
    scanned: 0,
    reposScanned: 0,
    filesIngested: 0,
    lessonsDistilled: 0,
    skipped: [],
    errors: [],
  };

  const allSeeds = readSeeds();
  if (allSeeds.length === 0) {
    result.skipped.push("no enabled seeds (edit autofork-seeds.json to add reference repos)");
    return result;
  }

  // Resolve the token: client override → sealed PAT → null (anonymous).
  const token = clientToken ?? (await resolveTargetToken());
  if (!token) {
    result.errors.push("no GitHub token (auto-fork needs a PAT for the tree + file fetches)");
    return result;
  }

  const manifest = readManifest();
  result.scanned = allSeeds.length;

  // Pick the seed: explicit repo override → first enabled seed.
  // If a repo override is given, find it in the seed list (enabled or not —
  // the operator explicitly asked for it). If not found, still try it as an
  // ad-hoc repo (the operator can learn from any repo, not just seeded ones).
  let seed: SeedEntry | { repo: string; branch?: string; reason: string; enabled: boolean };
  if (targetRepo) {
    const found = allSeeds.find((s) => s.repo === targetRepo);
    // If found, use it. If not found, treat it as an ad-hoc repo, ensuring it's treated as enabled for scanning.
    seed = found ?? { repo: targetRepo, branch: undefined, reason: "ad-hoc (not in seed list)", enabled: true };
  } else {
    // Since allSeeds.length > 0, allSeeds[0] is safe.
    seed = allSeeds[0];
  }
  // seed is guaranteed to be defined here because allSeeds.length > 0
  result.reposScanned = 1;

  // Resolve the branch: explicit → default branch.
  let branch = seed.branch ?? "";
  if (!branch) {
    // Run default branch fetch.
    branch = (await getRepoDefaultBranch(seed.repo, token)) ?? "main";
  }

  // Fetch the tree. Auto-fork uses a LARGER cap (2000) + skipMetaDirs
  // (skips .agents/, .github/, docs/, etc. before the cap) — big repos
  // with large meta/docs directories (e.g. deepseek-ai/deepseek-harness
  // has 2000+ .agents/notes/ markdown files) need both to see the
  // actual source files. The gauntlet's default 400-cap + no-skip is
  // for refactoring (TS/JS-only, smaller scope); auto-fork's 2000 +
  // skip is for learning (any language, broader scope).
  const treeRes = await listTargetTree(seed.repo, branch, token, 2000, true);
  if (!treeRes.ok) {
    result.errors.push(`${seed.repo}: tree fetch failed — ${treeRes.error}`);
    return result;
  }

  // Rank + pick the highest-signal files (broad picker — accepts ANY
  // source language: .ts/.tsx/.js/.jsx/.py/.go/.rs/.java/etc. — because
  // auto-fork distills LESSONS from external repos, not refactors them.
  // The gauntlet's TS/JS-only picker is for refactoring; auto-fork's
  // broad picker is for learning. This is why a Python repo like
  // deepseek-ai/deepseek-harness works with auto-fork but not the
  // gauntlet's auto-pick).
  const ranked = rankCandidateFilesBroad(treeRes.tree.files);
  // Filter out already-ingested files (manifest dedupe by blobSha).
  const newRanked = ranked.filter(
    (r) => !manifest[`${seed.repo}/${r.path}`] ||
           manifest[`${seed.repo}/${r.path}`].blobSha !== (treeRes.tree.files.find((f) => f.path === r.path)?.sha ?? ""),
  );

  if (newRanked.length === 0) {
    result.skipped.push(`${seed.repo}: all candidate files already ingested (manifest up to date)`);
    return result;
  }

  // Fetch + distill up to MAX_FILES_PER_REPO files.
  const toFetch = newRanked.slice(0, MAX_FILES_PER_REPO);
  for (const candidate of toFetch) {
    const fileKey = `${seed.repo}/${candidate.path}`;
    const fileRes = await fetchTargetFile(seed.repo, candidate.path, branch, token);
    if (!fileRes.ok) {
      result.skipped.push(`${fileKey}: fetch failed (${fileRes.status})`);
      continue;
    }

    // Distill candidate lessons from the fetched file. (The gauntlet's
    // static scan would confirm real signal, but even a clean file has
    // conventions worth extracting — so we distill regardless, not gate.)
    const systemTag = seed.repo;
    const lessons = await distillCandidateLessons(
      fileRes.file.content,
      systemTag,
      candidate.path,
      `the ${seed.repo} reference repo`,
    );
    let seeded = 0;
    for (const lesson of lessons) {
      const id = await seedCandidateLesson(lesson.content, systemTag, "autofork");
      if (id) seeded++;
    }
    result.lessonsDistilled += seeded;
    result.filesIngested++;

    // Update the manifest with the blob sha.
    const blobSha = treeRes.tree.files.find((f) => f.path === candidate.path)?.sha ?? fileRes.file.blobSha;
    manifest[fileKey] = {
      blobSha,
      ingestedAt: new Date().toISOString(),
      lessonsDistilled: seeded,
    };
  }

  writeManifest(manifest);
  return result;
}

/** Get the auto-fork status — the seed list, per-repo progress, candidate
 *  lessons. For the `autofork` console command + the /api/autofork route. */
export async function getAutoForkStatus(): Promise<{
  configured: boolean;
  seedsCount: number;
  enabledSeeds: number;
  seeds: Array<{ repo: string; enabled: boolean; reason: string }>;
  ingestedFiles: number;
  candidateLessons: number;
  bySystem: Array<{ system: string; lessons: number }>;
}> {
  const allSeeds = readSeeds();
  const enabledSeeds = allSeeds.filter((s) => s.enabled !== false);

  const manifest = readManifest();
  const ingestedFiles = Object.keys(manifest).length;

  let candidateLessons = 0;
  const bySystemMap = new Map<string, number>();

  try {
    const lessons = await db.lesson.findMany({
      where: { source: "autofork" },
      select: { system: true, active: true },
    });

    // Calculate metrics from the fetched lessons in one pass using reduce
    const { lessons: activeLessons, bySystem } = lessons.reduce(
      (acc, l) => {
        const sys = l.system ?? "unknown";
        acc.bySystem.set(sys, (acc.bySystem.get(sys) ?? 0) + 1);
        if (l.active) {
          acc.lessons++;
        }
        return acc;
      },
      { lessons: 0, bySystem: new Map<string, number>() }
    );
    candidateLessons = activeLessons;
    bySystemMap.clear();
    bySystem.forEach((count, system) => bySystemMap.set(system, count));

  } catch (error) {
    console.error("Failed to fetch autofork lessons from DB during status check. Context: DB connection or query failed.", error);
    // DB unavailable, candidateLessons remains 0, bySystemMap remains empty
  }

  return {
    configured: allSeeds.length > 0,
    seedsCount: allSeeds.length,
    enabledSeeds: enabledSeeds.length,
    seeds: allSeeds.map((s) => ({ repo: s.repo, enabled: s.enabled !== false, reason: s.reason })),
    ingestedFiles,
    candidateLessons,
    bySystem: [...bySystemMap.entries()]
      .map(([system, lessons]) => ({ system, lessons }))
      .sort((a, b) => b.lessons - a.lessons),
  };
}