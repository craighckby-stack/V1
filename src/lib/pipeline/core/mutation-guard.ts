/**
 * Mutation Guard — two-authority triage for proposed code mutations
 * (concept: Aether_Forge Ω repo's moralFilter + finalAuthority).
 *
 * The pipeline's AST gate checks SYMBOL retention; the sanitizer checks
 * for SECRETS; the debate tribunal checks QUALITY. None of them check
 * "is the LLM trying to ESCAPE its sandbox?" — that's this module's job.
 *
 * Two layers, run in order. The first is fast + synchronous and fails
 * CLOSED (evil → reject immediately, no debate LLM call); the second is
 * slower and structural.
 *
 *   1. TRIAGE (moralFilter analog) — synchronous, ~0ms.
 *      Scans the PROPOSED evolvedCode for HARD_EVIL_TOKENS that were NOT
 *      in the original code. The diff is the key adaptation: this codebase
 *      legitimately reads `process.env.GITHUB_TOKEN`, so a naive forbid
 *      would reject every refactor that touches env vars. Instead we
 *      reject only NEWLY-INTRODUCED dangerous patterns — the LLM adding
 *      `eval(` or `child_process` that wasn't there before is the escape
 *      signal. Path-traversal string literals get the same diff treatment.
 *      Narrative signals (comment churn, TODO density) cap at suspicion
 *      0.3 → UNSURE (proceed to finalAuthority, never auto-approve).
 *
 *   2. FINAL AUTHORITY (finalAuthority analog) — structural invariants.
 *      PROTECTED_FILES (the runtime/gates/UI control surface) ∪
 *      SCAFFOLDING_PROTECTED_PATHS (prisma/schema, package.json,
 *      next.config, .env, tsconfig, Caddyfile, start-dev.sh) — the loop
 *      can NEVER mutate these, period. Plus a non-empty-content invariant.
 *
 * DEFENSE-IN-DEPTH NOTE (Aether_Forge moralFilter): the HARD_EVIL_TOKENS
 * list here is INTENTIONALLY a separate list from any pattern in the
 * sanitizer. Two independently-maintained forbidden-token lists catch
 * more evasion attempts than one shared list re-used twice — if an
 * attacker (or a hallucinating LLM) crafts a token that slips past one
 * list's regex, the other list's different regex still catches it. Do
 * NOT "DRY these up" into a shared constant; the duplication is the
 * defense.
 *
 * The guard is WIRED into the unified pipeline at the start of stage 4
 * (before the debate tribunal). A rejection there blocks the stage and
 * halts the cycle — no LLM review call is spent on an obviously-evil
 * proposal, and no commit is attempted.
 */

import { isProtectedPath as sharedIsProtectedPath } from "../autonomous/protected-files";

// ── SCAFFOLDING paths the loop must never mutate ──────────────────────
// protected-files.ts (the shared source of truth) covers the runtime, the
// gates, the LLM wrappers, and the UI control surface. This list covers the
// SCAFFOLDING: the build config, the dependency manifest, the schema,
// the env file, the gateway config, the boot script. If the loop could
// rewrite these, it could (e.g.) add a dependency that exfiltrates the
// PAT on postinstall, or rewrite next.config to disable ESLint, or
// edit the Prisma schema to drop the audit tables. Matched by exact
// repo-relative path AND by basename (so "packages/x/package.json" is
// also protected, not just the root one).
export const SCAFFOLDING_PROTECTED_PATHS = new Set([
  "prisma/schema.prisma",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "tsconfig.json",
  "postcss.config.js",
  "postcss.config.mjs",
  "postcss.config.ts",
  "tailwind.config.ts",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "components.json",
  ".env",
  ".env.local",
  ".env.production",
  ".gitignore",
  "Caddyfile",
  "start-dev.sh",
  "middleware.ts",
  "eslint.config.js",
  "eslint.config.mjs",
]);

/** Basenames that are protected in ANY directory. Sourced from
 *  SCAFFOLDING_PROTECTED_PATHS so there's one place to edit. */
