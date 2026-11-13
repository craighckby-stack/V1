/**
 * Refactor verifier — runs as a child process spawned by the self-enhance loop.
 *
 * Usage: echo "<refactored code>" | bun run src/lib/pipeline/autonomous/verify-refactor.ts <filePath>
 *
 * Reads the file path from argv[2] and the refactored code from stdin,
 * then delegates the ENTIRE gate chain to core/gate-runner.ts under
 * SELF_PATH_POLICY (Replace ② unification):
 *
 *   0. MUTATION GUARD — newly-introduced evil tokens (eval(, child_process,
 *      non-allowlisted fetch, path traversal) + protected path + empty
 *      content. AUDIT 3: this gate used to run only on the remote-repo
 *      path while the autonomous loop — the path that mutates THIS repo —
 *      had no evil-token check at all. Now both paths share it, and both
 *      share it through the SAME runner.
 *   1. STRUCTURAL — destructive truncation, import stripping, symbol drop,
 *      test deletion, license stripping (regex, cheap).
 *   2. AST DIFF — TS-parser symbol retention under STRICT tolerance: any
 *      AST_SYMBOL_DROPPED / BRANDING_INJECTION violation rejects
 *      regardless of score (the enhance prompt promises "preserve EVERY
 *      top-level exported symbol"), and the score gate must pass too.
 *   3. SYNTAX — fast AST parse (ScriptKind follows the real extension).
 *   4. TYPECHECK — full in-memory TypeScript typecheck (same as
 *      `tsc --noEmit`, ~10s).
 *
 * Fail-fast (stopOnFirstFailure): a child process must not burn 10s of
 * typecheck on a proposal the 0ms guard already rejected.
 *
 * Prints JSON result to stdout: { ok, errors }. Exits 0 on success, 1 on
 * any gate failure. Nothing is written to disk — Turbopack never sees the
 * refactored code.
 *
 * The gate-runner reads the ORIGINAL file's content from the `originalCode`
 * argument for all diff gates. This module owns the disk read and the
 * fail-closed contract (audit 3 F12): if the original can't be read, the
 * verification is REJECTED — a refactor with no original to diff against
 * is meaningless, and the old skip-the-gates path could RECREATE a deleted
 * file through the weaker syntax+typecheck-only verification.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { PROJECT_ROOT } from "../core/paths";
import { runGateChain, SELF_PATH_POLICY } from "../core/gate-runner";

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

  // Fail-closed original read (audit 3 F12): if the original can't be
  // read, reject — see module doc. The gate-runner's structural and AST
  // gates are meaningless without a baseline.
  let originalCode = "";
  try {
    originalCode = readFileSync(resolve(PROJECT_ROOT, filePath), "utf-8");
  } catch {
    console.log(JSON.stringify({
      ok: false,
      errors: [
        "original file unreadable — cannot verify a refactor against a missing original (fail-closed, audit 3 F12)",
      ],
    }));
    process.exit(1);
  }

  // The whole chain — guard → structural → ast(strict) → syntax →
  // typecheck, fail-fast — lives in core/gate-runner.ts under
  // SELF_PATH_POLICY. This wrapper owns only the child-process shell:
  // argv, stdin, the disk read, the stdout contract, the exit code.
  const result = await runGateChain({
    filePath,
    originalCode,
    evolvedCode: refactoredCode,
    policy: SELF_PATH_POLICY,
  });

  console.log(JSON.stringify({ ok: result.ok, errors: result.errors }));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, errors: [err.message] }));
  process.exit(1);
});
