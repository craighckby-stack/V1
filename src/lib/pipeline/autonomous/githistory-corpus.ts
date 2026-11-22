/**
 * GITHISTORY CORPUS — the external fleet-history bridge.
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * The operator runs a sibling project (craighckby-stack/GitHistory-Sync)
 * that classifies commits across the whole repo fleet (dual-LLM +
 * heuristics) and harvests "engines" — full source files of the agent
 * loops, orchestrators, RAG retrievers, sandboxes and memory-state
 * modules from 17 sibling deployments (EMG, loop-v2, Aether_Forge,
 * Darlek-caan, V1, …). The corpus lands in this repo as three JSON
 * files under memory/ (pushed by the GitHistory-Sync archive commits):
 *
 *   memory/commit-history.engines.json      117 engines, full code
 *   memory/commit-history.failed.json      4165 classified commits
 *   memory/commit-history.successful.json  2192 classified commits
 *
 * This module turns that static dump into THREE live inputs:
 *
 *   1. FLEET DIGEST (getFleetDigest) — aggregate stats appended to the
 *      lesson distiller's history digest: what the fleet's successful
 *      changes looked like, and an HONEST read of the "failed" bucket
 *      (≈97% is "CI state is pending" — unverified, NOT proven-failed;
 *      the digest says so explicitly, because a lesson distilled from
 *      a misread corpus is worse than no lesson).
 *
 *   2. PRIOR-ART SEARCH (searchEngines + formatPriorArtBlock) — the
 *      same keyword-overlap retrieval the ancestral RAG uses, run over
 *      the engine INDEX (role, classNames, functionNames, path). When
 *      the loop enhances its own orchestrator and 6 sibling repos
 *      already solved orchestration differently, the enhance prompt
 *      names that prior art: patterns to consider, never code to copy
 *      (imports/APIs differ; a verbatim graft would fail typecheck).
 *
 *   3. STATUS (getCorpusStatus) — operator-facing counts for the
 *      `memory` console command.
 *
 * HONESTY RULES (this module's contract):
 *   - The corpus is EXTERNAL evidence about OTHER systems. Everything
 *     it injects is labeled as data, fence-scrubbed, and bounded.
 *   - The "failed" bucket is dominated by CI-unverified commits; the
 *     digest reports that split instead of laundering it into
 *     "failures" (a lesson built on a false premise compounds badly).
 *   - Engines are metadata-only in prompts — fullCode is loaded from
 *     disk ONLY for the index build (line count already in metadata);
 *     prompts never carry foreign source bodies (size + injection
 *     surface + verbatim-copy temptation).
 *
 * INTEGRITY: this module shapes prompt content (the learning substrate
 * injection path), so it lives in PROTECTED_FILES — same class as
 * arch-context.ts and the ancestral RAG. A corrupted version could
 * fabricate prior art or mislabel fleet stats into every prompt.
 *
 * Pure-ish leaf: fs + path + PROJECT_ROOT + prompt-scrub. No DB, no
 * LLM, no pipeline imports beyond the scrub — safe from anywhere.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";
import { scrubSectionMarkers } from "../core/prompt-scrub";

const CORPUS_DIR = join(PROJECT_ROOT, "memory");
const ENGINES_FILE = join(CORPUS_DIR, "commit-history.engines.json");
const FAILED_FILE = join(CORPUS_DIR, "commit-history.failed.json");
const SUCCESSFUL_FILE = join(CORPUS_DIR, "commit-history.successful.json");

/** Sanity ceiling — the real files are ~1.9/3.3/1.7 MB; a file 3× the
 *  expected total is not a corpus, it's an accident (or an attack). */
const MAX_CORPUS_FILE_BYTES = 64 * 1024 * 1024;

/** Engine metadata — the searchable face of one harvested source file.
 *  `fullCode` exists in the JSON but is deliberately NOT part of this
 *  interface: the index never holds it, prompts never see it. */
export interface GitHistoryEngine {
  id: string;
  repo: string;
  branch: string;
  filePath: string;
  language: string;
  role: string;
  byteSize: number;
  lineCount: number;
  classNames: string[];
  functionNames: string[];
  imports: string[];
  redacted: boolean;
}

