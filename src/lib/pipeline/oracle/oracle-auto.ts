/**
 * Oracle Auto — post-cycle automatic prophecy generation.
 *
 * After each completed self-enhance cycle, the system gets the chance
 * to predict its own next turn. This is what makes the Oracle a
 * participant in the system's rhythm rather than a manual toy: every
 * cycle ends with the system asking itself "what happens next?" and
 * committing to a falsifiable answer before it can see the future.
 *
 * GUARDS (all three must pass or the prophecy is skipped silently):
 *
 *   1. LLM-gate closed → skip. Never steal quota from a running
 *      mutation, never hammer a 429ing provider. The shared cooldown
 *      gate in agent-llm.ts is the single source of truth.
 *
 *   2. Pending prophecies >= 5 → skip. Bounds unbounded growth: if
 *      the evaluator is down (or the LLM has been cooling down for a
 *      long stretch), generation pauses rather than piling up a
 *      backlog that all becomes due at once.
 *
 *   3. Fire-and-forget → never blocks the loop. The call runs on the
 *      shared serialized LLM queue; the loop's next cycle doesn't wait
 *      for it (and by design, it runs BETWEEN cycles, so it never
 *      interleaves with a mutation's LLM calls).
 *
 * This module is deliberately separate from prophecy-generator.ts so
 * the self-enhance loop only needs to import ONE function and call it
 * in ONE place — minimal mutation surface in the protected loop file.
 */

import { llmIsCoolingDown } from "../llm/agent-llm";
import { generateProphecy } from "./prophecy-generator";
import { getProphecyCounts } from "./prophecy-store";
import { emitOracleEvent } from "./oracle-events";

/** Cap on pending (unjudged) prophecies before auto-generation pauses. */
const MAX_PENDING_PROPHECIES = 5;

/**
 * Maybe generate one prophecy after a completed cycle. Fire-and-forget:
 * returns immediately, never throws, never blocks. All guards inside.
 * The result (made or skipped) surfaces only through the event ring —
 * the console stream narrates it; nothing interrupts the loop.
 */
export function autoProphecyAfterCycle(): void {
  void (async () => {
    try {
      // Guard 1: shared LLM gate closed → skip this cycle's prophecy.
      if (llmIsCoolingDown()) {
        return; // silent — the cooldown chip already tells the story
      }

      // Guard 2: too many unjudged prophecies → skip until the
      // evaluator catches up.
      const counts = await getProphecyCounts();
      
      // Validate counts structure to prevent runtime errors
      if (!counts || typeof counts.pending !== 'number' || counts.pending < 0) {
        emitOracleEvent(
          "Oracle auto-prophecy error: invalid prophecy counts received",
          "error",
          "scheduler",
        );
        return;
      }

      if (counts.pending >= MAX_PENDING_PROPHECIES) {
        return; // silent — bounded backlog by design
      }

      // Guards passed — make the prophecy. The generator itself
      // handles every failure mode honestly (llm-unavailable,
      // unparseable, invalid-shape, store-failed) and emits its own
      // event on success; a failure here simply means no prophecy this
      // cycle, which is fine.
      await generateProphecy();
    } catch (error) {
      // Never let the oracle take down the loop. A background
      // introspection must not become a foreground failure.
      const errorMessage = error instanceof Error ? error.message : String(error);
      emitOracleEvent(
        `Oracle auto-prophecy error (cycle hook) — skipped this cycle due to unexpected exception: ${errorMessage}`,
        "error",
        "scheduler",
      );
    }
  })();
}