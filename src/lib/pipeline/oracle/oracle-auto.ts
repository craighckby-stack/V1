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
 *
 * ── SELF-PROPHECY (audit 7 — "accumulate adjudicated prophecies,
 *    de-quantify confidence") ──────────────────────────────────────
 * The LLM-generated prophecies above are sparse (one per cycle, LLM-
 * quantized to 0.70/0.75) and slow to adjudicate (the evaluator needs
 * an LLM call, which the cooldown gate often blocks). After six audits
 * the Oracle had 5 prophecies total, 1 judged, confidence quantized —
 * not enough to draw a calibration curve.
 *
 * The self-prophecy fixes all three: every cycle, the self-model's
 * predictConfidence (continuous, LLM-free) becomes a Prophecy row with
 * a SHORT horizon (10 min, now a crash-fallback only) and a
 * DETERMINISTIC adjudicator. No LLM is used for generation OR
 * adjudication — the confidence IS the self-model speaking, and the
 * verdict IS the in-flight attempt's outcome. domain="self-prediction"
 * marks them so the LLM evaluator skips them (the auto-adjudicator owns
 * them). Within hours the Oracle has dozens of adjudicated prophecies
 * with continuous confidence — a REAL calibration curve, fast.
 *
 * SAME-ATTEMPT SETTLEMENT (operator fix, 2026-11-22): the original
 * design opened the prophecy right before an attempt on file X but
 * worded the claim as "the NEXT attempt on X", with the adjudicator
 * refusing to settle on the in-flight attempt (currentCycle <=
 * meta.cycleNumber guard). With ~70 files rotating at a ~38-minute
 * median return time, the "next" attempt almost never landed inside
 * the 10-minute deadline: 241 of 243 prophecies died as
 * failed-by-timeout WITHOUT EVER BEING TESTED — noise, not signal
 * (and each timeout spawned a no-op SelfTask). The prophecy now claims
 * THIS attempt (the one in flight when it is recorded), the
 * adjudicator settles it the moment that attempt's verdict lands
 * (guard relaxed to currentCycle < meta.cycleNumber), and the 10-min
 * deadline exists only as a fallback for a worker crash mid-attempt
 * (where the evaluator's retroactive MutationCorpus check picks it
 * up). Settlement rate: ~100% instead of ~1%.
 */

import { llmIsCoolingDown } from "../llm/agent-llm";
import { generateProphecy } from "./prophecy-generator";
import { getProphecyCounts, createProphecy, judgeProphecy, listPendingProphecies } from "./prophecy-store";
import { emitOracleEvent } from "./oracle-events";
import { execSync } from "child_process";
import { PROJECT_ROOT } from "../core/paths";

/** Cap on pending (unjudged) prophecies before auto-generation pauses. */
const MAX_PENDING_PROPHECIES = 5;
/** The self-prophecy's horizon: long enough for ~1-2 cycles to land a
 *  verdict, short enough that the auto-adjudicator resolves it fast. */
const SELF_PROPHECY_HORIZON_MS = 10 * 60 * 1000;

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

// ── SELF-PROPHECY (audit 7 — the cheap, fast, auto-adjudicated kind) ──

/** Snapshot the current HEAD SHA for the prophecy's contextSha. Best-effort:
 *  null on any git failure (the adjudicator doesn't need it — it matches on
 *  the stashed cycleNumber + filePath). */
function currentHeadSha(): string | null {
  if (!PROJECT_ROOT) {
    return null;
  }
  try {
    return execSync("git -C " + PROJECT_ROOT + " rev-parse HEAD", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: "pipe",
    }).trim() || null;
  } catch {
    return null; // git command failed, return null
  }
}

/**
 * Record a self-prophecy: the self-model's prediction that the
 * mutation attempt STARTING RIGHT NOW on `filePath` will pass all
 * gates. NO LLM CALL — the confidence is the self-model's continuous
 * empirical rate, the claim is templated, the criterion is
 * deterministic ("FULFILLED if enhanced, FAILED otherwise"). The
 * auto-adjudicator resolves it the moment THIS attempt's verdict
 * lands (same cycle — see the same-attempt note in the module header).
 *
 * Called from runCycle right after openSelfPrediction (the internal
 * calibration row), so the Oracle's public track record gets a sample
 * from the SAME prediction the loop is privately tracking. The caller
 * AWARDS the write before starting the attempt, so the row is
 * guaranteed to exist before the verdict that settles it. Fail-soft:
 * a DB error loses one sample, never fails the cycle.
 *
 * The `historySnapshot` field stashes `{"selfProphecy":true,
 * "sameAttempt":true,"filePath":...,"cycleNumber":N}` as JSON so the
 * adjudicator can find it by matching filePath + cycleNumber (the
 * Prophecy model has no dedicated columns for this — reusing the
 * free-text field avoids a schema migration).
 */
