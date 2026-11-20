/**
 * harvest/runner.ts — the headless harvest pipeline.
 *
 * WHAT THIS IS
 * ────────────
 * The App.tsx in GitHistory-Sync held the orchestration logic as React
 * state + side effects. This module is the headless extraction: the
 * SAME call sequence App.tsx ran (discoverRepositories → per-repo
 * extractCommitsForRepo → optional CI lookup → classifyAndOrchestrate
 * → formatSplitArchives → push), callable from a CLI or an HTTP
 * trigger with no UI.
 *
 * WHY IT'S NEW (NOT VERBATIM)
 * ──────────────────────────
 * The verbatim utils (githubClient, aiOrchestrator, formatter,
 * sources, classifier, engineHarvester, rateLimiter) are pure-ish
 * leaves that take options and return data. App.tsx wired them
 * together with React state setters, toasts, and timer objects —
 * none of which belong in a detached harvester. The runner replaces
 * all of that with a logger callback + a return value.
 *
 * DESIGN
 * ──────
 * - `runHarvest(options)` returns a HarvestResult. It does NOT throw
 *   on a single-repo failure; errors are logged and the run continues
 *   (matches App.tsx's per-repo try/catch).
 * - Supports a `repos` override (for step 3's 1-2 repo subset smoke
 *   test before autonomy wires the full fleet).
 * - The LLM budget cap (MAX_LLM_COMMITS_PER_HARVEST) is enforced here:
 *   once the ambiguous queue exceeds the cap, remaining ambiguous
 *   commits fall back to the heuristic default (successful/low) —
 *   visible in the result so a run-away harvest is diagnosable.
 * - Writes the three corpus files atomically to LOOP_MEMORY_DIR
 *   (default: ../../memory, the live consumer dir) AND optionally
 *   pushes them to V1 (the archive repo). The atomic-write.ts module
 *   handles the temp-file-then-rename so the consumer never sees a
 *   partial file.
 *
 * INTEGRITY: this module is the orchestrator. It calls githubClient
 * (external HTTP), aiOrchestrator (external LLM), formatter, and
 * atomic-write. It does not import the main LOOP project.
 */

import type {
  ArchiveFormat,
  ClassifiedCommit,
  ExtractionSettings,
  LogLevel,
  RawCommit,
  RepoSummary,
  SiphonedEngine,
} from "../types/git";
import {
  discoverRepositories,
  extractCommitsForRepo,
  lookupCommitCiState,
  pushSplitArchivesToGitHub,
} from "../lib/githubClient";
import { classifyAndOrchestrate } from "../lib/aiOrchestrator";
import { formatSplitArchives } from "../lib/formatter";
import { deriveLogPaths } from "../lib/sources";
import { sleepWithAbort } from "../lib/rateLimiter";
import { formatDurationMs } from "../lib/formatter";
import { atomicWriteText } from "./atomic-write";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

/** A logger callback — the headless replacement for App.tsx's appendLog. */
export type LogFn = (msg: string, level?: LogLevel) => void;

/** Optional subset of repos to harvest (step 3 smoke test). */
export interface HarvestReposOverride {
  /** Skip discoverRepositories; harvest exactly these repo full-names. */
  repos: string[];
}

export interface HarvestOptions {
  /** GitHub token for fleet discovery + V1 push. Required for real runs. */
  githubToken: string;
  /** Extraction settings (mirrors App.tsx's extractionSettings object). */
  extraction: ExtractionSettings;
  /** Destination settings (target repo, branch, path, format, auto-create). */
  destination: {
    targetRepo: string;
    targetBranch: string;
    targetPath: string;
    fileFormat: ArchiveFormat;
    autoCreateRepo: boolean;
  };
  /** Local dir to mirror the corpus atomically. Defaults to ../../memory. */
  loopMemoryDir?: string;
  /** Push the corpus to V1 (destination) in addition to the local mirror. */
  pushToV1: boolean;
  /** Max ambiguous commits sent to the LLM per harvest (budget cap). */
  maxLlmCommitsPerHarvest: number;
  /** Override discoverRepositories with an explicit repo list (smoke test). */
  reposOverride?: HarvestReposOverride;
  /** Logger. Defaults to console. */
  onLog?: LogFn;
  /** Abort signal. */
  signal?: AbortSignal;
}

