/**
 * Auto Picker — deterministic target selection for the one-click gauntlet.
 *
 * The manual runner makes the operator pick a file by eye; auto mode has
 * to earn that choice. Two pure stages:
 *
 *   1. rankCandidateFiles(tree) — cheap path/size heuristics over the
 *      tree listing (NO fetches — anonymous GitHub is 60 req/hr, so we
 *      only spend fetches on the shortlist).
 *   2. pickBestFileToRefactor(scans) — static-analysis findings from
 *      target-scan (the SAME detectors the strict-gate target-runner
 *      uses), weighted by the same priority table. A file with real
 *      findings beats a prettier path every time.
 *
 * This module is PURE: no fs, no db, no network — the routes own I/O.
 */

import type { TargetTreeFile } from "../target/target-github";
import {
  isMutableTargetPath,
  TARGET_KIND_PRIORITY,
  type TargetFinding,
} from "../target/target-scan";

/** Below this a file is too thin to be worth an LLM pass. */
export const MIN_PICK_FILE_BYTES = 400;
/** Same cap as target-scan's MAX_TARGET_FILE_BYTES (Contents API + LLM context degrade past it). */
export const MAX_PICK_FILE_BYTES = 100_000;
/** How many shortlisted candidates the pick route fetches + scans by default. */
export const DEFAULT_PICK_FETCH_COUNT = 8;
export const MAX_PICK_FETCH_COUNT = 12;

export interface RankedCandidate {
  path: string;
  size: number;
  score: number;
}

/** Weight of one finding: priority 1 (todo-comment) → 7 … priority 6 (non-null) → 2. */
export function findingWeight(kind: keyof typeof TARGET_KIND_PRIORITY): number {
  return 8 - TARGET_KIND_PRIORITY[kind];
}

/**
 * Score a file's findings: sum of per-kind weights. Pure. An empty
 * finding set scores 0 (the caller decides whether to fall back).
 */
export function scoreFindings(findings: TargetFinding[]): number {
  let score = 0;
  for (const f of findings) score += findingWeight(f.kind);
  return score;
}

/**
 * Rank ALL mutable tree files by cheap path/size heuristics. Sorted
 * best-first; deterministic (score desc, then shallower path, then
 * lexicographic). Pure.
 */
export function rankCandidateFiles(files: TargetTreeFile[]): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const f of files) {
    if (!isMutableTargetPath(f.path)) continue;
    if (f.size < MIN_PICK_FILE_BYTES || f.size > MAX_PICK_FILE_BYTES) continue;

    const segments = f.path.split("/");
    const depth = segments.length;
    const base = segments[segments.length - 1];
    let score = 0;

    // Source dirs beat config/script/example scaffolding.
    if (segments[0] === "src") {
      score += 3;
    } else if (segments.includes("lib") || (depth >= 2 && segments[1] === "src")) {
      score += 2;
    }
    if (segments.some((s) => /^(scripts?|examples?|demos?|docs?|bench|benchmarks)$/i.test(s))) {
      score -= 2;
    }
    // Barrel files are re-export lists — low refactor value.
    if (/^index\.(ts|tsx|js|jsx)$/i.test(base)) {
      score -= 2;
    }
    // Config-shaped files (next.config.js wrapping etc.) — allowed but deprioritized.
    if (/\.config\.(ts|js|mts|cts|mjs|cjs)$/i.test(base)) {
      score -= 1;
    }
    // Sweet spot: big enough to matter, small enough for one LLM pass.
    if (f.size >= 1_000 && f.size <= 40_000) {
      score += 2;
    } else if (f.size < 1_000) {
      score -= 1;
    }
    // Deep nesting correlates with incidental files.
    if (depth > 4) {
      score -= (depth - 4) * 0.5;
    }

    ranked.push({ path: f.path, size: f.size, score });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = a.path.split("/").length;
    const db = b.path.split("/").length;
    if (da !== db) return da - db;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return ranked;
}