interface GitHistoryCommit {
  sha: string;
  repo: string;
  date: string;
  footprint: string;
  reason?: string;
  message: string;
  source?: string;
}

interface CorpusCache {
  engines: GitHistoryEngine[];
  failed: GitHistoryCommit[];
  successful: GitHistoryCommit[];
  generatedAt: string | null;
}

let cache: CorpusCache | null = null;
let cacheAttempted = false;

const STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "from", "that", "this", "src", "lib", "app",
  "com", "craighckby", "stack", "main", "index", "ts", "tsx", "js",
  "utils", "util", "core",
]);

function tokenize(text: string): string[] {
  // Hyphens are SEPARATORS here (unlike emg-rag): the corpus roles are
  // hyphenated compounds ("agent-loop", "rag-retrieval", "memory-state")
  // and queries arrive as space-separated words ("agent loop", "rag
  // retrieval") — keeping hyphens glued would make the two forms never
  // match. Splitting both sides on the same class unifies them.
  return text
    .toLowerCase()
    .split(/[^a-z0-9_+]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/** Read + parse one corpus file with every guard fail-soft (missing,
 *  oversized, bad JSON, wrong shape → component simply absent). */
function readCorpusFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    const size = statSync(path).size;
    if (size <= 0 || size > MAX_CORPUS_FILE_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return (parsed as T) ?? null;
  } catch {
    return null;
  }
}

/** Parse the engines file. The schema is githistory-sync/engines-v1:
 *  { engines: [...], loopMemory: { generatedAt, ... } }. Only the
 *  metadata fields survive into the index. */
function parseEngines(): { engines: GitHistoryEngine[]; generatedAt: string | null } {
  type EnginesFile = {
    engines?: unknown;
    loopMemory?: { generatedAt?: unknown };
    generatedAt?: unknown;
  };
  const file = readCorpusFile<EnginesFile>(ENGINES_FILE);
  if (!file || !Array.isArray(file.engines)) return { engines: [], generatedAt: null };
  const out: GitHistoryEngine[] = [];
  for (const e of file.engines) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.filePath !== "string") continue;
    out.push({
      id: r.id,
      repo: typeof r.repo === "string" ? r.repo : "",
      branch: typeof r.branch === "string" ? r.branch : "main",
      filePath: r.filePath,
      language: typeof r.language === "string" ? r.language : "",
      role: typeof r.role === "string" ? r.role : "",
      byteSize: typeof r.byteSize === "number" ? r.byteSize : 0,
      lineCount: typeof r.lineCount === "number" ? r.lineCount : 0,
      classNames: Array.isArray(r.classNames) ? (r.classNames as unknown[]).filter((x): x is string => typeof x === "string") : [],
      functionNames: Array.isArray(r.functionNames) ? (r.functionNames as unknown[]).filter((x): x is string => typeof x === "string") : [],
      imports: Array.isArray(r.imports) ? (r.imports as unknown[]).filter((x): x is string => typeof x === "string") : [],
      redacted: r.redacted === true,
    });
  }
  const gen =
    typeof file.loopMemory?.generatedAt === "string" ? file.loopMemory.generatedAt :
    typeof file.generatedAt === "string" ? file.generatedAt : null;
  return { engines: out, generatedAt: gen };
}

/** Parse a commits file (schema githistory-sync/v3). */
function parseCommits(path: string): GitHistoryCommit[] {
  type CommitsFile = { commits?: unknown };
  const file = readCorpusFile<CommitsFile>(path);
  if (!file || !Array.isArray(file.commits)) return [];
  const out: GitHistoryCommit[] = [];
  for (const c of file.commits) {
    if (typeof c !== "object" || c === null) continue;
    const r = c as Record<string, unknown>;
    if (typeof r.sha !== "string" || typeof r.message !== "string") continue;
    out.push({
      sha: r.sha,
      repo: typeof r.repo === "string" ? r.repo : "",
      date: typeof r.date === "string" ? r.date : "",
      footprint: typeof r.footprint === "string" ? r.footprint : "",
      reason: typeof r.reason === "string" ? r.reason : undefined,
      message: r.message,
      source: typeof r.source === "string" ? r.source : undefined,
    });
  }
  return out;
}