export interface HarvestResult {
  ok: boolean;
  runStartedAt: number;
  runEndedAt: number;
  durationMs: number;
  reposDiscovered: number;
  reposScanned: number;
  branchesScanned: number;
  uniqueCommits: number;
  enginesSiphoned: number;
  successfulCommits: number;
  failedCommits: number;
  llmCommitsSent: number;
  llmBudgetCapped: number;
  corpusFiles: Array<{ path: string; bytes: number; label: string }>;
  pushedToV1: boolean;
  errors: string[];
}

/**
 * Pure budget-cap decision. Extracted from runHarvest so it's unit-testable
 * without network. Returns { capped: boolean (1/0), extraction: the possibly-
 * LLM-disabled settings }.
 *
 * Rule: if total commit count > 2x the cap, disable the LLM entirely for
 * this run (heuristic default stands for all ambiguous commits). Below
 * that threshold, the LLM runs and the real count is reported via
 * OrchestrateResult.llmCommitsSent. The 2x factor is conservative: a run
 * with 1000 commits but only 50 ambiguous ones still uses the LLM (50 < cap).
 */
export function decideLlmBudgetCap<T extends ExtractionSettings>(
  totalCommits: number,
  maxLlmCommitsPerHarvest: number,
  extraction: T,
): { capped: number; extraction: T } {
  if (totalCommits > maxLlmCommitsPerHarvest * 2) {
    return {
      capped: 1,
      extraction: { ...extraction, useGemini: false, useLlm: false },
    };
  }
  return { capped: 0, extraction };
}

/**
 * Stable newest-first sort with a SHA tiebreaker. Extracted so the
 * determinism (same-timestamp commits get a stable order across runs) is
 * unit-testable. The old comparator returned -1 on equal dates, which was
 * unstable across V8 versions.
 */
export function sortCommitsNewestFirst<T extends { date: string; sha: string }>(
  commits: T[],
): T[] {
  return [...commits].sort(
    (a, b) => b.date.localeCompare(a.date) || a.sha.localeCompare(b.sha),
  );
}

/**
 * The default LOOP memory dir — the project's memory/ folder two levels
 * up from mini-services/fleet-harvester/. This is where githistory-corpus.ts
 * reads from. The runner mirrors the corpus there atomically.
 */
const DEFAULT_LOOP_MEMORY_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "memory",
);

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Run one full harvest. Mirrors App.tsx's handleFetchAndClassify +
 * handlePushToGitHub, minus the React state.
 */