export async function recordSelfProphecy(input: {
  filePath: string;
  confidence: number;
  reason: string;
  mode: "refactor" | "visual-polish";
  cycleNumber: number;
}): Promise<void> {
  if (!input.filePath || typeof input.filePath !== 'string' || input.filePath.length === 0) {
    emitOracleEvent(
      "recordSelfProphecy error: filePath must be a non-empty string",
      "error",
      "scheduler",
    );
    return;
  }
  if (input.mode !== "refactor" && input.mode !== "visual-polish") {
    emitOracleEvent(
      "recordSelfProphecy error: mode must be 'refactor' or 'visual-polish'",
      "error",
      "scheduler",
    );
    return;
  }
  if (input.confidence < 0 || input.confidence > 1) {
    emitOracleEvent(
      "recordSelfProphecy error: confidence must be between 0 and 1",
      "error",
      "scheduler",
    );
    return;
  }
  if (input.cycleNumber < 0) {
    emitOracleEvent(
      "recordSelfProphecy error: cycleNumber must be non-negative",
      "error",
      "scheduler",
    );
    return;
  }
  if (!input.reason || typeof input.reason !== 'string' || input.reason.length === 0) {
    emitOracleEvent(
      "recordSelfProphecy error: reason must be a non-empty string",
      "error",
      "scheduler",
    );
    return;
  }
  try {
    const claim =
      `The ${input.mode} mutation attempt on ${input.filePath} at cycle ` +
      `${input.cycleNumber} will pass all gates (typecheck + structural + ` +
      `debate) and be enhanced.`;
    const criterion =
      `FULFILLED if the ${input.mode} enhanceFile attempt on ${input.filePath} ` +
      `at cycle ${input.cycleNumber} returns enhanced=true; FAILED if it returns ` +
      `enhanced=false (rejected, deferred, cosmetic-skip, or zero-diff). ` +
      `Settled deterministically by the auto-adjudicator the moment that ` +
      `attempt's verdict lands.`;
    await createProphecy({
      claim,
      confidence: input.confidence,
      rationale: `self-model prediction (no LLM): ${input.reason}`,
      falsifiabilityCriterion: criterion,
      evaluateBy: new Date(Date.now() + SELF_PROPHECY_HORIZON_MS),
      contextSha: currentHeadSha(),
      historySnapshot: JSON.stringify({
        selfProphecy: true,
        sameAttempt: true,
        filePath: input.filePath,
        cycleNumber: input.cycleNumber,
        mode: input.mode,
      }),
      domain: "self-prediction",
    });
  } catch {
    // fail-soft — the oracle loses one sample
  }
}

/**
 * The deterministic adjudicator. Called from runCycle right after a
 * verdict lands, with the filePath + enhanced flag. Finds ALL pending
 * self-prophecies (domain="self-prediction") whose stashed filePath
 * matches, and judges them fulfilled/failed directly via judgeProphecy
 * — NO LLM, NO evaluator, NO cooldown gate. This is what makes the
 * self-prophecy close its loop in one cycle instead of waiting for the
 * LLM-based evaluator (which the cooldown gate often blocks for 30+
 * minutes).
 *
 * Same-attempt semantics (operator fix, 2026-11-22): a prophecy made
 * at cycle N predicts THE ATTEMPT AT CYCLE N (the one in flight when
 * it was recorded), so the guard is currentCycleNumber <
 * meta.cycleNumber — an attempt at the SAME cycle number settles it
 * (that's the in-flight attempt itself, since cycleNumber is
 * stats.cyclesCompleted + 1 at both open and settle time), and any
 * LATER attempt on the same file settles stragglers too. Legacy
 * pre-fix prophecies (no sameAttempt flag) also get settled by the
 * next attempt on their file — strictly better than the old
 * failed-by-deadline default. If no attempt ever lands (worker
 * crash), the 10-min deadline passes and the server-side evaluator's
 * retroactive MutationCorpus check settles it from the recorded
 * attempt — or, if truly no attempt happened, fails it honestly.
 *
 * Fail-soft: a DB error loses the adjudication, never fails the cycle.
 */
export async function adjudicateSelfProphecies(
  filePath: string,
  enhanced: boolean,
  currentCycleNumber: number
): Promise<void> {
  try {
    const pending = await listPendingProphecies();
    for (const p of pending) {
      if (p.domain !== "self-prediction") continue;
      // Parse the stashed metadata to find which file+cycle this
      // prophecy predicted. Skip unparseable ones (let the LLM
      // evaluator handle them as deadline-failed).
      let meta: { selfProphecy?: boolean; filePath?: string; cycleNumber?: number; mode?: string } = {};
      try {
        if (p.historySnapshot) {
          meta = JSON.parse(p.historySnapshot);
        }
      } catch {
        continue;
      }
      if (meta.filePath !== filePath) continue;
      // Only judge self-prophecies whose predicted attempt has happened:
      // same-attempt semantics (2026-11-22) — a prophecy made at cycle N
      // predicts the attempt AT cycle N (the one in flight when it was
      // recorded), so an attempt at the SAME cycle number settles it.
      // Strictly-later attempts settle legacy pre-fix stragglers too.
      if (typeof meta.cycleNumber !== "number") continue;
      if (currentCycleNumber < meta.cycleNumber) continue;
      
      if (!p.id) continue; // Safety check against malformed records from store
      
      const verdict = enhanced ? "fulfilled" : "failed";
      const evaluation =
        `Auto-adjudicated (no LLM): the ${meta.mode ?? "refactor"} attempt on ` +
        `${filePath} at cycle ${currentCycleNumber} returned ` +
        `${enhanced ? "enhanced=true" : "enhanced=false"}. ` +
        `Self-prophecy made at cycle ${meta.cycleNumber} with confidence ${p.confidence.toFixed(2)}.`;
      await judgeProphecy(p.id, verdict, evaluation);
      emitOracleEvent(
        `Oracle self-prophecy ${verdict.toUpperCase()}: "${p.claim.slice(0, 80)}" (confidence ${(p.confidence * 100).toFixed(0)}%)`,
        verdict === "fulfilled" ? "success" : "warn",
        "auto-adjudicator",
      );
    }
  } catch (e) {
    // fail-soft: ignore DB errors, do not halt the cycle.
    const errorMessage = e instanceof Error ? e.message : String(e);
    emitOracleEvent(
      `Oracle self-prophecy adjudication error: ${errorMessage}`,
      "error",
      "auto-adjudicator",
    );
  }
}