/** Lazy one-shot load. cacheAttempted prevents re-reading on every
 *  prompt build (the files are ~7 MB total); the corpus is a static
 *  archive, so a process-lifetime cache is the right granularity. A
 *  refreshed archive arrives with the next process restart (or a dev
 *  server reload), same as every other boot-time constant. */
function loadCorpus(): CorpusCache {
  if (cache) return cache;
  if (cacheAttempted) return cache ?? { engines: [], failed: [], successful: [], generatedAt: null };
  cacheAttempted = true;
  const { engines, generatedAt } = parseEngines();
  cache = {
    engines,
    failed: parseCommits(FAILED_FILE),
    successful: parseCommits(SUCCESSFUL_FILE),
    generatedAt,
  };
  return cache;
}

/** Test hook: drop the cache so a rewritten corpus file is re-read. */
export function __resetCorpusCacheForTests(): void {
  cache = null;
  cacheAttempted = false;
}

/** The commit-level view of the archive, for the mutation policy's WILD
 *  tier (mutation-policy.ts trains on harvested success/failure evidence
 *  from the fleet). Read-only, backed by the same process-lifetime cache
 *  as searchEngines — no extra file reads. The returned objects are the
 *  internal cache rows (callers must treat them as immutable). */
export interface WildCommit {
  sha: string;
  repo: string;
  date: string;
  footprint: string;
  source?: string;
}

export function getWildCommits(): { successful: WildCommit[]; failed: WildCommit[]; generatedAt: string | null } {
  const corpus = loadCorpus();
  return {
    successful: corpus.successful,
    failed: corpus.failed,
    generatedAt: corpus.generatedAt,
  };
}

export interface EngineHit {
  engine: GitHistoryEngine;
  score: number;
  matchedTerms: string[];
}

/** Keyword search over the engine index — token overlap between the
 *  query and the engine's identity document (path + role + class and
 *  function names + repo name). Same retrieval philosophy as the
 *  ancestral RAG: local, synchronous, zero LLM cost, honest about what
 *  matched. */
export function searchEngines(keyword: string, limit = 3): EngineHit[] {
  if (!keyword || limit <= 0) return [];
  const corpus = loadCorpus();
  if (corpus.engines.length === 0) return [];
  const queryTokens = new Set(tokenize(keyword));
  if (queryTokens.size === 0) return [];
  const hits: EngineHit[] = [];
  for (const e of corpus.engines) {
    const doc = tokenize(
      `${e.filePath} ${e.role} ${e.classNames.join(" ")} ${e.functionNames.join(" ")} ${e.repo}`
    );
    const docSet = new Set(doc);
    const matched: string[] = [];
    for (const t of queryTokens) {
      if (docSet.has(t)) matched.push(t);
    }
    if (matched.length === 0) continue;
    // Overlap fraction of the query + a small bonus for rarer roles
    // (an "orchestrator" match is worth more than a "src" match would
    // be — though stop-words already removed the worst offenders).
    const score = matched.length / queryTokens.size;
    hits.push({ engine: e, score, matchedTerms: matched });
  }
  hits.sort((a, b) => b.score - a.score || b.matchedTerms.length - a.matchedTerms.length);
  return hits.slice(0, limit);
}

/** Prompt block naming the prior art. Bounded to top-3 engines, up to
 *  6 signature names each, fence-scrubbed, explicitly framed as
 *  patterns-not-code (a verbatim graft of foreign source fails the
 *  typecheck gates — the block says so, so the LLM doesn't try). */