export async function runHarvest(
  options: HarvestOptions,
): Promise<HarvestResult> {
  const log = options.onLog ?? ((msg, level) => console.log(`[${level ?? "info"}] ${msg}`));
  const signal = options.signal;
  const runStartedAt = Date.now();
  const errors: string[] = [];

  const loopMemoryDir = options.loopMemoryDir ?? DEFAULT_LOOP_MEMORY_DIR;
  const extraction = options.extraction;

  const result: HarvestResult = {
    ok: true,
    runStartedAt,
    runEndedAt: runStartedAt,
    durationMs: 0,
    reposDiscovered: 0,
    reposScanned: 0,
    branchesScanned: 0,
    uniqueCommits: 0,
    enginesSiphoned: 0,
    successfulCommits: 0,
    failedCommits: 0,
    llmCommitsSent: 0,
    llmBudgetCapped: 0,
    corpusFiles: [],
    pushedToV1: false,
    errors,
  };

  try {
    // ── 1. DISCOVER REPOSITORIES ──────────────────────────────
    let repos: RepoSummary[] = [];
    let externalOwners = new Set<string>();

    if (options.reposOverride && options.reposOverride.repos.length > 0) {
      log(`Smoke-test mode: ${options.reposOverride.repos.length} explicit repo(s) (skipping discovery).`, "info");
      // Resolve each repo's full metadata from the API so the extractor
      // gets a proper RepoSummary (full_name, name, owner, private, fork,
      // default_branch, html_url) and doesn't 404 on repos whose default
      // isn't "main" (e.g. vercel/next.js uses "canary"). Also honors the
      // abort signal + a 30s timeout so a stalled /repos/{name} call can't
      // hang the smoke test forever (bug fix: the original raw fetch had
      // no signal, no timeout, no retry).
      for (const full_name of options.reposOverride.repos) {
        if (signal?.aborted) throw new Error("Operation cancelled.");
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 30_000);
          if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });
          let j: {
            full_name: string;
            name: string;
            owner: { login: string } | null;
            private: boolean;
            fork: boolean;
            default_branch: string;
            html_url?: string;
          };
          try {
            const meta = await fetch(
              `https://api.github.com/repos/${full_name}`,
              {
                headers: {
                  Authorization: `token ${options.githubToken}`,
                  Accept: "application/vnd.github+json",
                  "User-Agent": "fleet-harvester",
                },
                signal: ctrl.signal,
              },
            );
            if (!meta.ok) {
              log(`Could not resolve ${full_name}: HTTP ${meta.status}`, "warn");
              continue;
            }
            j = (await meta.json()) as typeof j;
          } finally {
            clearTimeout(timer);
          }
          repos.push({
            full_name: j.full_name,
            name: j.name,
            owner: j.owner?.login ?? "",
            private: j.private,
            fork: j.fork,
            default_branch: j.default_branch,
            html_url: j.html_url,
          });
          log(`  ${full_name} default branch: ${j.default_branch}`, "info");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (signal?.aborted || /cancelled/i.test(msg)) throw err;
          log(`Error resolving ${full_name}: ${msg}`, "warn");
          errors.push(`resolve ${full_name}: ${msg}`);
        }
      }
    } else {
      log("Discovering repositories across selected sources...", "info");
      const discovered = await discoverRepositories(
        options.githubToken,
        {
          includeMine: extraction.includeMine,
          includePrivate: extraction.includePrivate,
          includeForks: extraction.includeForks,
          sources: extraction.sources,
          repoFilter: extraction.repoFilter,
          signal,
        },
        log,
      );
      repos = discovered.repos;
      externalOwners = discovered.externalOwners;
    }

    result.reposDiscovered = repos.length;

    if (repos.length === 0) {
      log("No repositories matched the selected filters.", "warn");
      result.ok = false;
      errors.push("No repositories matched the selected filters.");
      result.runEndedAt = Date.now();
      result.durationMs = result.runEndedAt - runStartedAt;
      return result;
    }

    // ── 2. EXTRACT COMMITS PER REPO ───────────────────────────
    const mergedCommits: RawCommit[] = [];
    const mergedEngines: SiphonedEngine[] = [];
    let totalBranches = 0;
    let scannedRepos = 0;

    for (let repoIndex = 0; repoIndex < repos.length; repoIndex += 1) {
      const repo = repos[repoIndex];
      if (signal?.aborted) throw new Error("Operation cancelled.");
      const isExternal = externalOwners.has(repo.full_name.toLowerCase());
      const author = isExternal ? extraction.extAuthor : extraction.authorFilter;
      const repoStartedAt = Date.now();

      try {
        const res = await extractCommitsForRepo(options.githubToken, repo, {
          author,
          sinceDate: extraction.sinceDate,
          untilDate: extraction.untilDate,
          skipOwn: extraction.skipOwn,
          includeEmails: extraction.includeEmails,
          branchScope: extraction.branchScope,
          siphonEngines: extraction.siphonEngines,
          signal,
          onLog: log,
          onProgress: ({
            uniqueCommits: repoCommits,
            enginesSiphoned: repoEngines,
            currentBranch,
            page,
          }) => {
            log(
              `  ${repo.full_name} branch ${currentBranch} page ${page}: ${repoCommits} commits, ${repoEngines} engines`,
              "info",
            );
          },
        });
        scannedRepos += 1;
        totalBranches += res.branchCount;
        mergedCommits.push(...res.commits);
        mergedEngines.push(...res.engines);

        const repoElapsed = formatDurationMs(Date.now() - repoStartedAt);
        const engineSuffix = extraction.siphonEngines
          ? ` and siphoned ${res.engines.length} engine(s)`
          : "";
        if (res.commits.length === 0 && author.trim()) {
          log(
            `0 commits matched author "${author}" in ${repo.full_name}${engineSuffix} (${repoElapsed}; clear author filter to pull all authors).`,
            "info",
          );
        } else {
          log(
            `Scanned ${repo.full_name}: ${res.commits.length} commits across ${res.branchCount} branch(es)${engineSuffix} in ${repoElapsed}.`,
            "info",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Re-throw on abort so cancellation propagates immediately
        // instead of being demoted to a per-repo error and costing
        // one extra repo iteration + the inter-repo sleep.
        if (signal?.aborted || /cancelled/i.test(msg)) throw err;
        scannedRepos += 1;
        log(`Error scanning ${repo.full_name}: ${msg}`, "warn");
        errors.push(`${repo.full_name}: ${msg}`);
      }

      if (repoIndex + 1 < repos.length) {
        const interRepoMs = options.githubToken ? 400 : 1200;
        await sleepWithAbort(interRepoMs, signal);
      }
    }

    // Sort newest first (matches App.tsx). Stable tiebreaker on SHA
    // so same-timestamp commits have a deterministic order across runs.
    // Uses the extracted sortCommitsNewestFirst helper (unit-tested).
    const sortedCommits = sortCommitsNewestFirst(mergedCommits);
    mergedCommits.length = 0;
    mergedCommits.push(...sortedCommits);

    result.reposScanned = scannedRepos;
    result.branchesScanned = totalBranches;
    result.uniqueCommits = mergedCommits.length;
    result.enginesSiphoned = mergedEngines.length;

    // ── 3. OPTIONAL CI LOOKUP ─────────────────────────────────
    if (extraction.ciLookup && mergedCommits.length > 0) {
      log(`Checking CI status across all ${mergedCommits.length} commits...`, "info");
      for (let i = 0; i < mergedCommits.length; i += 1) {
        if (signal?.aborted) throw new Error("Operation cancelled.");
        const target = mergedCommits[i];
        target.ciState = await lookupCommitCiState(
          options.githubToken,
          target.repo,
          target.sha,
          signal,
          log,
        );
        if (i + 1 < mergedCommits.length) {
          await sleepWithAbort(options.githubToken ? 250 : 900, signal);
        }
      }
    }

    // ── 4. BUDGET CAP: cap commits sent to LLM ──────────────
    // Uses the extracted decideLlmBudgetCap helper (unit-tested). See
    // that function's docstring for the rule + the honest-metric rationale.
    const capDecision = decideLlmBudgetCap(
      mergedCommits.length,
      options.maxLlmCommitsPerHarvest,
      extraction,
    );
    const llmBudgetCapped = capDecision.capped;
    const cappedExtraction = capDecision.extraction;
    if (llmBudgetCapped === 1) {
      log(
        `Commit count (${mergedCommits.length}) exceeds 2x LLM budget cap (${options.maxLlmCommitsPerHarvest}); disabling LLM for this run (heuristic default stands).`,
        "warn",
      );
    }

    // ── 5. CLASSIFY + ORCHESTRATE ─────────────────────────────
    const orchestrateResult = await classifyAndOrchestrate(
      mergedCommits,
      cappedExtraction,
      log,
      signal,
      (label, detail) => {
        log(`${label}: ${detail ?? ""}`, "info");
      },
    );
    const classified: ClassifiedCommit[] = orchestrateResult.classified;

    result.successfulCommits = classified.filter((c) => c.classification === "successful").length;
    result.failedCommits = classified.length - result.successfulCommits;
    result.llmCommitsSent = orchestrateResult.llmCommitsSent;
    result.llmBudgetCapped = llmBudgetCapped;

    // ── 6. FORMAT + WRITE CORPUS ──────────────────────────────
    const generatedAt = nowIso();
    // FORMAT SPLIT: the local LOOP memory/ mirror MUST be JSON — the
    // consumer (githistory-corpus.ts) hardcodes commit-history.*.json
    // paths. The V1 push can use any configured format (json/md/csv) for
    // human-readable archives. The old code used options.destination.fileFormat
    // for BOTH, so a `--format=csv` run wrote .csv files the consumer
    // couldn't see. Now the local mirror is always json; V1 gets the
    // configured format.
    const localFormat: ArchiveFormat = "json";
    const v1Format: ArchiveFormat = options.destination.fileFormat;

    const localArchives = formatSplitArchives(
      classified,
      localFormat,
      { includeEmails: extraction.includeEmails, generatedAt },
      mergedEngines,
    );
    const localPaths = deriveLogPaths(options.destination.targetPath, localFormat);

    // The V1 push files are only computed if pushToV1 is on (lazy).
    const v1Archives =
      options.pushToV1 && options.destination.targetRepo.trim().length > 0
        ? formatSplitArchives(
            classified,
            v1Format,
            { includeEmails: extraction.includeEmails, generatedAt },
            mergedEngines,
          )
        : null;
    const v1Paths = v1Archives
      ? deriveLogPaths(options.destination.targetPath, v1Format)
      : null;

    // The local corpus (always json) — written atomically to the consumer dir.
    const corpusFiles: Array<{ path: string; bytes: number; label: string; content: string }> = [
      {
        path: localPaths.successful,
        bytes: Buffer.byteLength(localArchives.successful, "utf8"),
        label: "successful",
        content: localArchives.successful,
      },
      {
        path: localPaths.failed,
        bytes: Buffer.byteLength(localArchives.failed, "utf8"),
        label: "failed",
        content: localArchives.failed,
      },
      // ALWAYS write the engines file — even when 0 engines were siphoned.
      // The old guard (`if mergedEngines.length > 0`) left a stale engines
      // file from a previous harvest in memory/ when this run siphoned
      // nothing, silently breaking the LOOP consumer's expectations
      // (it would read the old engine set as current). Writing the empty-
      // count file lets the consumer reset cleanly. The formatter already
      // produces a valid empty-count engines JSON ({schema, bucket:'engines',
      // count:0, engines:[], loopMemory:...}).
      {
        path: localPaths.engines,
        bytes: Buffer.byteLength(localArchives.engines, "utf8"),
        label: "engines",
        content: localArchives.engines,
      },
    ];

    // Write each file atomically to the local LOOP memory/ mirror.
    for (const f of corpusFiles) {
      const localPath = resolve(loopMemoryDir, f.path);
      atomicWriteText(localPath, f.content);
      log(`Wrote ${f.path} (${f.bytes} bytes) to ${loopMemoryDir}`, "success");
      result.corpusFiles.push({ path: f.path, bytes: f.bytes, label: f.label });
    }

    // ── 7. OPTIONAL V1 PUSH ───────────────────────────────────
    if (options.pushToV1 && options.destination.targetRepo.trim().length > 0 && v1Archives && v1Paths) {
      // Build the V1 file set in the configured format (may differ from
      // the local json mirror). The local corpusFiles are always json;
      // V1 can be json/md/csv for human-readable archives.
      const v1Files = [
        { path: v1Paths.successful, content: v1Archives.successful, label: "successful" },
        { path: v1Paths.failed, content: v1Archives.failed, label: "failed" },
        { path: v1Paths.engines, content: v1Archives.engines, label: "engines" },
      ];
      log(
        `Pushing ${v1Files.length} archive file(s) (${v1Format}) to ${options.destination.targetRepo}@${options.destination.targetBranch}...`,
        "info",
      );
      try {
        await pushSplitArchivesToGitHub(
          options.githubToken,
          {
            repo: options.destination.targetRepo.trim(),
            branch: options.destination.targetBranch.trim(),
            autoCreatePrivate: options.destination.autoCreateRepo,
            files: v1Files,
          },
          log,
        );
        result.pushedToV1 = true;
        log(`Pushed ${v1Files.length} file(s) to V1.`, "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`V1 push failed: ${msg}`, "error");
        errors.push(`V1 push: ${msg}`);
        // Not fatal — the local mirror is still written.
      }
    }

    result.runEndedAt = Date.now();
    result.durationMs = result.runEndedAt - runStartedAt;

    log(
      `Archive compiled in ${formatDurationMs(result.durationMs)}: ${result.successfulCommits} successful, ${result.failedCommits} failed, ${mergedEngines.length} engines across ${scannedRepos} repositories.`,
      "success",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Harvest stopped: ${msg}`, "error");
    errors.push(msg);
    result.ok = false;
    result.runEndedAt = Date.now();
    result.durationMs = result.runEndedAt - runStartedAt;
  }

  return result;
}

/**
 * Convenience: returns true if the local LOOP memory dir exists
 * (i.e. the consumer side is wired). Used by the CLI for an early
 * sanity check.
 */
export function loopMemoryDirExists(dir?: string): boolean {
  const path = dir ?? DEFAULT_LOOP_MEMORY_DIR;
  return existsSync(path);
}

export { DEFAULT_LOOP_MEMORY_DIR };
