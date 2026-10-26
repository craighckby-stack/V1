/**
 * Refactor verifier — runs as a child process spawned by the self-enhance loop.
 *
 * Usage: echo "<refactored code>" | bun run src/lib/pipeline/autonomous/verify-refactor.ts <filePath>
 *
 * Reads the file path from argv[2] and the refactored code from stdin.
 * Performs a full in-memory TypeScript typecheck (same as `tsc --noEmit`)
 * with the refactored code substituted for the target file.
 * Prints JSON result to stdout. Exits 0 on success, 1 on type error.
 *
 * Nothing is written to disk — Turbopack never sees the refactored code.
 */

import { typecheckRefactor, syntaxCheck } from "./in-memory-typecheck";

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

  // Fast syntax check first (catches broken template literals, missing semicolons, etc.)
  const syntax = syntaxCheck(refactoredCode);
  if (!syntax.ok) {
    console.log(JSON.stringify({ ok: false, errors: [syntax.error ?? "Syntax error"] }));
    process.exit(1);
  }

  // Full type check (catches undefined variables, type mismatches, etc.)
  const result = typecheckRefactor(filePath, refactoredCode);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, errors: [err.message] }));
  process.exit(1);
});
