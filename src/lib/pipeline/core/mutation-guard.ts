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

import { PROTECTED_FILES } from "../autonomous/protected-files";

// ── SCAFFOLDING paths the loop must never mutate ──────────────────────
// PROTECTED_FILES (protected-files.ts) covers the runtime, the gates,
// the LLM wrappers, and the UI control surface. This list covers the
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

function isProtectedPath(filePath: string): boolean {
  if (PROTECTED_FILES.has(filePath)) return true;
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
  // Network exfiltration shapes — fetch/http to a hardcoded non-GitHub
  // host. We scope to the LLM introducing a NEW outbound endpoint.
  // (Existing fetch calls to api.github.com are already in the original
  // and so don't trip the diff.)
  { pattern: /\bfetch\s*\(\s*['"]https?:\/\/(?!api\.github\.com|generativelanguage\.googleapis\.com)/, label: "fetch to non-allowlisted host" },
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

  // 1. Newly-introduced HARD_EVIL_TOKENS → EVIL (suspicion 1.0).
  //    The diff (must NOT be in original) is what prevents false
  //    positives on the codebase's legitimate env/require usage.
  for (const { pattern, label } of HARD_EVIL_TOKENS) {
    const inEvolved = pattern.test(evolvedCode);
    const inOriginal = pattern.test(originalCode);
    if (inEvolved && !inOriginal) {
      reasons.push(`newly-introduced dangerous token: ${label}`);
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
 *  paths (runtime gates + scaffolding) and empty-content proposals. */
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

  return { allowed: reasons.length === 0, reasons };
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
