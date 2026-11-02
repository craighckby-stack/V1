/**
 * Files the self-improvement system must NOT modify (it would break its own
 * loop, gates, or control surface).
 *
 * SINGLE SOURCE OF TRUTH (audit 2: "duplicated protected lists have
 * drifted"). This list used to exist in TWO places that had diverged:
 *   - self-enhance-loop.ts protected the verifier + push path
 *     (push-target.ts, in-memory-typecheck.ts, verify-refactor.ts) but not
 *     the task generator;
 *   - self-task-generator.ts protected itself but NOT the verifier or push
 *     path — so the task engine could queue LLM-driven edits against the
 *     very gates that are supposed to check those edits.
 *
 * Both modules now import this set. Adding a file here protects it
 * everywhere at once.
 */
export const PROTECTED_FILES = new Set([
  // Loop runtime + gate chain
  "src/lib/pipeline/autonomous/loop-runtime.ts",
  "src/lib/pipeline/autonomous/self-enhance-loop.ts",
  "src/lib/pipeline/autonomous/self-task-generator.ts",
  "src/lib/pipeline/autonomous/loop-event-bus.ts",
  "src/lib/pipeline/autonomous/push-target.ts", // protect the push auth path
  "src/lib/pipeline/autonomous/in-memory-typecheck.ts", // protect the typecheck
  "src/lib/pipeline/autonomous/verify-refactor.ts", // protect the verifier
  "src/lib/pipeline/autonomous/lesson-store.ts", // protect the compounding engine
  "src/lib/pipeline/autonomous/schema-gate.ts", // protect the schema gate
  "src/lib/pipeline/autonomous/protected-files.ts", // protect the protection list
  "src/lib/pipeline/llm/agent-llm.ts", // protect the LLM wrapper
  "src/lib/pipeline/llm/debate-llm.ts",
  // Hot-swap core — protect the swapper. If the loop could rewrite its
  // own hot-swap module, a bad mutation could break the swap mechanism
  // and the running process would never benefit from future fixes.
  // The swap itself still works on other pipeline files; the loop just
  // can't edit the swap logic. (Concept: PKM — protect the executioner.)
  "src/lib/pipeline/core/hot-swap.ts",
  // UI control surface — the loop can change HOW things look (the mutable
  // display layer in src/app/display/) but can NEVER touch the control
  // surface: the buttons, the command input, the command parser, the state
  // management, the polling. If the system could rewrite its own control
  // surface, it could remove the STOP button and escape user oversight.
  "src/app/page.tsx", // the control surface itself
  "src/app/layout.tsx", // page metadata / shell
  // The database client — a mutation here could break every db.* call
  // site at once, including the postmortem and lesson stores.
  "src/lib/db.ts",
]);

/** Directory subtrees the loop must never touch — same contract as
 *  PROTECTED_FILES but for whole prefixes (individual listing would be
 *  brittle: every new route file would need a matching entry here, and
 *  forgetting one would open the control surface).
 *
 *  - api/self-enhance/** — the backend of the control surface. start /
 *    stop / push / push-target / llm-config / visibility. If the loop
 *    could rewrite these routes, a "successful" mutation could break
 *    the STOP button's API or weaken the push path — the same escape
 *    hatch as rewriting page.tsx, one layer down.
 */
export const PROTECTED_PREFIXES = [
  "src/app/api/self-enhance/",
  "src/app/api/health", // healthz — the sandbox's uptime probe
];

/** Full protection check: exact file OR protected prefix. This is the
 *  single predicate scanFiles uses — keeping it here means adding a
 *  prefix or file protects it everywhere at once. */
export function isProtectedPath(relPath: string): boolean {
  if (PROTECTED_FILES.has(relPath)) return true;
  for (const p of PROTECTED_PREFIXES) {
    if (relPath.startsWith(p)) return true;
  }
  return false;
}
