/**
 * META-TUNER — the L4 rung: the loop tunes its own loop.
 * (concepts: Raven's separate Evolver, leezythu's L4 meta-harness rung,
 * genesis PromptEvolution — D8, the last and largest proposal)
 *
 * DISTILL_INTERVAL, MAX_INJECTED, PRUNE_SCORE, MIN_OBSERVATIONS and
 * SATURATION_THRESHOLD were constants. The loop improved the body but
 * never its own improvement loop — the failure mode the user's own
 * repo lineage keeps hitting (every prior system converged and stopped
 * growing). This module makes the knobs MEASURED:
 *
 *   every TUNE_INTERVAL cycles (and never before WARMUP_CYCLES — a
 *   trial needs a measured baseline window first):
 *     1. Snapshot the rolling last-TRIAL_WINDOW-cycles pass rate as
 *        the baseline.
 *     2. Pick ONE tunable (round-robin), propose ONE step (alternating
 *        direction; clamped to the tunable's safe range — the clamps
 *        are the hard floor on damage: PRUNE_SCORE can never go below
 *        0.20, the D2 procedure floor, no matter what any window says).
 *     3. Write the trial value with provenance="trial". The value is
 *        LIVE (readers read it — that is the point of an A/B), but it
 *        is not ACCEPTED.
 *     4. Every cycle while in flight: early-abort if trial pass-rate
 *        falls below 0.5x baseline (at >= 4 attempts) — a knob that is
 *        actively hurting gets pulled in-cycle 5, not cycle 20.
 *     5. At window end: need >= MIN_WINDOW_ATTEMPTS real LLM proposals;
 *        accept only if trial >= baseline + 0.05. Otherwise rollback to
 *        baselineValue.
 *
 *   A restart mid-trial leaves the row in "trial"; seedMetaParams()
 *  (boot) reverts it to baseline — an unfinished A/B never survives to
 *  be mistaken for an accepted tuning.
 *
 * Pass rate is measured by noteAttemptOutcome(), fed from runCycle:
 *  attempts = mutations that produced a real LLM proposal (llmUsed);
 *  passes = mutations that were Enhanced. Deferred/unavailable calls
 *  never count on either side (they are not verdicts).
 *
 * This file is in PROTECTED_FILES and its model in
 * SCHEMA_PROTECTED_MODELS: the loop can never rewrite its own tuner.
 */

import { llmCooldownMs } from "../llm/agent-llm";
import { db } from "@/lib/db";
import {
  TUNABLES,
  getTunable,
  getMetaInt,
  setMetaValue,
} from "./meta-params";

/** Cycles between proposal attempts. NOT itself tunable — the tuner
 *  tuning its own cadence is an infinite regress. */
export const TUNE_INTERVAL = 50;
/** Cycles a trial runs before judgment. */
export const TRIAL_WINDOW = 20;
/** Cycles before the FIRST proposal (baseline needs data). */
export const WARMUP_CYCLES = 70;
/** Real LLM proposals required in a window for the verdict to count. */
export const MIN_WINDOW_ATTEMPTS = 8;
/** The accept margin: trial must beat baseline by this much. */
export const ACCEPT_MARGIN = 0.05;

type MetaParamDelegate = typeof db.metaParam | undefined;
function metaParams(): MetaParamDelegate {
  const d = (db as unknown as { metaParam?: MetaParamDelegate }).metaParam;
  return typeof d?.findUnique === "function" ? d : undefined;
}

// ── in-memory measurement ────────────────────────────────────────────

/** Per-cycle outcome slots, keyed by cycle number modulo RING. Each slot
 *  carries its cycle number — a slot whose cycle doesn't match reads as
 *  zeros. That is the generation reset: cycle 5 and cycle 69 share a
 *  slot index, and the older generation must never leak into a window. */
interface Slot {
  cycle: number;
  attempted: number;
  passed: number;
}
const RING = 64;
const slots: Array<Slot | null> = new Array(RING).fill(null);

/** Fed by runCycle after each file verdict. `llmUsed` filters out
 *  deferred/unavailable calls — only real proposals count as attempts. */
export function noteAttemptOutcome(cycleNumber: number, llmUsed: boolean, enhanced: boolean): void {
  if (!llmUsed) return;
  const idx = cycleNumber % RING;
  const prev = slots[idx];
  if (prev && prev.cycle === cycleNumber) {
    prev.attempted++;
    if (enhanced) prev.passed++;
  } else {
    // First write this cycle (or a new generation claiming the slot).
    slots[idx] = { cycle: cycleNumber, attempted: 1, passed: enhanced ? 1 : 0 };
  }
}

