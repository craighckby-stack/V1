/**
 * Refactor verifier — runs as a child process spawned by the self-enhance loop.
 *
 * Usage: echo "<refactored code>" | bun run src/lib/pipeline/autonomous/verify-refactor.ts <filePath>
 *
 * Reads the file path from argv[2] and the refactored code from stdin.
 * Runs FOUR gates in order (cheap → expensive):
 *   0. MUTATION GUARD — newly-introduced evil tokens (eval(, child_process,
 *      non-allowlisted fetch, path traversal). AUDIT 3: this gate ran only
 *      on the remote-repo path (unified-pipeline) while the autonomous
 *      loop — the path that mutates THIS repo — had no evil-token check
 *      at all. Now both paths share it.
 *   1. STRUCTURAL — destructive truncation, import stripping, symbol drop,
 *      test deletion, license stripping. The REAL signal beyond typecheck.
 *      Cheap (regex-based, no compiler). Catches the LLM doing things that
 *      compile but are destructive. Followed by the TS-PARSER AST gate
 *      (evaluateAstDiff) — AUDIT 3: the regex validator can't see dropped
 *      class methods or export-alias renames; the parser can. The parser
 *      gate was also remote-path-only; now both paths run it.
 *   2. SYNTAX — fast AST parse. Catches broken template literals, etc.
 *   3. TYPECHECK — full in-memory TypeScript typecheck (same as `tsc --noEmit`).
 *      Expensive (~10s). Only runs if structure + syntax pass.
 *
 * Prints JSON result to stdout. Exits 0 on success, 1 on any gate failure.
 *
 * Nothing is written to disk — Turbopack never sees the refactored code.
 *
 * The structural gate reads the ORIGINAL file from disk to compare against.
 * This is the key addition: typecheck alone proves "compiles", the
 * structural gate proves "didn't break the public API / didn't drop tests /
 * didn't strip imports / wasn't truncated".
 */

import { typecheckRefactor, syntaxCheck } from "./in-memory-typecheck";
import { validateStructure } from "./structural-validator";
import { gateMutation } from "../core/mutation-guard";
import { evaluateAstDiff } from "../core/ast-diff-gate";
import { readFileSync } from "fs";
import { resolve } from "path";

const PROJECT_ROOT = "/home/z/my-project";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log(JSON.stringify({ ok: false, errors: ["No file path provided"] }));
    process.exit(1);
  }

  // Read refactored code from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const refactoredCode = Buffer.concat(chunks).toString("utf-8");

  if (!refactoredCode || refactoredCode.trim().length === 0) {
    console.log(JSON.stringify({ ok: false, errors: ["No code provided on stdin"] }));
    process.exit(1);
  }

  // Gate 1: STRUCTURAL — compare against the original on disk.
  // Catches destructive refactors that would still compile.
  let originalCode = "";
  try {
    originalCode = readFileSync(resolve(PROJECT_ROOT, filePath), "utf-8");
  } catch {
    // If the original can't be read (new file?), skip structural — typecheck will catch issues
  }

  // Gate 0: MUTATION GUARD — newly-introduced evil tokens + protected path
  // + empty content. Fail-closed, ~0ms, and it runs BEFORE anything else
  // so no expensive gate time is spent on an obviously-evil proposal.
  // The loop passes an ABSOLUTE path; the guard expects repo-relative.
  // Normalize: strip the project root if present (absolute input), else
  // strip any leading slashes (already-relative input).
  const relForGuard = filePath.startsWith(`${PROJECT_ROOT}/`)
    ? filePath.slice(PROJECT_ROOT.length + 1)
    : filePath.replace(/^\/+/, "");
  const guard = gateMutation({
    filePath: relForGuard,
    originalCode,
    evolvedCode: refactoredCode,
  });
  if (!guard.allowed) {
    console.log(JSON.stringify({
      ok: false,
      errors: [`[mutation-guard/${guard.rejectedBy}] ${guard.reasons.join(" | ")}`],
    }));
    process.exit(1);
  }

  if (originalCode) {
    const structure = validateStructure(filePath, originalCode, refactoredCode);
    if (!structure.ok) {
      console.log(JSON.stringify({
        ok: false,
        errors: structure.issues.map((i) => `[${i.code}] ${i.message}`),
      }));
      process.exit(1);
    }

    // Gate 1b: AST DIFF (TS parser) — the stronger symbol-retention check.
    // The regex validator above is the fast first pass; this catches what
    // regexes structurally cannot: dropped class methods (Foo.bar) and
    // export-alias renames (export { X as Y } → export { X as Z }).
    // HARD-FAIL CONTRACT: evaluateAstDiff is score-based (a single dropped
    // method is "medium" severity and can still pass on score — right for
    // the remote path where some drift is tolerable). The self-mutation
    // path's contract is stricter (the enhance prompt promises "preserve
    // EVERY top-level exported symbol"), so ANY symbol-drop or branding
    // violation rejects here, regardless of score.
    const ast = evaluateAstDiff(originalCode, refactoredCode, filePath);
    const hardFail = ast.violations.filter(
      (v) => v.code === "AST_SYMBOL_DROPPED" || v.code === "BRANDING_INJECTION"
    );
    if (hardFail.length > 0 || !ast.passed) {
      console.log(JSON.stringify({
        ok: false,
        errors: (hardFail.length > 0 ? hardFail : ast.violations).map((v) => `[${v.code}] ${v.message}`),
      }));
      process.exit(1);
    }
  }

  // Gate 2: SYNTAX — fast AST parse (ScriptKind follows the real extension,
  // so .tsx display components parse as JSX, not as broken TypeScript).
  const syntax = syntaxCheck(refactoredCode, filePath);
  if (!syntax.ok) {
    console.log(JSON.stringify({ ok: false, errors: [syntax.error ?? "Syntax error"] }));
    process.exit(1);
  }

  // Gate 3: TYPECHECK — full in-memory tsc.
  const result = typecheckRefactor(filePath, refactoredCode);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, errors: [err.message] }));
  process.exit(1);
});
