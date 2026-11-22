/**
 * Debug tool: peek at which SelfTask the loop's claimer would pick next.
 *
 * Cripple-check F18: this script used to HAND-DUPLICATE the claimNextTask
 * query (a "simulate exactly what claimNextTask does" copy). If the
 * ordering or filters ever changed in self-task-generator.ts, this script
 * drifted silently and showed a winner that was no longer real. It now
 * imports peekNextTask — the side-effect-free view over the SAME
 * taskClaimQuery object the claimer uses — so it can never disagree with
 * production. (The old copy also lacked the onlyDeterministic filter
 * dimension entirely.)
 */
import { peekNextTask } from "../src/lib/pipeline/autonomous/self-task-generator";

async function main() {
  // Run independent reads in parallel to reduce latency
  const [next, det] = await Promise.all([
    peekNextTask(),
    peekNextTask(true),
  ]);

  console.log(
    "peekNextTask (full queue):",
    next
      ? `[${next.kind}] ${next.filePath}:${next.line} deferred=${next.deferred} priority=${next.priority}`
      : "NONE"
  );
  console.log(
    "peekNextTask (deterministic-only, LLM-rate-limited mode):",
    det
      ? `[${det.kind}] ${det.filePath}:${det.line} deferred=${det.deferred} priority=${det.priority}`
      : "NONE"
  );
}
main().catch((e) => {
  const errorMessage = e instanceof Error ? e.message : String(e);
  console.error(`Error during task claim peek: Failed to retrieve next task state. Context: ${errorMessage}`);
  process.exit(1);
});