/** Pass rate over the last `len` cycles ending at `endCycle` (inclusive).
 *  Returns null when the window has too few attempts to mean anything. */
function windowPassRate(endCycle: number, len: number, minAttempts: number): number | null {
  let attempted = 0;
  let passed = 0;
  for (let c = endCycle - len + 1; c <= endCycle; c++) {
    if (c < 1) continue;
    const idx = c % RING;
    const s = slots[idx];
    if (!s || s.cycle !== c) continue; // stale/missing generation → zeros
    attempted += s.attempted;
    passed += s.passed;
  }
  if (attempted < minAttempts) return null;
  return passed / attempted;
}

// ── in-flight trial state ────────────────────────────────────────────

interface TrialState {
  key: string;
  startCycle: number;
  baselineValue: number;
  /** From/to at proposal time — for the log lines only (the live value
   *  reads back from the mirror/row). */
  from: number;
  to: number;
  prevProvenance: "seed" | "meta-tuned";
  proposedBy: string;
}

let inFlight: TrialState | null = null;
/** Round-robin cursor over TUNABLES + alternating direction flag. */
let tunableCursor = 0;
let nextDirection: 1 | -1 = 1;

/** The next proposal for the round-robin tunable, or null when every
 *  direction of every tunable clamps out. Uses the value mirror, which
 *  refreshMirror() keeps current at the top of every maybeMetaTune call. */
function nextProposal(): { key: string; from: number; to: number; dir: 1 | -1 } | null {
  for (let i = 0; i < TUNABLES.length; i++) {
    const t = TUNABLES[(tunableCursor + i) % TUNABLES.length];
    const from = valueMirror.get(t.key) ?? t.seed;
    for (const dir of [nextDirection, (-nextDirection as 1 | -1)]) {
      const to = round(t.valueType, from + dir * t.step);
      if (to >= t.min && to <= t.max && to !== from) {
        tunableCursor = (tunableCursor + i + 1) % TUNABLES.length;
        nextDirection = dir === 1 ? -1 : 1; // alternate for the NEXT proposal anywhere
        return { key: t.key, from, to, dir };
      }
    }
  }
  return null;
}

const valueMirror = new Map<string, number>();
async function refreshMirror(): Promise<void> {
  for (const t of TUNABLES) {
    valueMirror.set(t.key, await getMetaInt(t.key, t.seed));
  }
}

function round(valueType: "int" | "float", v: number): number {
  if (valueType === "int") return Math.round(v);
  return Math.round(v * 100) / 100;
}

// ── the entry point ──────────────────────────────────────────────────

export interface TuneOutcome {
  action: "none" | "proposed" | "accepted" | "rolled-back" | "aborted";
  detail: string;
}

/**
 * The post-cycle hook (same cadence family as maybeDistill). Never
 * throws; returns the action for the cycle log. All DB writes go
 * through meta-params.setMetaValue (write-through + cache), so a
 * running reader picks up a trial value on its NEXT read.
 */
