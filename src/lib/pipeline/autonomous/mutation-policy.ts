/**
 * MUTATION POLICY — the loop's first LEARNED component (#6 on the 10/10
 * roadmap: "train a small model on the mutation corpus so the loop owns
 * a learned mutation policy, not just LLM calls").
 *
 * WHAT THIS IS
 * ────────────
 * A two-tier categorical model, trained from data the system already
 * collects, that answers ONE question: "which KINDS of transforms pass
 * the gates?" Its parameters are ESTIMATED FROM EVIDENCE (smoothed
 * frequencies with recency decay) — not hand-written rules, not an LLM
 * call. It is small, inspectable, and honest about its coverage.
 *
 * TIER A — OWN EXPERIENCE (the MutationCorpus)
 *   Every loop attempt is a row: the LLM's own change summary (the
 *   transform family) + the gate outcome. Laplace-smoothed pass rate
 *   per family, exponential recency decay (half-life 14d — old attempts
 *   go stale as the codebase and the LLM both change under them).
 *   DEFERS (reports insufficient) until a family has
 *   MIN_OWN_ATTEMPTS definitive outcomes — a pass rate over 3 attempts
 *   is noise wearing a number's clothes.
 *
 * TIER B — WILD PRIOR (the GitHistory-Sync archive you pushed:
 *   memory/commit-history.{successful,failed}.json — ~9.5k successful
 *   and ~1.6k failed harvested commits)
 *   Footprint-level success/failure rates from OTHER systems' history.
 *   This is BORROWED evidence and is labeled as such in every block it
 *   injects. Confounders, declared up front:
 *     - single-repo-dominant (ragflow) — domain bias
 *     - mixed human + AI authors
 *     - the "failed" heuristics vary in strength: reverted (gold
 *       standard) and ci-failed are strong; regex-fail (the message
 *       merely matches a failure pattern) counts at half weight
 *     - wild "success" means "merged", not "passed a gauntlet" — a
 *       different, weaker bar than the loop's own gates
 *
 * HONESTY RULES (this module's contract)
 *   - Never states a rate with fewer than the minimum supporting
 *     attempts — deferred cells say "deferred (N<min)".
 *   - Never mixes tiers in one number: own pass-rate and wild
 *     success-rate are reported as separate, labeled columns.
 *   - The injected block is a PRIOR, framed as such ("weigh this, do
 *     not obey it") — the gates still decide.
 *   - Bounded: the prompt block is capped at POLICY_BLOCK_BUDGET chars.
 *
 * INTEGRITY: this module shapes prompt content, so it belongs in the
 * same protection class as githistory-corpus (see PROTECTED_FILES).
 *
 * Leaf: db + githistory-corpus only. No LLM, no fs, no git.
 */

import { db } from "@/lib/db";
import { getWildCommits } from "./githistory-corpus";

// ── Constants (all tunable, all documented) ──────────────────────────

/** Minimum definitive outcomes before an OWN-family cell reports a rate. */
const MIN_OWN_ATTEMPTS = 10;
/** Laplace smoothing strength (pseudo-counts per cell). */
const SMOOTHING = 2;
/** Own-tier recency half-life in days: an attempt from 14d ago carries
 *  half the weight of one from today. The codebase and the LLM both
 *  drift; stale evidence must fade. */
const OWN_HALF_LIFE_DAYS = 14;
/** Wild-tier recency half-life in days: the archive spans ~3 years; a
 *  2023 commit says less about 2026 practices than a recent one. */
const WILD_HALF_LIFE_DAYS = 180;
/** Half-weight for heuristic:regex-fail failures (weakest evidence). */
const REGEX_FAIL_WEIGHT = 0.5;
/** Full weight for heuristic:reverted / heuristic:ci-failed. */
const STRONG_FAIL_WEIGHT = 1;
/** Prompt block budget — the strategy hint must never crowd out the
 *  file content it is supposed to improve. */
export const POLICY_BLOCK_BUDGET = 900;
/** Cache TTL: the policy is re-estimated at most this often (the corpus
 *  grows by a few rows per cycle; per-cycle retraining is waste). */