// ── BROAD picker (for auto-fork: learns from ANY source language) ──────
// The gauntlet's rankCandidateFiles (above) is TS/JS-only because the
// gauntlet's gates (AST diff, in-memory typecheck) are TypeScript-
// specific. Auto-fork distills LESSONS (patterns/principles), not
// refactors — the distill LLM call works on any text. So auto-fork
// uses this broad picker that accepts Python, Go, Rust, Java, etc.
// Same path/size heuristics; different (broader) extension filter.

/** Source-language extensions the broad picker accepts. Matches the
 *  dropbox ingester's TEXT_EXTENSIONS (the distill path is the same). */
export const BROAD_SOURCE_EXTENSIONS = new Set([
  // TypeScript / JavaScript
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  // Python (DeepSeek, DeepMind, ML research)
  ".py",
  // Go (infrastructure, CLIs)
  ".go",
  // Rust (systems, performance-critical)
  ".rs",
  // Java / Kotlin (IBM, enterprise)
  ".java", ".kt",
  // Swift (Apple)
  ".swift",
  // Ruby / PHP (web)
  ".rb", ".php",
  // Docs + config (patterns + conventions)
  ".md", ".txt", ".rst",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  // Styling + markup
  ".css", ".scss", ".html", ".xml", ".svg",
  // Shell
  ".sh", ".bash", ".zsh",
  // SQL
  ".sql",
]);

/** Test-file path patterns to exclude (any language). The gauntlet's
 *  isMutableTargetPath checks `\.test|spec\.[jt]sx?$`; the broad picker
 *  checks the same pattern for ANY extension + test/ __tests__/ dirs. */
const BROAD_TEST_PATTERN = /(^|\/)(tests?|__tests?__|spec|specs)\/|\.([a-z]+\.)?(test|spec)\.[a-z]+$/i;

/** Ignored directory segments (build artifacts, deps, vendored code). */
const BROAD_IGNORED_DIRS = /^(node_modules|dist|build|target|vendor|\.git|\.next|out|bin|obj|__pycache__|\.venv|venv|env|site-packages)$/i;

/** Check if a path is a broad-pickable source file: right extension,
 *  non-test, non-ignored-dir, reasonable name. Does NOT call
 *  isProtectedPath (auto-fork learns from EXTERNAL repos, not the self
 *  codebase — the protected-path check is irrelevant for externals). */
export function isBroadSourcePath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/").trim();
  if (!p || p.includes("..") || p.startsWith("/")) return false;
  const ext = "." + (p.split(".").pop() ?? "").toLowerCase();
  if (!BROAD_SOURCE_EXTENSIONS.has(ext)) return false;
  const base = p.split("/").pop() ?? "";
  if (base.startsWith(".")) return false;
  if (BROAD_TEST_PATTERN.test(p)) return false;
  const segments = p.split("/");
  for (const seg of segments.slice(0, -1)) {
    if (BROAD_IGNORED_DIRS.test(seg)) return false;
  }
  return true;
}

/** Rank ALL broad-pickable tree files by the same path/size heuristics
 *  as rankCandidateFiles, but with the broad extension set. Used by the
 *  auto-fork ingester (which learns from any source language). Pure. */