export async function maybeMetaTune(cyclesCompleted: number): Promise<TuneOutcome> {
  const m = metaParams();
  if (!m) return { action: "none", detail: "metaParam table missing" };

  try {
    await refreshMirror();

    // ── 1. In-flight trial: judge / early-abort ─────────────────────
    if (inFlight) {
      const trial = inFlight;
      const cyclesIn = cyclesCompleted - trial.startCycle;

      // Early abort: actively hurting (0.5x baseline, >= 4 attempts).
      if (cyclesIn >= 4) {
        const trialRate = windowPassRate(cyclesCompleted, cyclesIn, 4);
        // baselinePassRate snapshot taken at proposal time is stored on
        // the row; a cheap early-abort needs a baseline number — read
        // it back from the row (set at proposal).
        const row = await m.findUnique({ where: { key: trial.key } });
        const base = row?.baselinePassRate ?? null;
        if (trialRate !== null && base !== null && trialRate < 0.5 * base) {
          await setMetaValue(trial.key, trial.baselineValue, trial.prevProvenance, {
            baselineValue: trial.baselineValue,
          });
          const detail = `META-TUNER: ${trial.key} ${trial.from}→${trial.to} ABORTED at cycle ${cyclesIn} (trial ${trialRate.toFixed(2)} < 0.5× baseline ${base.toFixed(2)}) — rolled back`;
          inFlight = null;
          valueMirror.set(trial.key, trial.baselineValue);
          return { action: "aborted", detail };
        }
      }

      // Window complete: judge.
      if (cyclesIn >= TRIAL_WINDOW) {
        const trialRate = windowPassRate(cyclesCompleted, TRIAL_WINDOW, MIN_WINDOW_ATTEMPTS);
        const row = await m.findUnique({ where: { key: trial.key } });
        const base = row?.baselinePassRate ?? null;
        if (trialRate === null || base === null) {
          // Insufficient attempts — an inconclusive window rolls back
          // (never accept on no evidence).
          await setMetaValue(trial.key, trial.baselineValue, trial.prevProvenance, {
            baselineValue: trial.baselineValue,
          });
          const detail = `META-TUNER: ${trial.key} ${trial.from}→${trial.to} inconclusive (window attempts < ${MIN_WINDOW_ATTEMPTS}) — rolled back conservatively`;
          inFlight = null;
          valueMirror.set(trial.key, trial.baselineValue);
          return { action: "rolled-back", detail };
        }
        if (trialRate >= base + ACCEPT_MARGIN) {
          await setMetaValue(trial.key, valueMirror.get(trial.key) ?? trial.baselineValue, "meta-tuned", {
            acceptedAt: new Date(),
            trialPassRate: trialRate,
            baselinePassRate: base,
            baselineValue: valueMirror.get(trial.key) ?? trial.baselineValue,
            proposedBy: trial.proposedBy,
          });
          const to = valueMirror.get(trial.key) ?? trial.baselineValue;
          const detail = `META-TUNER: ${trial.key} ${trial.from}→${to} ACCEPTED (trial ${trialRate.toFixed(2)} vs baseline ${base.toFixed(2)}, +${(trialRate - base).toFixed(2)})`;
          inFlight = null;
          return { action: "accepted", detail };
        }
        // Failed to beat baseline: rollback.
        await setMetaValue(trial.key, trial.baselineValue, trial.prevProvenance, {
          baselineValue: trial.baselineValue,
        });
        const detail = `META-TUNER: ${trial.key} ${trial.from}→${trial.to} ROLLED BACK (trial ${trialRate.toFixed(2)} vs baseline ${base.toFixed(2)}, needed +${ACCEPT_MARGIN})`;
        inFlight = null;
        valueMirror.set(trial.key, trial.baselineValue);
        return { action: "rolled-back", detail };
      }
      return { action: "none", detail: `trial of ${trial.key} in flight (cycle ${cyclesIn}/${TRIAL_WINDOW})` };
    }

    // ── 2. Proposal moment? ─────────────────────────────────────────
    if (cyclesCompleted < WARMUP_CYCLES) {
      return { action: "none", detail: `warm-up (cycle ${cyclesCompleted}/${WARMUP_CYCLES})` };
    }
    if (cyclesCompleted % TUNE_INTERVAL !== 0) {
      return { action: "none", detail: "not a proposal cycle" };
    }
    // Only propose with the gate open — a proposal itself costs no LLM
    // quota, but a trial started right before a long cooldown window
    // starves the window of attempts and wastes the trial.
    if (llmCooldownMs() > 0) {
      return { action: "none", detail: "gate closed — bad moment to start a trial" };
    }

    const proposal = nextProposal();
    if (!proposal) return { action: "none", detail: "no clampable proposal available" };

    const baselineRate = windowPassRate(cyclesCompleted, TRIAL_WINDOW, MIN_WINDOW_ATTEMPTS);
    if (baselineRate === null) {
      return { action: "none", detail: "baseline window has too few attempts — deferring proposal" };
    }

    const t = getTunable(proposal.key);
    if (!t) return { action: "none", detail: "tunable vanished" };
    const row = await m.findUnique({ where: { key: proposal.key } });
    const prevProvenance: "seed" | "meta-tuned" = row?.acceptedAt ? "meta-tuned" : "seed";

    inFlight = {
      key: proposal.key,
      startCycle: cyclesCompleted,
      baselineValue: proposal.from,
      from: proposal.from,
      to: proposal.to,
      prevProvenance,
      proposedBy: `tuner-cycle-${cyclesCompleted}`,
    };
    await setMetaValue(proposal.key, proposal.to, "trial", {
      baselineValue: proposal.from,
      proposedBy: inFlight.proposedBy,
      baselinePassRate: baselineRate,
    });
    valueMirror.set(proposal.key, proposal.to);
    return {
      action: "proposed",
      detail: `META-TUNER: ${proposal.key} ${proposal.from}→${proposal.to} trial starting (${t.purpose}); baseline pass-rate ${baselineRate.toFixed(2)} over last ${TRIAL_WINDOW} cycles — the value is live for the next ${TRIAL_WINDOW} cycles, accepted only if it beats baseline by +${ACCEPT_MARGIN}`,
    };
  } catch (e) {
    return { action: "none", detail: `error: ${(e as Error).message.slice(0, 80)}` };
  }
}
