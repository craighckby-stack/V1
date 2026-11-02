/**
 * Commit Archaeology — pair wrong/correct commits from a target repo's
 * git history into a self-labeled prophecy dataset for the Oracle
 * (concept: Commit-puller repo's parseGitLog).
 *
 * The Oracle predicts the system's own future. To do that WELL, it needs
 * labeled examples of "this commit introduced a bug, that commit fixed
 * it." Mining ANY target repo's history produces that dataset for free —
 * no human labeling, no LLM judgment, just the revert/fix messages the
 * authors already wrote.
 *
 * ALGORITHM (three passes after chronological sort):
 *
 *   1. REVERT detection. A commit whose body says "This reverts commit
 *      <hash>" → the target commit is WRONG, the revert is CORRECT.
 *      targetCommit.pairId = revert.shortHash (the fixing commit).
 *
 *   2. FIX detection. A commit whose subject matches /\b(fix|fixes|fixed|
 *      bugfix|patch)\b/i → look BACKWARD for the closest preceding commit
 *      with file-overlap → mark it WRONG with fixedBy = this commit's
 *      shortHash. Convention: WRONG.pairId = the fixing commit's hash;
 *      CORRECT.pairId = its own hash.
 *
 *   3. SELF-IDENTIFIED failure. A commit whose subject matches
 *      FAILURE_WORDS (wip|broken|attempt|fixup|didn't work|failed|...)
 *      → flag for forward resolution (a later commit that touches the
 *      same files is likely the fix). Used to enrich the rationale, not
 *      to produce a fresh pair on its own (avoids over-labeling).
 *
 * EXCLUSION (shared with scan + AST-diff via exclusion-patterns.ts):
 *   commits where EVERY file is a lockfile/generated or a ledger/meta
 *   file are skipped — a lockfile bump is not a "wrong" source change.
 *
 * This module produces PAIRS only. Converting pairs to prophecies is a
 * separate step (archaeologyPairsToProphecyInputs + the oracle's LLM
 * generator) — the archaeology layer stays pure data, the oracle layer
 * owns the LLM + the falsifiability framing.
 */

import { hasCoreSourceFiles } from "../core/exclusion-patterns";

export interface ArchaeologyCommit {
  sha: string;
  shortHash: string; // first 7 chars
  subject: string;
  body: string;
  files: string[];
  date: string; // ISO
  isRevert: boolean;
  verdict: "CORRECT" | "WRONG" | "NEUTRAL";
  /** For WRONG: the shortHash of the commit that fixed it.
   *  For CORRECT: this commit's own shortHash. */
  pairId: string | null;
  fixedBy: string | null;
}

export interface ArchaeologyPair {
  /** The commit that introduced the bug. */
  wrong: ArchaeologyCommit;
  /** The commit that fixed it. */
  correct: ArchaeologyCommit;
  /** Files touched by BOTH — the overlap that linked them. */
  overlappingFiles: string[];
  /** How the pair was detected. */
  method: "revert" | "fix-overlap";
}

const REVERT_HASH_PATTERN = /This reverts commit ([0-9a-f]{7,40})/i;
const FIX_PATTERN = /\b(fix|fixes|fixed|bugfix|patch)\b/i;
const FAILURE_WORDS =
  /\b(wip|broken|attempt|trying|fixup|squash|didn'?t work|failed|revert|undo|rollback|hotfix|hacky|kludge)\b/i;

interface RawCommit {
  sha: string;
  commit: {
    message: string;
    author?: { date?: string };
  };
}

interface CommitDetail {
  sha: string;
  files: Array<{ filename: string }>;
}

/** Fetch a page of commits from the GitHub REST API. Returns the raw
 *  list-commits response (no per-file detail — that needs a second call). */
async function fetchCommitPage(
  repo: string,
  branch: string,
  page: number,
  perPage: number,
  token: string | null,
  signal?: AbortSignal
): Promise<RawCommit[]> {
  const url = `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(
    branch
  )}&per_page=${perPage}&page=${page}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "loop-commit-archaeology",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Repo ${repo} not found (404)`);
    if (res.status === 401 || res.status === 403)
      throw new Error(`GitHub auth failed (${res.status}) — check the token has read access to ${repo}`);
    throw new Error(`GitHub commits fetch failed (HTTP ${res.status})`);
  }
  return (await res.json()) as RawCommit[];
}