const POLICY_TTL_MS = 5 * 60 * 1000;
/** Cap on corpus rows scanned for the own tier (matches the corpus's
 *  retention trim — see mutation-corpus.ts CORPUS_RETENTION). */
const OWN_ROWS_TAKE = 2000;

// ── Transform families ───────────────────────────────────────────────
// The shared vocabulary: the loop's own summaries (Tier A) and the wild
// footprints (Tier B) both normalize into THESE families, so the two
// tiers are directly comparable, column for column.

export type TransformFamily =
  | "behavior-fix" // fixing a bug / changing runtime behavior
  | "additive" // new capability, new export, new path
  | "structural" // extract/split/consolidate/move — shape, not behavior
  | "typing" // type annotations, narrowing, generics
  | "guard" // error handling, edge cases, defensive checks
  | "docs" // comments, jsdoc, naming clarity
  | "perf" // memoization, caching, algorithmic cost
  | "hygiene" // deps, chores, CI, formatting
  | "other"; // everything unclassified (reported, never recommended

const OWN_FAMILY_RULES: ReadonlyArray<readonly [TransformFamily, RegExp]> = [
  // Order matters: most-specific first. "extract + error handling" is a
  // guard-flavored structural change; the first rule to match wins and
  // the summary's EMPHASIS (first matching keyword) is the family.
  // Patterns match word STARTS (\bextract matches "Extracted",
  // "extracting", "extraction"; \bbug matches "bugfix") — the LLM's
  // change summaries are natural language, and a trailing \b would
  // miss every inflected form.
  ["guard", /\b(error|guard|handle|null|undefined|edge[- ]case|defensive|fallback|try|catch|throw)\w*/i],
  ["perf", /\b(perf|performance|memo|cache|optimi[sz]e|fast|slow|latency|bundle|allocat)\w*/i],
  ["typing", /\b(type|typing|annotation|generic|narrow|unknown|signature|infer)\w*/i],
  ["structural", /\b(extract|split|modular|consolidat|merge|move|inlin|dedupe|restructur|refactor|simplif)\w*/i],
  ["additive", /\b(add|new|introduce|feature|support|enable|extend|implement)\w*/i],
  ["behavior-fix", /\b(fix|bug|broken|incorrect|wrong|repair|correct|crash)\w*/i],
  ["docs", /\b(comment|doc|jsdoc|readme|naming|rename|clarif|explain|label)\w*/i],
  ["hygiene", /\b(chore|dep|lint|format|ci|import|unused|cleanup|tidy)\w*/i],
];

/** Derive the transform family from the LLM's own first-meaningful-line
 *  change summary. Pure + total: everything lands in a family. */
export function deriveOwnFamily(transformSummary: string | null | undefined): TransformFamily {
  if (!transformSummary) return "other";
  for (const [family, re] of OWN_FAMILY_RULES) {
    if (re.test(transformSummary)) return family;
  }
  return "other";
}

/** Normalize a wild footprint string (the archive's vocabulary is messy:
 *  "bugfix", "bug_fix", "bugfix (ui)", "fix (agent)", "refa", "go"…). */
export function normalizeWildFootprint(footprint: string): TransformFamily {
  const f = footprint.trim().toLowerCase();
  if (!f) return "other";
  if (/^(bug[_-]?fix|fix|hotfix)/.test(f)) return "behavior-fix";
  if (/^(feat|feature|enhance)/.test(f)) return "additive";
  if (/^(refactor|refa|restructur|clean)/.test(f)) return "structural";
  if (/^(doc|docs|documentation|comment)/.test(f)) return "docs";
  if (/^(chore|ci|build|test|style|deps?)/.test(f)) return "hygiene";
  if (/^(perf|optimi)/.test(f)) return "perf";
  if (/^(type|typing)/.test(f)) return "typing";
  if (/^(revert)/.test(f)) return "other"; // a revert is an OUTCOME, not a transform family
  return "other";
}

// ── Cell types ───────────────────────────────────────────────────────