export function rankCandidateFilesBroad(files: TargetTreeFile[]): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const f of files) {
    if (!isBroadSourcePath(f.path)) continue;
    if (f.size < MIN_PICK_FILE_BYTES || f.size > MAX_PICK_FILE_BYTES) continue;

    const segments = f.path.split("/");
    const depth = segments.length;
    const base = segments[segments.length - 1];
    let score = 0;

    // Source dirs beat config/script/example scaffolding.
    if (segments[0] === "src" || segments[0] === "lib") {
      score += 3;
    } else if (depth >= 2 && (segments[1] === "src" || segments[1] === "lib")) {
      score += 2;
    }
    if (segments.some((s) => /^(scripts?|examples?|demos?|docs?|bench|benchmarks|tests?|test)$/i.test(s))) {
      score -= 2;
    }
    // Barrel files are re-export lists — low lesson value.
    if (/^index\.(ts|tsx|js|jsx|py|go|rs)$/i.test(base)) {
      score -= 2;
    }
    // Config-shaped files — allowed but deprioritized.
    if (/\.(config|conf|cfg)\.(ts|js|py|go|rs|java|kt)$/i.test(base)) {
      score -= 1;
    }
    // Sweet spot: big enough to matter, small enough for one LLM pass.
    if (f.size >= 1_000 && f.size <= 40_000) {
      score += 2;
    } else if (f.size < 1_000) {
      score -= 1;
    }
    // Deep nesting correlates with incidental files.
    if (depth > 4) {
      score -= (depth - 4) * 0.5;
    }
    // Hidden directories (.agents/, .github/, .vscode/, etc.) are meta/
    // config, not source. Deprioritize so actual source files rank higher.
    // Fixes repos like deepseek-ai/deepseek-harness where .agents/notes/
    // has 400+ markdown files that would otherwise dominate.
    if (segments.some((s) => s.startsWith("."))) {
      score -= 3;
    }
    // Code extensions get a bonus over doc/config extensions — a .py file
    // in apps/ should rank higher than a .md file at the root. The broad
    // picker accepts both, but when competing, source code beats docs.
    const ext = "." + (base.split(".").pop() ?? "").toLowerCase();
    const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".sh", ".sql"]);
    const DOC_EXTS = new Set([".md", ".txt", ".rst", ".yaml", ".yml", ".json", ".toml", ".ini", ".cfg", ".html", ".svg"]);
    if (CODE_EXTS.has(ext)) {
      score += 2;
    } else if (DOC_EXTS.has(ext)) {
      score -= 1;
    }

    ranked.push({ path: f.path, size: f.size, score });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = a.path.split("/").length;
    const db = b.path.split("/").length;
    if (da !== db) return da - db;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return ranked;
}

export interface FindingSummary {
  kind: TargetFinding["kind"];
  count: number;
}

/** Collapse findings to per-kind counts, most-urgent kind first. Pure. */
export function summarizeFindings(findings: TargetFinding[]): FindingSummary[] {
  const counts = new Map<TargetFinding["kind"], number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => TARGET_KIND_PRIORITY[a.kind] - TARGET_KIND_PRIORITY[b.kind]);
}

export interface FileScan {
  path: string;
  findings: TargetFinding[];
}

export interface PickDecision {
  path: string;
  score: number;
  findings: TargetFinding[];
  summary: FindingSummary[];
  /** true when no scanned file had findings — we fell back to the
   *  top-ranked candidate for a general prompt-driven refactor. */
  fallback: boolean;
  reason: string;
}

/**
 * Pick the file to mutate from the scanned shortlist (which MUST be in
 * rankCandidateFiles order for the fallback to honor path ranking).
 * Highest finding score wins; ties break by input order (i.e. path
 * rank). Pure. Returns null only for an empty shortlist.
 */
export function pickBestFileToRefactor(scans: FileScan[]): PickDecision | null {
  if (scans.length === 0) return null;

  let best: FileScan | null = null;
  let bestScore = -1;
  for (const s of scans) {
    const score = scoreFindings(s.findings);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }

  if (!best || bestScore <= 0) {
    const top = scans[0];
    return {
      path: top.path,
      score: 0,
      findings: top.findings,
      summary: summarizeFindings(top.findings),
      fallback: true,
      reason: `no static findings in ${scans.length} scanned candidates — general refactor on the top-ranked file`,
    };
  }

  return {
    path: best.path,
    score: bestScore,
    findings: best.findings,
    summary: summarizeFindings(best.findings),
    fallback: false,
    reason: `highest finding score (${bestScore}) of ${scans.length} scanned candidates`,
  };
}