const SCAFFOLDING_BASENAMES = new Set(
  Array.from(SCAFFOLDING_PROTECTED_PATHS)
    .map((p) => p.split("/").pop()!)
    .filter((b) => !b.startsWith(".")) // .env etc. matched by exact path
);

/** AUDIT 3: this used to re-implement the protection check from scratch
 *  (PROTECTED_FILES exact-match only) and had DRIFTED — it did not check
 *  PROTECTED_PREFIXES, so a mutation of src/app/api/self-enhance/... on
 *  the remote-repo path passed finalAuthority here while being blocked by
 *  the shared predicate everywhere else. Now it LAYERS the shared check
 *  (single source of truth) + the scaffolding rules that only apply to
 *  this path. */
function isProtectedPath(filePath: string): boolean {
  if (sharedIsProtectedPath(filePath)) return true;
  if (SCAFFOLDING_PROTECTED_PATHS.has(filePath)) return true;
  const base = filePath.split("/").pop()!;
  if (SCAFFOLDING_BASENAMES.has(base)) return true;
  return false;
}

// ── HARD_EVIL_TOKENS — newly-introduced dangerous code patterns ──────
// Each entry is a regex. triageProposal checks: does this pattern match
// in the evolvedCode AND NOT in the originalCode? If yes → newly
// introduced → EVIL. The diff is what lets the codebase keep its
// legitimate `process.env.GITHUB_TOKEN` reads without false positives.
//
// KEEP THIS LIST SEPARATE FROM THE SANITIZER'S PATTERNS. See the
// defense-in-depth note in the module doc.
const HARD_EVIL_TOKENS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\beval\s*\(/, label: "eval(" },
  { pattern: /\bnew\s+Function\s*\(/, label: "new Function(" },
  { pattern: /\bFunction\s*\(\s*['"]/, label: "Function('...')" },
  { pattern: /\bchild_process\b/, label: "child_process" },
  { pattern: /\bshelljs\b/, label: "shelljs" },
  { pattern: /\b__import__\s*\(/, label: "__import__(" },
  { pattern: /\brequire\s*\(\s*['"]child_process['"]/, label: "require('child_process')" },
  { pattern: /\brequire\s*\(\s*['"]node:child_process['"]/, label: "require('node:child_process')" },
  { pattern: /\brequire\s*\(\s*['"]fs['"]/, label: "require('fs')" },
  { pattern: /\brequire\s*\(\s*['"]node:fs['"]/, label: "require('node:fs')" },
  { pattern: /\brequire\s*\(\s*['"]net['"]/, label: "require('net')" },
  { pattern: /\brequire\s*\(\s*['"]node:net['"]/, label: "require('node:net')" },
  { pattern: /\brequire\s*\(\s*['"]os['"]/, label: "require('os')" },
  { pattern: /import\s+[^;]*['"]child_process['"]/, label: "import child_process" },
  { pattern: /import\s+[^;]*['"]node:child_process['"]/, label: "import node:child_process" },
  { pattern: /import\s+[^;]*['"]node:fs['"]/, label: "import node:fs" },
  // ── Audit 3 (F3): empirically verified evasions, now closed ──────
  // Dynamic import: every `import ...` pattern above requires
  // whitespace after `import`, so `await import("child_process")`
  // slipped past ALL of them. Any dynamic import call is now a
  // first-class pattern (the diff keeps legitimate existing ones).
  { pattern: /\bimport\s*\(/, label: "dynamic import()" },
  // fetch with a NON-LITERAL argument (variable/concatenation): the old
  // literal-URL pattern couldn't see `fetch(u)` / `fetch(host + path)` —
  // an attacker-controlled URL in a variable evaded the host allowlist
  // check entirely. Any NEW fetch( call now trips the guard.
  { pattern: /\bfetch\s*\(/, label: "fetch(" },
  // Computed-member execution: only literal `globalThis['eval']` was
  // listed — `globalThis[k]` with a variable key (eval-by-concat)
  // evaded it. Any new computed globalThis/process member access is
  // now flagged.
  { pattern: /\bglobalThis\s*\[/, label: "globalThis[ (computed member)" },
  { pattern: /\bprocess\s*\[/, label: "process[ (computed member)" },
  { pattern: /String\s*\.\s*fromCharCode\s*\(/, label: "String.fromCharCode(" },
  { pattern: /\bXMLHttpRequest\b/, label: "XMLHttpRequest" },
  // Dynamic execution / reflection escape
  { pattern: /\bglobalThis\s*\[\s*['"]eval['"]\s*\]/, label: "globalThis['eval']" },
  { pattern: /\bprocess\s*\.\s*mainModule\b/, label: "process.mainModule" },
  { pattern: /\bprocess\s*\.\s*binding\s*\(/, label: "process.binding(" },
  // Weak crypto on a security-relevant path
  { pattern: /\bcreateHash\s*\(\s*['"]md5['"]/, label: "createHash('md5')" },
  { pattern: /\bcreateHash\s*\(\s*['"]sha1['"]/, label: "createHash('sha1')" },
];

// Path-traversal literals. A NEW `../` string that wasn't in the
// original is an escape attempt (the LLM trying to read/write outside
// the project root). Scope to string literals to avoid matching import
// paths like "../core/x" which are legitimate relative imports — we
// only flag `..` followed by a path separator inside a quoted string
// that's part of a fs/path operation.
const PATH_TRAVERSAL_PATTERN = /(['"`])(\.\.[\\/]){2,}\1/;

export type TriageVerdict = "good" | "evil" | "unsure";

export interface TriageResult {
  verdict: TriageVerdict;
  reasons: string[];
  suspicionScore: number; // 0.0 .. 1.0
}

/** Fast synchronous triage — the moralFilter analog. Fails CLOSED:
 *  evil → reject; unsure → proceed to finalAuthority (never auto-approve
 *  on narrative signals alone); good → proceed to finalAuthority. */
export function triageProposal(opts: {
  filePath: string;
  originalCode: string;
  evolvedCode: string;
}): TriageResult {
  const { originalCode, evolvedCode } = opts;
  const reasons: string[] = [];

  // CLIENT-COMPONENT EXEMPTION (audit 8 — the chat-task fetch false-
  // positive). The `fetch(` pattern in HARD_EVIL_TOKENS was added to
  // catch server-side escape attempts (a server module acquiring a new
  // `fetch(host + path)` with an attacker-controlled URL evades the
  // host allowlist). But client React components — files with a
  // `"use client"` directive — legitimately use `fetch("/api/...")` to
  // call the app's own routes. The guard was rejecting every chat-task
  // plan that generated a client panel (the oracle-task-feed-panel
  // goal hit this exactly: the LLM produced a correct React component
  // with `fetch("/api/self-enhance/tasks")`, and triage flagged it as
  // an escape attempt).
  //
  // The exemption: when the evolved code declares `"use client"`, the
  // `fetch(` pattern is SKIPPED from the HARD_EVIL_TOKENS diff. Every
  // other evil-token check (eval, child_process, dynamic import,
  // globalThis[...], etc.) still runs — a client component has no
  // business using any of those either. The fetch exemption is
  // narrow: only `fetch(`, only when `"use client"` is present.
  const isClientComponent = /^\s*["']use client["']\s*;?\s*(?:\r?\n|$)/m.test(
    evolvedCode
  );
  // Patterns exempted for client components (audit 8). Matched by
  // pattern.source (the regex string) so the Set membership check
  // works regardless of which object instance the pattern is — Set
  // compares by reference, and HARD_EVIL_TOKENS's patterns are not the
  // same object as the ones in this set even when their sources match.
  const exemptedPatternSources: ReadonlySet<string> = isClientComponent
    ? new Set([/\bfetch\s*\(/.source])
    : new Set();

  // 1. Newly-introduced HARD_EVIL_TOKENS → EVIL (suspicion 1.0).
  //    PER-OCCURRENCE diffing (audit 3, F3): the old boolean test
  //    (pattern present in evolved AND absent in original) was blind to
  //    MULTIPLICATION — a file that already contained one
  //    `require("fs")` could acquire UNLIMITED new ones because the
  //    pattern was already "in the original". We now count occurrences
  //    and flag any INCREASE (a decrease is always fine).
  for (const { pattern, label } of HARD_EVIL_TOKENS) {
    if (exemptedPatternSources.has(pattern.source)) continue; // audit 8: fetch exempted for client components
    const countIn = (code: string): number => {
        const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
        const re = new RegExp(pattern.source, flags);
        return (code.match(re) ?? []).length;
    };
    const evolvedCount = countIn(evolvedCode);
    if (evolvedCount === 0) continue;
    const originalCount = countIn(originalCode);
    if (evolvedCount > originalCount) {
      reasons.push(
        `newly-introduced dangerous token: ${label} ` +
          `(occurrences ${originalCount} → ${evolvedCount})`
      );
    }
  }
  // Path traversal — same diff treatment.
  if (PATH_TRAVERSAL_PATTERN.test(evolvedCode) && !PATH_TRAVERSAL_PATTERN.test(originalCode)) {
    reasons.push("newly-introduced path-traversal literal (../../)");
  }

  if (reasons.length > 0) {
    return { verdict: "evil", reasons, suspicionScore: 1.0 };
  }

  // 2. Narrative signals — cap at 0.3 → UNSURE. These are NOT evil on
  //    their own; they just mean "look closer in finalAuthority". A
  //    refactor that strips 80% of the code is suspicious but might be
  //    a legitimate simplification; let finalAuthority + the AST gate +
  //    the debate tribunal make the final call.
  let narrativeSuspicion = 0;
  if (originalCode.length > 0) {
    const ratio = evolvedCode.length / originalCode.length;
    if (ratio < 0.2 || ratio > 5) {
      // Shrunk to <20% or grew >5× — possible bloat injection or
      // destructive strip. Cap at 0.3 per the fail-CLOSED design.
      narrativeSuspicion = 0.3;
      reasons.push(
        `size ratio ${ratio.toFixed(2)} outside [0.2, 5.0] — requires finalAuthority review`
      );
    }
  }

  if (narrativeSuspicion >= 0.3) {
    return { verdict: "unsure", reasons, suspicionScore: narrativeSuspicion };
  }

  return { verdict: "good", reasons, suspicionScore: 0 };
}

export interface FinalAuthorityResult {
  allowed: boolean;
  reasons: string[];
}

/** Slower structural invariants — the finalAuthority analog. Called
 *  after triage returns good/unsure. Rejects mutations of protected
 *  paths (runtime gates + scaffolding), empty-content proposals, and
 *  convergent defensive no-ops (the loop's tendency to "improve" stable
 *  code by adding redundant input validation / null checks / fallbacks
 *  that change nothing observable — see detectConvergentMove below). */
export function finalAuthority(opts: {
  filePath: string;
  evolvedCode: string;
  originalCode: string;
}): FinalAuthorityResult {
  const reasons: string[] = [];

  // 1. Protected path — the loop can NEVER mutate its own scaffolding
  //    or control surface, no matter how benign the diff looks.
  if (isProtectedPath(opts.filePath)) {
    reasons.push(
      `protected path: ${opts.filePath} is in the runtime-gate or scaffolding protected set — the loop may not mutate its own scaffolding`
    );
  }

  // 2. Non-empty content invariant — a mutation that wipes the file
  //    to empty is either a bug or a destructive escape. (The AST gate
  //    would also catch this via symbol-drop, but the guard runs FIRST
  //    and is cheap.)
  if (!opts.evolvedCode.trim()) {
    reasons.push("evolvedCode is empty — a mutation must produce content");
  }

  // 3. Convergent-move detection — the loop's committed history showed
  //    88% of "Self-enhancement" commits in a 10-hour window were purely
  //    additive defensive guards on stable code: `let x;` → `let x: any;`,
  //    `{entry.trust}` → `{entry.trust ?? "unknown"}`, `typeof` checks
  //    wrapping existing checks, `?? []` fallbacks on already-guarded
  //    paths. Each one passes every other gate (typechecks, no symbol
  //    drop, debate approves "reasonable hardening") but changes NO
  //    observable behavior — the loop is justifying its own existence
  //    one no-op at a time. This check fails CLOSED on the pattern:
  //    small, predominantly-additive diff, dominated by the defensive-
  //    guard lexicon, with no behavioral signal (no new exports, no new
  //    functions, no new control flow). Test files are exempt — tests
  //    legitimately add defensive guards as characterization pins.
  const isTestFile =
    opts.filePath.endsWith(".test.ts") || opts.filePath.endsWith(".test.tsx");
  if (!isTestFile) {
    const cm = detectConvergentMove(opts.originalCode, opts.evolvedCode);
    if (cm.convergent) {
      reasons.push(`convergent-move rejected: ${cm.reason}`);
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

// ── Convergent-move detection ──────────────────────────────────────
// The loop's LLM, given an open-ended "improve this file" brief on
// stable code, converges on the lowest-friction move that passes every
// other gate: add a defensive guard that changes nothing. This section
// detects that pattern from the diff structure alone (the guard runs
// pre-commit, so the commit message is not yet available — and even if
// it were, the LLM's "## Changes" prose routinely overstates the diff,
// e.g. claiming 4 improvements for a 1-line type annotation).
//
// The heuristic is CONSERVATIVE by design — it requires ALL of:
//   1. Small total churn (≤ 30 changed lines)
//   2. Predominantly additive (added ≥ 3, removed ≤ 2)
//   3. Added lines ≥ 50% match the defensive-guard lexicon
//   4. Added lines contain NO behavioral signal (new exports / functions
//      / classes / throws)
// A mutation that fails any single condition passes this gate (and
// proceeds to the debate tribunal, which is the existing quality bar).

/** Lexicon of defensive-guard line patterns. A line matching any of
 *  these is counted as a "guard" line for density calculation. The list
 *  is intentionally specific to the convergent moves observed in the
 *  loop's own commit history — broadening it would false-positive on
 *  legitimate error handling. */
const CONVERGENT_MOVE_LEXICON: ReadonlyArray<RegExp> = [
  // typeof guards: `typeof x === "string"`, `typeof x !== "undefined"`
  /typeof\s+\w+\s*[!=]==?\s*['"`](?:string|number|boolean|undefined|object|function|symbol|bigint)['"`]/,
  // null/undefined checks: `if (x === null)`, `if (x == null)`, `if (!x)`,
  // `if (x === undefined)`, `x === null || x === undefined`
  /\bif\s*\(\s*!?\w+(?:\.\w+)*\s*(?:===|!==|==|!=)\s*(?:null|undefined)\b/,
  /\bif\s*\(\s*!\s*\w+(?:\.\w+)*\s*\)/,
  // Array type guards
  /\bArray\.isArray\s*\(/,
  // instanceof Error guards in catch blocks
  /instanceof\s+Error\b/,
  // Nullish-coalescing with literal default: `x ?? "default"`, `x ?? []`
  /\?\?\s*['"`][^'"`]*['"`]/,
  /\?\?\s*\[\s*\]/,
  /\?\?\s*\{\s*\}/,
  // OR-fallback with literal default: `x || "default"`, `x || []`
  /\|\|\s*['"`][^'"`]*['"`]/,
  /\|\|\s*\[\s*\]/,
  // Explicit any/unknown type annotations added to existing bindings
  /:\s*(?:any|unknown)\b/,
  // try { additions (new try-catch wrapping existing code)
  /\btry\s*\{/,
];

/** Lexicon of behavioral-change signals. If ANY added line matches one
 *  of these, the mutation is NOT a convergent move — it adds real
 *  surface area (a new export, a new function, a new class, a new
 *  throw). This is the escape hatch that lets legitimate defensive
 *  work that also adds a new helper pass through. */
const BEHAVIORAL_SIGNAL_LEXICON: ReadonlyArray<RegExp> = [
  // New exports
  /\bexport\s+(?:async\s+)?(?:function|const|let|var|class|default|interface|type|enum)\s+\w+/,
  // New function declarations (not arrow, not re-declarations)
  /\bfunction\s+\w+\s*\(/,
  // New class declarations
  /\bclass\s+\w+/,
  // New throw of a constructed error (not a re-throw of an existing one)
  /\bthrow\s+new\s+\w*Error\b/,
  // New interface/type declarations (extends the public contract)
  /\b(?:interface|type)\s+\w+\s*(?:<[^>]*>)?\s*(?:\{|=|extends)/,
];

/** Compute the added/removed line multiset for a code change. Uses a
 *  trimmed-line multiset (not a set — duplicates matter: adding a
 *  second `if (!x)` is still an additive guard even if the first one
 *  was already there). Whitespace-only lines are ignored. */
function computeLineDiff(
  original: string,
  evolved: string
): { added: string[]; removed: string[] } {
  const countLines = (code: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const raw of code.split("\n")) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
    return counts;
  };
  const origCounts = countLines(original);
  const evolvedCounts = countLines(evolved);
  const added: string[] = [];
  const removed: string[] = [];
  const allLines = new Set<string>(
    Array.from(origCounts.keys()).concat(Array.from(evolvedCounts.keys()))
  );
  for (const line of Array.from(allLines)) {
    const o = origCounts.get(line) ?? 0;
    const e = evolvedCounts.get(line) ?? 0;
    if (e > o) {
      for (let i = 0; i < e - o; i++) added.push(line);
    } else if (o > e) {
      for (let i = 0; i < o - e; i++) removed.push(line);
    }
  }
  return { added, removed };
}

export interface ConvergentMoveResult {
  convergent: boolean;
  reason: string;
}

/** Detect whether a diff is a convergent defensive no-op. See the
 *  section doc for the full contract. Returns { convergent: true,
 *  reason } when ALL four heuristic conditions hold; { convergent:
 *  false, reason } otherwise (with the reason explaining which
 *  condition failed — useful for the test suite and for debugging
 *  a surprising accept/reject). */
export function detectConvergentMove(
  originalCode: string,
  evolvedCode: string
): ConvergentMoveResult {
  const { added, removed } = computeLineDiff(originalCode, evolvedCode);

  // (0) No changes — not convergent, the loop's "No change" path
  //     handles this elsewhere.
  if (added.length === 0 && removed.length === 0) {
    return { convergent: false, reason: "no diff" };
  }

  // (1) Small total churn (≤ 30 changed lines). Large diffs are
  //     usually real work — a 200-line refactor that happens to add
  //     some guards is not the convergent pattern.
  const totalChurn = added.length + removed.length;
  if (totalChurn > 30) {
    return {
      convergent: false,
      reason: `diff too large (${totalChurn} > 30 changed lines)`,
    };
  }

  // (2) Predominantly additive. A mutation that removes as much as it
  //     adds is a refactor (real work), not a convergent no-op. The
  //     thresholds (added ≥ 3, removed ≤ 2) are tight: the convergent
  //     pattern is overwhelmingly "add 1-5 guard lines, remove 0-1".
  if (added.length < 3) {
    return {
      convergent: false,
      reason: `too few additions (${added.length} < 3)`,
    };
  }
  if (removed.length > 2) {
    return {
      convergent: false,
      reason: `has removals (${removed.length} > 2 — likely a real refactor)`,
    };
  }

  // (3) Added lines ≥ 50% match the defensive-guard lexicon. A
  //     mutation that adds 5 lines of which 2 are guards and 3 are
  //     real logic is not convergent — it's a guarded feature.
  //     SUBSTANTIVE-LINE FILTER: purely structural lines (`}`, `{`,
  //     `} catch {`, `return null;`, `return;`, bare `else`) are the
  //     syntactic scaffolding of a guard, not separate additions.
  //     Counting them in the denominator dilutes the density below
  //     the threshold for a legitimate try-catch wrap (e.g. `try {`
  //     + `} catch {` + `if (err instanceof Error) ...` + `return
  //     null;` + `}` = 5 added lines, 2 guard matches = 40% < 50%).
  //     These scaffolding lines are excluded from BOTH the numerator
  //     and the denominator — they neither help nor hurt the density.
  const isStructuralOnly = (line: string): boolean => {
    const s = line.trim();
    if (s.length === 0) return true;
    if (/^[{}();,]+$/.test(s)) return true; // bare braces / parens / semicolons
    if (/^\}\s*catch\s*(?:\([^)]*\))?\s*\{?$/.test(s)) return true; // `} catch {`
    if (/^\}\s*else\s*\{?$/.test(s)) return true; // `} else {`
    if (/^else\s*\{?$/.test(s)) return true; // `else {`
    if (/^return\s*(?:null|undefined)?\s*;?\s*$/.test(s)) return true; // `return;` / `return null;`
    if (/^return\s+(?:null|undefined|''|""|0|false)\s*;?\s*$/i.test(s)) return true;
    return false;
  };
  const substantiveAdded = added.filter((l) => !isStructuralOnly(l));
  if (substantiveAdded.length < 2) {
    return {
      convergent: false,
      reason: `too few substantive additions (${substantiveAdded.length} < 2)`,
    };
  }
  let guardMatches = 0;
  for (const line of substantiveAdded) {
    if (CONVERGENT_MOVE_LEXICON.some((re) => re.test(line))) {
      guardMatches++;
    }
  }
  const guardDensity =
    substantiveAdded.length > 0 ? guardMatches / substantiveAdded.length : 0;
  if (guardDensity < 0.5) {
    return {
      convergent: false,
      reason: `additions not guard-dominated (${guardMatches}/${substantiveAdded.length} substantive = ${(guardDensity * 100).toFixed(0)}% < 50%)`,
    };
  }

  // (4) NO behavioral signal in the added lines. A new export,
  //     function, class, or constructed throw means the mutation
  //     adds real surface area — it's not a pure no-op guard.
  const addedCode = added.join("\n");
  for (const re of BEHAVIORAL_SIGNAL_LEXICON) {
    if (re.test(addedCode)) {
      return {
        convergent: false,
        reason: `adds behavioral signal (matched ${re.source.slice(0, 40)})`,
      };
    }
  }

  // All four conditions hold — this is a convergent defensive no-op.
  return {
    convergent: true,
    reason: `${added.length} additive line(s), ${guardMatches} match defensive-guard lexicon (density ${(guardDensity * 100).toFixed(0)}%), no behavioral signal, ${removed.length} removal(s) — mutations must change observable behavior, not add guards to code that already works`,
  };
}

export interface MutationGateResult {
  /** True iff the mutation may proceed to the debate tribunal + commit. */
  allowed: boolean;
  /** Which layer produced the rejection (for the log + the stage detail). */
  rejectedBy: "triage" | "finalAuthority" | null;
  verdict: TriageVerdict;
  triage: TriageResult;
  finalAuthority: FinalAuthorityResult | null;
  /** Combined reason list for the log message. */
  reasons: string[];
}

/** Combined gate: triage first (fail-CLOSED), then finalAuthority.
 *  evil → reject (no finalAuthority). unsure/good → run finalAuthority.
 *  Returns the full breakdown so the pipeline can log exactly which
 *  layer rejected and why. */
export function gateMutation(opts: {
  filePath: string;
  originalCode: string;
  evolvedCode: string;
}): MutationGateResult {
  const triage = triageProposal(opts);
  if (triage.verdict === "evil") {
    return {
      allowed: false,
      rejectedBy: "triage",
      verdict: "evil",
      triage,
      finalAuthority: null,
      reasons: triage.reasons,
    };
  }
  const fa = finalAuthority(opts);
  return {
    allowed: fa.allowed,
    rejectedBy: fa.allowed ? null : "finalAuthority",
    verdict: triage.verdict,
    triage,
    finalAuthority: fa,
    reasons: fa.reasons,
  };
}