export interface OwnFamilyCell {
  family: TransformFamily;
  /** Definitive outcomes (pass = enhanced, fail = a FAILURE_OUTCOMES
   *  member). Neutral outcomes (no-change, cosmetic, skipped…) are
   *  excluded — they carry no gate signal. */
  attempts: number;
  passes: number;
  /** Recency-weighted, Laplace-smoothed pass rate in [0,1]. */
  passRate: number;
  /** True when attempts < MIN_OWN_ATTEMPTS — the cell reports no rate. */
  deferred: boolean;
}

export interface WildFamilyCell {
  family: TransformFamily;
  successWeight: number;
  /** failureWeight uses evidence weights: reverted/ci-failed full,
   *  regex-fail half. */
  failureWeight: number;
  /** Smoothed success rate in [0,1] over the weighted masses. */
  successRate: number;
  /** The raw (unweighted) commit counts, for honest reporting. */
  successfulCommits: number;
  failedCommits: number;
}

export interface MutationPolicy {
  own: {
    cells: OwnFamilyCell[];
    totalDefinitive: number;
    /** True when the own tier has enough total data to speak at all. */
    active: boolean;
  };
  wild: {
    cells: WildFamilyCell[];
    successfulCommits: number;
    failedCommits: number;
    repos: string[];
    generatedAt: string | null;
    /** Strong-vs-weak failure evidence split (for the confounder note). */
    strongFailures: number;
    weakFailures: number;
  };
  trainedAt: string;
}

// ── Training ─────────────────────────────────────────────────────────

/** Definitive-failure gate outcomes (mirrors mutation-corpus's
 *  FAILURE_OUTCOMES — duplicated deliberately: this module is a leaf
 *  and must not import the corpus's write-path module). */
const FAILURE_OUTCOMES = new Set([
  "typecheck-fail",
  "debate-fail",
  "test-fail",
  "truncation",
  "schema-rejected",
]);

