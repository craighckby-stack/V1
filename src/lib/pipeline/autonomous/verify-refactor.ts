/**
 * Refactor verifier — runs as a child process.
 *
 * Usage: echo "<code>" | bun run src/lib/pipeline/autonomous/verify-refactor.ts <filePath>
 *
 * Reads the file path from argv[2] and the code from stdin. Performs a full
 * in-memory typecheck with the code substituted for the target file. Prints
 * JSON to stdout. Exits 0 on success, 1 on type error.
 *
 * Nothing is written to disk — Turbopack never sees the code.
 */

import { typecheckRefactor, syntaxCheck } from "./in-memory-typecheck";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log(JSON.stringify({ ok: false, errors: ["No file path provided"] }));
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const code = Buffer.concat(chunks).toString("utf-8");

  if (!code || code.trim().length === 0) {
    console.log(JSON.stringify({ ok: false, errors: ["No code provided on stdin"] }));
    process.exit(1);
  }

  // Fast syntax check first
  const syntax = syntaxCheck(code);
  if (!syntax.ok) {
    console.log(JSON.stringify({ ok: false, errors: [syntax.error ?? "Syntax error"] }));
    process.exit(1);
  }

  // Full type check
  const result = typecheckRefactor(filePath, code);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, errors: [err.message] }));
  process.exit(1);
});