/** Fetch a single commit's file list (the list endpoint omits files). */
async function fetchCommitFiles(
  repo: string,
  sha: string,
  token: string | null,
  signal?: AbortSignal
): Promise<string[]> {
  const url = `https://api.github.com/repos/${repo}/commits/${sha}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "loop-commit-archaeology",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal });
  if (!res.ok) return []; // best-effort — a 404 on a sha means skip it
  const detail = (await res.json()) as CommitDetail;
  return (detail.files ?? []).map((f) => f.filename);
}

/** Fetch up to maxCommits from the repo's history on the given branch,
 *  with per-commit file lists. Bounded by a hard wall-clock deadline
 *  (default 28s) so a slow upstream can't hang the call. */
export async function fetchHistoryWithFiles(opts: {
  repo: string;
  branch: string;
  token?: string | null;
  maxCommits?: number;
  deadlineMs?: number;
}): Promise<ArchaeologyCommit[]> {
  const { repo, branch } = opts;
  const token = opts.token ?? null;
  const maxCommits = Math.min(opts.maxCommits ?? 30, 100);
  const deadlineMs = opts.deadlineMs ?? 28_000;
  const startedAt = Date.now();

  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);

  try {
    const raw: RawCommit[] = [];
    const perPage = 100;
    let page = 1;
    while (raw.length < maxCommits) {
      if (Date.now() - startedAt > deadlineMs) break;
      const batch = await fetchCommitPage(repo, branch, page, perPage, token, controller.signal);
      if (batch.length === 0) break;
      raw.push(...batch);
      if (batch.length < perPage) break; // last page
      page++;
    }
    const sliced = raw.slice(0, maxCommits);

    // Fetch per-commit file lists in small concurrency batches so we
    // don't hit the secondary rate limit. BATCH_SIZE = 5 keeps the
    // request rate under GitHub's ~100/min soft cap even at maxCommits=100.
    const BATCH_SIZE = 5;
    const out: ArchaeologyCommit[] = [];
    for (let i = 0; i < sliced.length; i += BATCH_SIZE) {
      if (Date.now() - startedAt > deadlineMs) break;
      const batch = sliced.slice(i, i + BATCH_SIZE);
      const detailed = await Promise.all(
        batch.map(async (c) => {
          const files = await fetchCommitFiles(repo, c.sha, token, controller.signal).catch(
            () => [] as string[]
          );
          return { c, files };
        })
      );
      for (const { c, files } of detailed) {
        const message = c.commit?.message ?? "";
        const nl = message.indexOf("\n");
        const subject = (nl >= 0 ? message.slice(0, nl) : message).trim();
        const body = nl >= 0 ? message.slice(nl + 1) : "";
        out.push({
          sha: c.sha,
          shortHash: c.sha.slice(0, 7),
          subject,
          body,
          files,
          date: c.commit?.author?.date ?? new Date().toISOString(),
          isRevert: REVERT_HASH_PATTERN.test(message),
          verdict: "NEUTRAL",
          pairId: null,
          fixedBy: null,
        });
      }
    }
    return out;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/** Run the three-pass wrong/correct pairing on a chronologically-sorted
 *  (oldest-first) commit list. Returns the pairs + the (mutated) commits
 *  with verdicts set. Skips commits where every file is a lockfile /
 *  generated / ledger / meta — see exclusion-patterns.ts. */
export function classifyCommitPairs(
  commits: ArchaeologyCommit[]
): { pairs: ArchaeologyPair[]; commits: ArchaeologyCommit[] } {
  // Work on a copy so the caller's list isn't mutated.
  const work = commits.map((c) => ({ ...c }));
  // Chronological order (oldest first) — the pairing walks backward from
  // fix commits to find the bug they fixed.
  work.sort((a, b) => a.date.localeCompare(b.date));

  // Exclude commits with no core source files (lockfile bumps, ledger
  // updates). They can't be WRONG or CORRECT source changes.
  const eligible = work.filter((c) => hasCoreSourceFiles(c.files));

  // Pass 1: revert detection. "This reverts commit <hash>" → the target
  // is WRONG, the revert is CORRECT.
  for (const c of eligible) {
    const msg = `${c.subject}\n${c.body}`;
    const m = msg.match(REVERT_HASH_PATTERN);
    if (!m) continue;
    const targetHash = m[1];
    const target = eligible.find(
      (tc) => tc.sha.startsWith(targetHash) || targetHash.startsWith(tc.shortHash)
    );
    if (target) {
      target.verdict = "WRONG";
      target.fixedBy = c.shortHash;
      target.pairId = c.shortHash;
      c.verdict = "CORRECT";
      c.pairId = c.shortHash;
    }
  }

  // Pass 2: fix detection. Subject matches FIX_PATTERN → look BACKWARD
  // for the closest preceding commit with file-overlap → mark it WRONG.
  for (let i = 0; i < eligible.length; i++) {
    const c = eligible[i];
    if (c.verdict === "CORRECT") continue; // already labeled by a revert
    if (!FIX_PATTERN.test(c.subject) && !c.isRevert) continue;
    if (c.verdict !== "NEUTRAL" && c.verdict !== "CORRECT") continue;
    c.verdict = "CORRECT";
    c.pairId = c.shortHash;
    for (let j = i - 1; j >= 0; j--) {
      const pred = eligible[j];
      if (pred.verdict === "CORRECT") continue;
      if (pred.verdict === "WRONG") continue; // already paired
      const overlap = pred.files.filter((f) => c.files.includes(f));
      if (overlap.length > 0) {
        pred.verdict = "WRONG";
        pred.fixedBy = c.shortHash;
        pred.pairId = c.shortHash;
        break;
      }
    }
  }

  // Build the pair list: every WRONG commit paired with its fixing CORRECT
  // commit, where both are in the eligible set.
  const pairs: ArchaeologyPair[] = [];
  for (const wrong of eligible) {
    if (wrong.verdict !== "WRONG" || !wrong.fixedBy) continue;
    const correct = eligible.find((c) => c.shortHash === wrong.fixedBy && c.verdict === "CORRECT");
    if (!correct) continue;
    const overlappingFiles = wrong.files.filter((f) => correct.files.includes(f));
    pairs.push({
      wrong,
      correct,
      overlappingFiles,
      method: wrong.isRevert || REVERT_HASH_PATTERN.test(`${wrong.subject}\n${wrong.body}`)
        ? "revert"
        : "fix-overlap",
    });
  }

  return { pairs, commits: work };
}

/** Enrichment: flag commits that self-identify as failures (WIP, broken,
 *  didn't work, hacky, etc.) — used by the oracle generator as EXTRA
 *  signal when phrasing prophecies, not as fresh pairs on their own. */
export function flagSelfIdentifiedFailures(commits: ArchaeologyCommit[]): ArchaeologyCommit[] {
  return commits.map((c) => {
    if (FAILURE_WORDS.test(c.subject) || FAILURE_WORDS.test(c.body)) {
      return { ...c, verdict: c.verdict === "NEUTRAL" ? "WRONG" : c.verdict };
    }
    return c;
  });
}

/** Convert a pair to a prophecy INPUT (not a Prophecy row — the oracle's
 *  LLM generator owns the final claim phrasing). Returns the structured
 *  context the generator can fold into its prompt. */
export function archaeologyPairToProphecyInput(pair: ArchaeologyPair): {
  claim: string;
  rationale: string;
  falsifiabilityCriterion: string;
  domain: string;
  contextSha: string;
} {
  const files = pair.overlappingFiles.length > 0 ? pair.overlappingFiles : pair.wrong.files;
  const filesStr = files.slice(0, 5).join(", ");
  return {
    claim: `A future mutation of ${filesStr} will reintroduce the failure category that ${pair.wrong.shortHash} introduced and ${pair.correct.shortHash} fixed (${pair.correct.subject.slice(0, 80)}).`,
    rationale: `History pair (method: ${pair.method}): commit ${pair.wrong.shortHash} "${pair.wrong.subject.slice(0, 80)}" was reverted/fixed by ${pair.correct.shortHash} "${pair.correct.subject.slice(0, 80)}", overlapping on ${filesStr}. The same failure shape recurs when refactors touch the same region without the postmortem constraint.`,
    falsifiabilityCriterion: `Within the next 8 cycles, a mutation touching any of ${filesStr} fails the AST gate or review tribunal with a symptom matching the category of ${pair.wrong.shortHash} (e.g. dropped symbol, structural drift). Fulfilled if such a failure occurs; failed if 8 cycles pass without it; retired if the files are removed.`,
    domain: "archaeology",
    contextSha: pair.correct.sha,
  };
}