/** Exponential recency weight: 1.0 today, 0.5 at the half-life, → 0. */
function decayWeight(atMs: number, nowMs: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (nowMs - atMs) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

interface PolicyCache {
  policy: MutationPolicy;
  at: number;
}
let policyCache: PolicyCache | null = null;

/** Train (or return the cached) mutation policy. Both tiers are
 *  fail-soft: a DB error degrades to an empty own tier; a missing
 *  archive degrades to an empty wild tier. Neither ever throws. */
export async function getMutationPolicy(): Promise<MutationPolicy> {
  const now = Date.now();
  if (policyCache && now - policyCache.at < POLICY_TTL_MS) return policyCache.policy;

  const nowMs = now;
  const trainedAt = new Date(nowMs).toISOString();

  // ── Tier A: own experience ──────────────────────────────────────
  const ownCells: OwnFamilyCell[] = [];
  let ownTotal = 0;
  try {
    const d = (db as unknown as { mutationCorpus?: { findMany: (a: unknown) => Promise<unknown[]> } }).mutationCorpus;
    if (typeof d?.findMany === "function") {
      const rows = (await d.findMany({
        orderBy: { createdAt: "desc" },
        take: OWN_ROWS_TAKE,
        select: { gateOutcome: true, transformSummary: true, createdAt: true },
      })) as Array<{ gateOutcome: string; transformSummary: string | null; createdAt: Date }>;

      const acc = new Map<TransformFamily, { wPass: number; wFail: number; n: number; passes: number }>();
      for (const r of rows) {
        const pass = r.gateOutcome === "enhanced";
        const fail = FAILURE_OUTCOMES.has(r.gateOutcome);
        if (!pass && !fail) continue; // neutral outcome — no gate signal
        const family = deriveOwnFamily(r.transformSummary);
        const w = decayWeight(new Date(r.createdAt).getTime() || 0, nowMs, OWN_HALF_LIFE_DAYS);
        const cell = acc.get(family) ?? { wPass: 0, wFail: 0, n: 0, passes: 0 };
        if (pass) { cell.wPass += w; cell.passes += 1; } else { cell.wFail += w; }
        cell.n += 1;
        acc.set(family, cell);
      }
      for (const [family, c] of acc) {
        ownTotal += c.n;
        ownCells.push({
          family,
          attempts: c.n,
          passes: c.passes,
          passRate: (c.wPass + SMOOTHING / 2) / (c.wPass + c.wFail + SMOOTHING),
          deferred: c.n < MIN_OWN_ATTEMPTS,
        });
      }
      ownCells.sort((a, b) => b.passRate - a.passRate || b.attempts - a.attempts);
    }
  } catch (error) {
    console.error("mutation-policy: own tier degraded:", error instanceof Error ? error.message : String(error));
  }

  // ── Tier B: wild prior ─────────────────────────────────────────
  const wildCells: WildFamilyCell[] = [];
  let wildSucc = 0;
  let wildFail = 0;
  let strongFail = 0;
  let weakFail = 0;
  const repos = new Set<string>();
  let generatedAt: string | null = null;
  try {
    const wild = getWildCommits();
    generatedAt = wild.generatedAt;
    const acc = new Map<TransformFamily, { sW: number; fW: number; s: number; f: number }>();
    const bump = (family: TransformFamily, succW: number, failW: number, isSucc: boolean) => {
      const cell = acc.get(family) ?? { sW: 0, fW: 0, s: 0, f: 0 };
      if (isSucc) { cell.sW += succW; cell.s += 1; } else { cell.fW += failW; cell.f += 1; }
      acc.set(family, cell);
    };
    for (const c of wild.successful) {
      wildSucc += 1;
      if (c.repo) repos.add(c.repo);
      const w = decayWeight(Date.parse(c.date) || 0, nowMs, WILD_HALF_LIFE_DAYS);
      bump(normalizeWildFootprint(c.footprint), w, 0, true);
    }
    for (const c of wild.failed) {
      wildFail += 1;
      if (c.repo) repos.add(c.repo);
      const w = decayWeight(Date.parse(c.date) || 0, nowMs, WILD_HALF_LIFE_DAYS);
      const evidence = c.source === "heuristic:regex-fail" ? REGEX_FAIL_WEIGHT : STRONG_FAIL_WEIGHT;
      if (evidence < STRONG_FAIL_WEIGHT) weakFail += 1; else strongFail += 1;
      bump(normalizeWildFootprint(c.footprint), 0, w * evidence, false);
    }
    for (const [family, c] of acc) {
      wildCells.push({
        family,
        successWeight: c.sW,
        failureWeight: c.fW,
        successRate: (c.sW + SMOOTHING / 2) / (c.sW + c.fW + SMOOTHING),
        successfulCommits: c.s,
        failedCommits: c.f,
      });
    }
    wildCells.sort((a, b) => b.successRate - a.successRate || b.successfulCommits - a.successfulCommits);
  } catch (error) {
    console.error("mutation-policy: wild tier degraded:", error instanceof Error ? error.message : String(error));
  }

  const policy: MutationPolicy = {
    own: { cells: ownCells, totalDefinitive: ownTotal, active: ownTotal >= MIN_OWN_ATTEMPTS },
    wild: {
      cells: wildCells,
      successfulCommits: wildSucc,
      failedCommits: wildFail,
      repos: [...repos].slice(0, 8),
      generatedAt,
      strongFailures: strongFail,
      weakFailures: weakFail,
    },
    trainedAt,
  };
  policyCache = { policy, at: now };
  return policy;
}

/** Test hook: drop the cache so the next call re-trains. */
export function __resetPolicyCacheForTests(): void {
  policyCache = null;
}

// ── The prompt block ─────────────────────────────────────────────────

/**
 * The strategy hint injected into refactor-mode enhance prompts. Content
 * depends on coverage, in strict honesty order:
 *   1. Own tier active AND at least one family speaks (≥ MIN_OWN_ATTEMPTS)
 *      → own top/bottom families (labeled OWN).
 *   2. Otherwise, wild tier present → wild families (labeled WILD PRIOR —
 *      borrowed evidence, confounders named, own N stated).
 *   3. Both empty → "" (no block — silence is more honest than a
 *      fabricated prior).
 * Always ends with the prior-not-command framing. Budget-capped.
 */
export async function buildMutationPolicyBlock(): Promise<string> {
  let policy: MutationPolicy;
  try {
    policy = await getMutationPolicy();
  } catch {
    return "";
  }

  const lines: string[] = [];
  const ownSpeakable = policy.own.cells.filter((c) => !c.deferred);

  if (policy.own.active && ownSpeakable.length > 0) {
    lines.push("--- MUTATION POLICY (learned from OWN gate history) ---");
    lines.push("Recent gate outcomes by transform family (pass rate, recency-weighted):");
    for (const c of ownSpeakable.slice(0, 4)) {
      lines.push(`  ${c.family}: ${(c.passRate * 100).toFixed(0)}% over ${c.attempts} attempt(s)`);
    }
    const worst = ownSpeakable[ownSpeakable.length - 1];
    if (worst && worst.passRate < 0.4) {
      lines.push(`Historically weakest: ${worst.family} at ${(worst.passRate * 100).toFixed(0)}% — avoid that shape unless the file demands it.`);
    }
  } else if (policy.wild.cells.length > 0) {
    lines.push("--- MUTATION POLICY (WILD PRIOR — borrowed evidence, not this loop's own gates) ---");
    lines.push(
      `Own gate history is too thin to speak (${policy.own.totalDefinitive} definitive outcomes, need ${MIN_OWN_ATTEMPTS}). Falling back to the harvested fleet archive (${policy.wild.successfulCommits} successful / ${policy.wild.failedCommits} failed commits, ${policy.wild.repos.length} repo(s)).`
    );
    lines.push("Wild success rate by change kind (smoothed, recency-weighted):");
    const speakable = policy.wild.cells.filter((c) => c.successfulCommits + c.failedCommits >= 20);
    for (const c of speakable.slice(0, 4)) {
      lines.push(`  ${c.family}: ${(c.successRate * 100).toFixed(0)}% over ${c.successfulCommits + c.failedCommits} commits`);
    }
    lines.push("Confounders: foreign repos, mixed human+AI authors, 'success' there means merged (a weaker bar than this loop's gates).");
  } else {
    return "";
  }

  lines.push("Weigh this prior — do not obey it. The typecheck, debate, and test gates decide.");
  lines.push("--- END MUTATION POLICY ---");

  const block = `\n${lines.join("\n")}\n`;
  return block.length <= POLICY_BLOCK_BUDGET
    ? block
    : `${block.slice(0, POLICY_BLOCK_BUDGET - 30)}\n--- END MUTATION POLICY (truncated) ---\n`;
}

// ── The operator report (route + console command) ────────────────────

export interface PolicyReport extends MutationPolicy {
  constants: {
    minOwnAttempts: number;
    smoothing: number;
    ownHalfLifeDays: number;
    wildHalfLifeDays: number;
    regexFailWeight: number;
    blockBudget: number;
  };
  verdict: string;
}

export async function buildPolicyReport(): Promise<PolicyReport> {
  const policy = await getMutationPolicy();
  const verdict = policy.own.active
    ? `active — own history speaks (${policy.own.totalDefinitive} definitive outcomes across ${policy.own.cells.length} family cells)`
    : policy.wild.cells.length > 0
      ? `deferred-to-wild — own history too thin (${policy.own.totalDefinitive} < ${MIN_OWN_ATTEMPTS}), wild prior available (${policy.wild.successfulCommits}+${policy.wild.failedCommits} commits)`
      : "silent — no own history and no wild archive (both tiers empty)";
  return {
    ...policy,
    constants: {
      minOwnAttempts: MIN_OWN_ATTEMPTS,
      smoothing: SMOOTHING,
      ownHalfLifeDays: OWN_HALF_LIFE_DAYS,
      wildHalfLifeDays: WILD_HALF_LIFE_DAYS,
      regexFailWeight: REGEX_FAIL_WEIGHT,
      blockBudget: POLICY_BLOCK_BUDGET,
    },
    verdict,
  };
}