export function formatPriorArtBlock(hits: EngineHit[]): string {
  if (hits.length === 0) return "";
  const OPEN = "--- PRIOR ART";
  const CLOSE = "--- END PRIOR ART ---";
  const lines: string[] = [
    "",
    "",
    `--- PRIOR ART (harvested engine index from ${hits.length} sibling deployment(s) solving similar problems) ---`,
  ];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const signatures = [...h.engine.functionNames, ...h.engine.classNames].slice(0, 6).join(", ");
    const repoShort = h.engine.repo.split("/").pop() || h.engine.repo;
    lines.push(
      `[${i + 1}] ${scrubSectionMarkers(
        `${h.engine.role} · ${repoShort}/${h.engine.filePath} (${h.engine.lineCount} lines, ${h.engine.language}, matched: ${h.matchedTerms.join(", ")})`,
        OPEN,
        CLOSE
      )}`
    );
    if (signatures) {
      lines.push(`    signatures: ${scrubSectionMarkers(signatures, OPEN, CLOSE)}`);
    }
  }
  lines.push("Use as design references only: their imports, APIs and runtimes differ from this codebase — never copy code verbatim (it would fail typecheck). Extract the pattern, not the text.");
  lines.push(CLOSE);
  return lines.join("\n");
}

/** Aggregate fleet digest for the distiller. Bounded (~700 bytes) and
 *  HONEST about the failed bucket: the dominant "failure" reason in
 *  the corpus is 'CI state is pending' — unverified, not disproven.
 *  The digest splits that out so the distiller can't build a lesson
 *  on a misread ("the fleet's changes usually fail" would be false). */
export function getFleetDigest(): string {
  const corpus = loadCorpus();
  const { engines, failed, successful, generatedAt } = corpus;
  if (engines.length === 0 && failed.length === 0 && successful.length === 0) return "";

  const repos = new Set<string>([...engines.map((e) => e.repo), ...failed.map((c) => c.repo), ...successful.map((c) => c.repo)]);

  // Success footprints — what the fleet's verified-good changes were.
  const succCounts = new Map<string, number>();
  for (const c of successful) succCounts.set(c.footprint, (succCounts.get(c.footprint) ?? 0) + 1);
  const topSucc = [...succCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f, n]) => `${f}:${n}`).join(", ");

  // Failure reasons — split CI-unverified from real signals.
  let ciPending = 0;
  const realReasons = new Map<string, number>();
  for (const c of failed) {
    if (c.reason && /CI state is pending/i.test(c.reason)) {
      ciPending++;
    } else if (c.reason) {
      const key = c.reason.length > 60 ? c.reason.slice(0, 60) + "…" : c.reason;
      realReasons.set(key, (realReasons.get(key) ?? 0) + 1);
    }
  }
  const topReal = [...realReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r, n]) => `${r} (${n})`).join("; ");

  const roles = new Map<string, number>();
  for (const e of engines) roles.set(e.role, (roles.get(e.role) ?? 0) + 1);
  const topRoles = [...roles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r, n]) => `${r}:${n}`).join(", ");

  const parts = [
    `External fleet history (GitHistory-Sync corpus${generatedAt ? `, generated ${generatedAt.slice(0, 10)}` : ""}) — evidence about SIBLING systems, not this one:`,
    `- Fleet: ${repos.size} repos, ${successful.length} verified-successful commits, ${failed.length} classified-failed commits, ${engines.length} harvested engines (${topRoles})`,
    `- Successful change footprints (top): ${topSucc || "(none)"}`,
    `- Failed bucket: ${ciPending} of ${failed.length} are "CI state pending" = UNVERIFIED, not proven failures — do not distill failure lessons from them. Substantive failure reasons: ${topReal || "(none recorded)"}`,
  ];
  return parts.join("\n");
}

/** Operator-facing status for the `memory` console command. */
export function getCorpusStatus(): {
  loaded: boolean;
  engines: number;
  failed: number;
  successful: number;
  repos: number;
  generatedAt: string | null;
} {
  const corpus = loadCorpus();
  const repos = new Set<string>([...corpus.engines.map((e) => e.repo), ...corpus.failed.map((c) => c.repo), ...corpus.successful.map((c) => c.repo)]);
  return {
    loaded: corpus.engines.length > 0 || corpus.failed.length > 0 || corpus.successful.length > 0,
    engines: corpus.engines.length,
    failed: corpus.failed.length,
    successful: corpus.successful.length,
    repos: repos.size,
    generatedAt: corpus.generatedAt,
  };
}
