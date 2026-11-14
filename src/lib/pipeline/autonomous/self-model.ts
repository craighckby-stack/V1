/**
 * Self-Model — the loop's measured self-knowledge (audit 7, the cognitive
 * core).
 *
 * WHY THIS EXISTS: six audits found the loop's "self-awareness" was
 * shallow. It didn't know which files it was GOOD at mutating, which were
 * finished, or how often its own attempts succeed. It picked targets in
 * tree order (alphabetical-ish) and its predictions about itself were
 * never scored. The cognitive layer underneath (dreamer, reflection,
 * meta-tuner, lapse-detector) is real — but nothing gave the loop a
 * DATA-DRIVEN model of its own capabilities.
 *
 * This module is that model. Three mechanisms, all measured:
 *
 *   1. PER-FILE SELF-KNOWLEDGE (SelfModelFile table). Every verdict the
 *      loop has ever produced — bootstrapped retroactively from the
 *      MutationCorpus audit trail (400+ historical attempts) so the model
 *      has real knowledge from day one, then updated after every gate
 *      verdict. Tracks per-file pass/fail/zero-diff counts, exhaustion
 *      ("this file is finished") score, and per-mode stats.
 *
 *   2. BANDIT TARGET SELECTION (UCB1). Files are chosen by
 *      score = empirical success rate (Laplace-smoothed)
 *            + exploration bonus (classic UCB1: untried files get a look)
 *            + recency bonus (long-untouched files resurface)
 *            - exhaustion penalty (files that keep zero-diffing sink)
 *      This replaces tree-order scanning with actual DECISION-MAKING, and
 *      every selection is self-explained in the log: "targeting X because
 *      my empirical rate there is 0.67, untouched 14d, exhaustion 0.25".
 *
 *   3. SELF-PREDICTION CALIBRATION (SelfPrediction table). Before every
 *      mutation attempt the loop predicts its own success probability
 *      from the self-model; after the gate verdict the prediction is
 *      resolved. Over cycles this builds a REAL calibration curve —
 *      "when I say 70% confident, am I right 70% of the time?" — with a
 *      Brier score as the single number for "how well do I know myself".
 *      No LLM cost: the prediction IS the self-model speaking.
 *
 * Archaeology wiring (audit 7 de-mock): the git-history miner's
 * stable/fragile file maps were written to a report nothing read. They
 * now seed the self-model as priors — stable files start more exhausted
 * (less bandit attention), fragile files start less (they need the work).
 *
 * Fail-soft by design: every DB interaction is guarded — a missing table
 * or failed query degrades to sensible defaults (empty model → neutral
 * scores → tree-order behavior) and NEVER fails the cycle that called it.
 */

import { db } from "@/lib/db";
// NOTE: readArchaeologyReport is imported LAZILY inside bootstrapSelfModel
// (not at module top-level). This keeps the import chain of getSelfModelSummary
// (the function the /api/self-model route calls) lightweight — just `db` —
// so the route's Turbopack compile is small (~136ms) and doesn't compete
// with the heavy self-enhance-loop.ts compile for memory during cold boot.

// ── Outcome classification ────────────────────────────────────────────

export type SelfOutcome = "pass" | "fail" | "zero-diff" | "excluded";

/** Classify a SelfEnhanceResult into a self-model outcome. The reason
 *  strings mirror enhanceFile's return paths (audited): "Rejected*" =
 *  gate rejection, cosmetic/no-issues = zero-diff, "Deferred*" =
 *  no verdict (LLM gate closed mid-attempt). */
export function classifyOutcome(enhanced: boolean, reason: string): SelfOutcome {
  if (enhanced) return "pass";
  const r = reason.toLowerCase();
  if (r.startsWith("deferred")) return "excluded"; // no verdict — LLM gate closed
  // CEILING-SKIP EXCLUSION: "Skipped (file too large: ...)" means the
  // attempt never ran — no prompt, no gates, no verdict. Before this, it
  // fell through to "fail", so an over-ceiling visual-polish firing (the
  // pre-pass discovered the file, enhanceFile's 12KB guard auto-skipped
  // it) was recorded as a gate rejection for that file: a fake fail in
  // the bandit's empirical rate AND the calibration curve. No-verdict
  // outcomes belong with "deferred" — excluded, not knowledge.
  if (r.startsWith("skipped (file too large")) return "excluded";
  // PROACTIVE-SKIP EXCLUSION (audit 8): "Skipped (self-model predicts
  // zero-diff: ...)" is the SAME no-verdict class — the loop never ran a
  // prompt or a gate; it ACTED on a prediction. Before this, every
  // non-probe proactive skip fell through to "fail": a fake gate
  // rejection that dragged the file's empirical pass rate down, which
  // then fed predictConfidence — the very predictor the skip rule
  // trusts — with fabricated evidence (predicted-dead files looked even
  // deader). Skips carry no outcome knowledge; probes exist precisely to
  // measure skip decisions with real verdicts.
  if (r.startsWith("skipped (self-model predicts")) return "excluded";
  if (
    r.includes("cosmetic") ||
    r.includes("no issues found") ||
    r.includes("no-growth") ||
    r.includes("nothing to")
  ) {
    return "zero-diff";
  }
  return "fail";
}

// ── Bootstrap: instant self-knowledge from history ────────────────────

let bootstrapped = false;

/** One-time: aggregate the MutationCorpus audit trail (every attempt the
 *  loop has ever recorded) into per-file SelfModelFile rows, then apply
 *  archaeology stability priors. Runs on first engine use; no-ops if the
 *  model already has rows (restart-safe). */
export async function bootstrapSelfModel(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  try {
    const existing = await db.selfModelFile.count();
    if (existing > 0) return; // already bootstrapped (or organically grown)

    // 1. Mine the corpus. gateOutcome values (mutation-corpus writer):
    //   enhanced → pass | typecheck-fail/debate-fail/test-fail/truncation/
    //   schema-rejected/error → fail | no-change/cosmetic → zero-diff
    //   deferred/llm-unavailable → no verdict, skip.
    const rows = await db.mutationCorpus.findMany({
      select: { filePath: true, gateOutcome: true },
      take: 2000,
    });
    const agg = new Map<
      string,
      { attempts: number; passes: number; fails: number; zeroDiffs: number; last: string }
    >();
    for (const row of rows) {
      const o = row.gateOutcome;
      if (o === "deferred" || o === "llm-unavailable") continue;
      const cur =
        agg.get(row.filePath) ?? { attempts: 0, passes: 0, fails: 0, zeroDiffs: 0, last: "" };
      cur.attempts++;
      if (o === "enhanced") {
        cur.passes++;
        cur.last = "pass";
      } else if (o === "no-change" || o === "cosmetic") {
        cur.zeroDiffs++;
        cur.last = "zero-diff";
      } else {
        cur.fails++;
        cur.last = "fail";
      }
      agg.set(row.filePath, cur);
    }

    // 2. Archaeology priors (audit 7 de-mock): stable files from git
    //    history start MORE exhausted; fragile files start LESS.
    //    Lazy import (audit 7): keeps getSelfModelSummary's import chain
    //    light so the /api/self-model route compile doesn't pull in
    //    archaeology.ts → lessons-markdown.ts at module-eval time.
    let stableSet = new Set<string>();
    let fragileSet = new Set<string>();
    try {
      const { readArchaeologyReport } = await import("./archaeology");
      const report = readArchaeologyReport();
      if (report) {
        stableSet = new Set(report.stableFiles.map((s) => s.file));
        fragileSet = new Set(report.fragileFiles.map((f) => f.file));
      }
    } catch {
      /* no report yet — neutral priors */
    }

    // 3. Write the model rows.
    for (const [filePath, s] of agg) {
      // Exhaustion prior: dominant zero-diffs → finished; passes pull down.
      const zeroFrac = s.attempts > 0 ? s.zeroDiffs / s.attempts : 0;
      let finished = Math.min(0.9, zeroFrac * 0.8);
      if (stableSet.has(filePath)) finished = Math.min(1, finished + 0.25);
      if (fragileSet.has(filePath)) finished = Math.max(0, finished - 0.25);
      await db.selfModelFile
        .upsert({
          where: { filePath },
          create: {
            filePath,
            attempts: s.attempts,
            passes: s.passes,
            fails: s.fails,
            zeroDiffs: s.zeroDiffs,
            finishedScore: finished,
            lastOutcome: s.last || null,
          },
          update: {}, // count() > 0 guard makes this unreachable; kept for safety
        })
        .catch(() => { /* fail-soft per row */ });
    }
    console.log(
      `[SELF-MODEL] bootstrapped from corpus: ${agg.size} files, ` +
        `${stableSet.size} stable priors, ${fragileSet.size} fragile priors`
    );
  } catch {
    // No table yet / DB unavailable — engine degrades to neutral defaults.
  }
}

// ── Verdict recording ─────────────────────────────────────────────────

/** Record a verdict into the self-model. Called after every enhanceFile
 *  result. Updates counters + the exhaustion score (zero-diff pushes
 *  toward "finished", a pass pulls back). Fail-soft. */
export async function noteOutcome(
  filePath: string,
  outcome: SelfOutcome,
  mode: "refactor" | "visual-polish" = "refactor"
): Promise<void> {
  if (outcome === "excluded") return; // no verdict — not knowledge
  try {
    const existing = await db.selfModelFile.findUnique({ where: { filePath } });
    if (!existing) {
      await db.selfModelFile.create({
        data: {
          filePath,
          attempts: 1,
          passes: outcome === "pass" ? 1 : 0,
          fails: outcome === "fail" ? 1 : 0,
          zeroDiffs: outcome === "zero-diff" ? 1 : 0,
          visualPolishAttempts: mode === "visual-polish" ? 1 : 0,
          visualPolishPasses: mode === "visual-polish" && outcome === "pass" ? 1 : 0,
          lastTouchedAt: new Date(),
          lastOutcome: outcome,
          finishedScore:
            outcome === "zero-diff" ? 0.25 : outcome === "pass" ? 0.1 : 0,
          // Momentum: only a successful mutation opens a streak — a fail
          // or zero-diff records 0 (nothing is "hot" without a landed
          // enhancement).
          streak: outcome === "pass" ? 1 : 0,
        },
      });
      return;
    }
    // Exhaustion dynamics: consecutive zero-diffs accumulate (+0.25 each,
    // capped 1); a pass signals room-to-improve (-0.15, floor 0); a fail
    // is neutral (the file has work, the attempt was just wrong).
    const finished =
      outcome === "zero-diff"
        ? Math.min(1, existing.finishedScore + 0.25)
        : outcome === "pass"
          ? Math.max(0, existing.finishedScore - 0.15)
          : existing.finishedScore;
    // Momentum dynamics: a pass EXTENDS the success streak (+1 — the file
    // just proved, again, that it can absorb a clean enhancement); a fail
    // or zero-diff RESETS it (streaks measure consecutive landed work —
    // one no-growth cycle and the file is no longer "hot"). The bandit
    // turns streak into a capped selection bonus (MOMENTUM_STEP/CAP).
    const streak = outcome === "pass" ? existing.streak + 1 : 0;
    await db.selfModelFile.update({
      where: { filePath },
      data: {
        attempts: { increment: 1 },
        passes: { increment: outcome === "pass" ? 1 : 0 },
        fails: { increment: outcome === "fail" ? 1 : 0 },
        zeroDiffs: { increment: outcome === "zero-diff" ? 1 : 0 },
        visualPolishAttempts: { increment: mode === "visual-polish" ? 1 : 0 },
        visualPolishPasses:
          { increment: mode === "visual-polish" && outcome === "pass" ? 1 : 0 },
        lastTouchedAt: new Date(),
        lastOutcome: outcome,
        finishedScore: finished,
        streak,
      },
    });
  } catch {
    /* fail-soft */
  }
}

// ── Self-correcting confidence (calibration feedback) ──────────────────

export interface BucketCorrection {
  /** The decile range [lo, hi) this correction applies to. */
  lo: number;
  hi: number;
  /** Resolved predictions measured in this range. */
  n: number;
  /** Mean predicted confidence in the range. */
  meanPredicted: number;
  /** Fraction that actually passed in the range. */
  meanActual: number;
  /** The applied shift: (actual − predicted), clamped to ±CORRECTION_MAX_SHIFT. */
  shift: number;
}

export interface ConfidenceCorrection {
  active: boolean;
  /** Additive shift applied to raw confidence: corrected = clamp(raw + shift).
   *  For the summary headline this is the WORST active range's shift; for
   *  getCorrectionForRange it is the queried range's shift. */
  shift: number;
  /** Resolved predictions the shift was measured over. */
  n: number;
  meanConfidence: number;
  meanActual: number;
  reason: string;
  /** Audit 8: the full per-decile correction table. The loop's bias is
   *  directional by range — this is the picture a single scalar can't show. */
  buckets: BucketCorrection[];
}

/** The per-decile measured-bias table, TTL-cached (5 min) so per-attempt
 *  calls don't re-query. Dormant per-range until that range's bias is
 *  clearly systematic. */
let _correctionTableCache: { at: number; table: BucketCorrection[] } | null = null;
const CORRECTION_TTL_MS = 5 * 60_000;
/** Samples a decile needs before its measured bias is trusted. */
const BUCKET_MIN_N = 8;
const CORRECTION_TRIGGER_GAP = 0.05;
const CORRECTION_MAX_SHIFT = 0.15;

function dormantCorrection(reason: string): ConfidenceCorrection {
  return {
    active: false,
    shift: 0,
    n: 0,
    meanConfidence: 0,
    meanActual: 0,
    reason,
    buckets: [],
  };
}

/** WHY PER-DECILE (audit 8 — the dormant-scalar smell): the old single
 *  correction compared MEAN predicted vs MEAN actual over recent
 *  predictions. The loop's miscalibration is DIRECTIONAL BY RANGE: it is
 *  slightly underconfident at 0.1-0.2 (predicts 17%, passes 23%) and
 *  sharply overconfident at 0.4-0.6 (predicts 43-53%, passes 25-33%).
 *  The two errors CANCEL in the aggregate — the scalar read "bias
 *  −0.004, within noise" and stayed dormant forever while every
 *  mid-range prediction kept overshooting by ~0.18 (the post-gate
 *  regret the bucket curve exposed). Fix: measure the bias PER DECILE
 *  and apply the shift of the range the raw prediction falls in. As
 *  corrected predictions land, each range's gap shrinks and its shift
 *  converges to zero — the calibration curve feeding back into the
 *  predictor, per range instead of on average. */
async function buildCorrectionTable(): Promise<BucketCorrection[]> {
  if (_correctionTableCache && Date.now() - _correctionTableCache.at < CORRECTION_TTL_MS) {
    return _correctionTableCache.table;
  }
  let table: BucketCorrection[] = [];
  try {
    const rows = await db.selfPrediction.findMany({
      where: { outcome: { in: ["pass", "fail", "zero-diff"] } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { confidence: true, outcome: true },
    });
    for (let i = 0; i < 10; i++) {
      const lo = i / 10;
      const hi = (i + 1) / 10;
      const inBucket = rows.filter(
        (p) => p.confidence >= lo && (i === 9 ? p.confidence <= hi : p.confidence < hi)
      );
      if (inBucket.length < BUCKET_MIN_N) continue;
      const meanPred = inBucket.reduce((a, p) => a + p.confidence, 0) / inBucket.length;
      const meanAct = inBucket.filter((p) => p.outcome === "pass").length / inBucket.length;
      const gap = meanAct - meanPred; // < 0 = over-confident, > 0 = under-confident
      if (Math.abs(gap) < CORRECTION_TRIGGER_GAP) continue;
      const shift = Math.max(-CORRECTION_MAX_SHIFT, Math.min(CORRECTION_MAX_SHIFT, gap));
      table.push({
        lo,
        hi,
        n: inBucket.length,
        meanPredicted: round3(meanPred),
        meanActual: round3(meanAct),
        shift: round3(shift),
      });
    }
  } catch {
    table = [];
  }
  _correctionTableCache = { at: Date.now(), table };
  return table;
}

function rangeLabel(b: BucketCorrection): string {
  return `${(b.lo * 100).toFixed(0)}-${(b.hi * 100).toFixed(0)}%`;
}

/** The range-aware correction for ONE raw confidence value: the measured
 *  bias of the decile it lands in, or dormant when that decile has no
 *  significant measured bias. This is what predictConfidence applies —
 *  a 0.45 prediction gets the 0.4-0.5 shift, not a global average. */
export async function getCorrectionForRange(raw: number): Promise<ConfidenceCorrection> {
  const table = await buildCorrectionTable();
  const b = table.find(
    (x) => raw >= x.lo && (x.lo >= 0.9 ? raw <= x.hi : raw < x.hi)
  );
  if (!b) {
    return dormantCorrection(
      table.length > 0
        ? `dormant at ${(raw * 100).toFixed(0)}% — this range is calibrated within noise (${table.length} other range(s) corrected)`
        : "dormant — no confidence range has a significant measured bias yet"
    );
  }
  const dir = b.shift < 0 ? "over-confident" : "under-confident";
  return {
    active: true,
    shift: b.shift,
    n: b.n,
    meanConfidence: b.meanPredicted,
    meanActual: b.meanActual,
    reason:
      `ACTIVE ${rangeLabel(b)} — ${dir} here: I predict ${(b.meanPredicted * 100).toFixed(0)}% but pass ` +
      `${(b.meanActual * 100).toFixed(0)}% (n=${b.n}); shifting predictions in this range ` +
      `${b.shift >= 0 ? "+" : ""}${b.shift.toFixed(2)}`,
    buckets: table,
  };
}

/** The headline correction for the summary/UI: the WORST active range
 *  (largest |shift|) with the full per-decile table attached, so the
 *  panel can show WHICH ranges are being corrected — not just a number
 *  that hides the low/high cancellation. */
export async function getConfidenceCorrection(): Promise<ConfidenceCorrection> {
  const table = await buildCorrectionTable();
  if (table.length === 0) {
    return dormantCorrection(
      "dormant — no confidence range has a significant measured bias (per-decile, audit 8)"
    );
  }
  const worst = [...table].sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift))[0];
  const ranges = table
    .map(
      (b) =>
        `${rangeLabel(b)} (predict ${(b.meanPredicted * 100).toFixed(0)}% → actual ` +
        `${(b.meanActual * 100).toFixed(0)}%, shift ${b.shift >= 0 ? "+" : ""}${b.shift.toFixed(2)}, n=${b.n})`
    )
    .join(" · ");
  return {
    active: true,
    shift: worst.shift,
    n: worst.n,
    meanConfidence: worst.meanPredicted,
    meanActual: worst.meanActual,
    reason: `ACTIVE in ${table.length} range(s): ${ranges}`,
    buckets: table,
  };
}

// ── Self-prediction (the calibration engine) ──────────────────────────

export interface SelfPredictionInput {
  confidence: number;
  reason: string;
}

/** Predict the probability that an attempt on this file passes all gates,
 *  from the self-model's empirical data. This is the system predicting
 *  ITSELF — no LLM call, just its own measured history speaking. */
export async function predictConfidence(
  filePath: string,
  mode: "refactor" | "visual-polish" = "refactor"
): Promise<SelfPredictionInput> {
  try {
    const [file, totals] = await Promise.all([
      db.selfModelFile.findUnique({ where: { filePath } }),
      db.selfModelFile.aggregate({
        _sum: { attempts: true, passes: true },
      }),
    ]);
    const globalRate =
      totals._sum.attempts && totals._sum.attempts > 0
        ? (totals._sum.passes ?? 0) / totals._sum.attempts
        : 0.45; // no data at all — modest prior
    if (!file || file.attempts === 0) {
      return {
        confidence: clamp(globalRate * 0.9 + 0.05),
        reason: `no history on this file — global rate ${(globalRate * 100).toFixed(0)}%`,
      };
    }
    // Laplace-smoothed empirical rate for this file (+1 pass / +2 attempts
    // pulls toward 0.5 — small samples can't claim extremes).
    const empirical = (file.passes + 1) / (file.attempts + 2);
    // Mode-specific rate for visual-polish when we have VP history.
    let modeNote = "";
    let rate = empirical;
    if (mode === "visual-polish" && file.visualPolishAttempts >= 2) {
      const vpRate = (file.visualPolishPasses + 1) / (file.visualPolishAttempts + 2);
      rate = 0.5 * empirical + 0.5 * vpRate;
      modeNote = `, visual-polish rate ${(vpRate * 100).toFixed(0)}%`;
    }
    // Blend with global: more file attempts → more weight on the file rate.
    const w = Math.min(0.85, file.attempts / 5);
    let confidence = w * rate + (1 - w) * globalRate;
    // Exhaustion discount: finished files fail differently (zero-diff),
    // and we know it — the prediction should carry that knowledge.
    if (file.finishedScore > 0.4) {
      confidence *= (1 - 0.4 * (file.finishedScore - 0.4));
    }
    // SELF-CORRECTION (calibration feedback, audit 8 — range-aware): apply
    // the measured bias OF THE DECILE this prediction lands in. The old
    // single scalar stayed dormant because low-range underconfidence
    // canceled high-range overconfidence in the aggregate; per-decile
    // shifts actually correct the mid-range overshoot the bucket curve
    // exposed. Dormant (shift 0) while this range is calibrated within
    // noise — see getCorrectionForRange.
    const rawConfidence = confidence;
    const correction = await getCorrectionForRange(rawConfidence);
    if (correction.active && correction.shift !== 0) {
      confidence += correction.shift;
    }
    return {
      confidence: clamp(confidence),
      reason:
        `empirical ${(empirical * 100).toFixed(0)}% over ${file.attempts} attempt(s)` +
        modeNote +
        `, global ${(globalRate * 100).toFixed(0)}%, exhaustion ${file.finishedScore.toFixed(2)}` +
        (correction.active && correction.shift !== 0
          ? `, calib ${correction.shift >= 0 ? "+" : ""}${correction.shift.toFixed(2)} (range-aware correction)`
          : ""),
    };
  } catch {
    return { confidence: 0.45, reason: "self-model unavailable — modest prior" };
  }
}

/** Open a prediction row before an attempt. Returns the row id so the
 *  caller can resolve it whatever happens next. Fail-soft: null means
 *  "no prediction recorded" (calibration just loses one sample).
 *  skipProbe=true tags the row as a PROBED proactive-skip (the loop spent
 *  the call specifically to score the skip rule) — the audit's skip-rule
 *  section reads the tag; the calibration curve ignores it. */
export async function openSelfPrediction(
  filePath: string,
  mode: "refactor" | "visual-polish",
  cycleNumber: number,
  skipProbe = false
): Promise<string | null> {
  try {
    const pred = await predictConfidence(filePath, mode);
    const row = await db.selfPrediction.create({
      data: {
        filePath,
        mode,
        confidence: pred.confidence,
        cycleNumber,
        reason: pred.reason,
        skipProbe,
      },
    });
    return row.id;
  } catch {
    return null;
  }
}

/** Resolve an open prediction with the actual verdict. Fail-soft. */
export async function resolveSelfPrediction(
  predictionId: string | null,
  outcome: SelfOutcome
): Promise<void> {
  if (!predictionId) return;
  try {
    // "excluded" verdicts (LLM gate closed — no attempt happened) are
    // marked as such and excluded from calibration; they carry no signal.
    await db.selfPrediction.update({
      where: { id: predictionId },
      data: {
        outcome,
        resolvedAt: new Date(),
      },
    });
  } catch {
    /* fail-soft */
  }
}

// ── Bandit target selection (UCB1) ────────────────────────────────────

export interface TargetScore {
  filePath: string;
  score: number;
  reason: string;
}

/** MOMENTUM — the "mutability percentage" that rises with each successful
 *  mutation of a file. Consecutive pushed enhancements build a streak;
 *  every streak step adds MOMENTUM_STEP of selection weight, up to
 *  MOMENTUM_CAP (the limit: +15% at 3 consecutive passes — beyond that,
 *  more successes do NOT stack further, so one hot streak can never
 *  dominate the empirical rate + exploration terms). Any fail or
 *  zero-diff resets the streak to 0 (momentum is earned by LANDED work,
 *  and lost the moment a cycle yields nothing). The lifetime empirical
 *  pass rate already rewards sustained quality; momentum rewards CURRENT
 *  form — a file that just landed 3 clean enhancements in a row is the
 *  best bet for a 4th. */
export const MOMENTUM_STEP = 0.05; // +5% of selection weight per success
export const MOMENTUM_CAP = 0.15; // hard limit: maxes at 3 consecutive passes

export function momentumFromStreak(streak: number): number {
  return Math.min(MOMENTUM_CAP, Math.max(0, streak) * MOMENTUM_STEP);
}

/** Score every candidate file with the UCB1-style bandit and return them
 *  sorted best-first. The loop iterates THIS order instead of tree order
 *  — its choice of what to work on becomes a decision, self-explained. */
export async function orderTargetsByBandit(
  candidateAbsPaths: string[],
  projectRoot: string,
  log?: (line: string, level?: "info" | "warn" | "success" | "error") => void
): Promise<{ ordered: string[]; scores: TargetScore[] }> {
  try {
    await bootstrapSelfModel();
    // Normalize candidates to repo-relative paths for model lookup.
    const rel = candidateAbsPaths.map((p) =>
      p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : p
    );
    const modelRows = await db.selfModelFile.findMany();
    const byPath = new Map(modelRows.map((r) => [r.filePath, r]));
    const totalAttempts = modelRows.reduce((a, r) => a + r.attempts, 0);
    const now = Date.now();

    const scored: Array<{ abs: string; s: TargetScore }> = rel.map((r, i) => {
      const m = byPath.get(r);
      const attempts = m?.attempts ?? 0;
      const passes = m?.passes ?? 0;
      const finished = m?.finishedScore ?? 0;
      // Empirical rate, Laplace-smoothed (no history → 0.5 neutral).
      const empirical = attempts > 0 ? (passes + 1) / (attempts + 2) : 0.5;
      // Classic UCB1 exploration term: untried files get a look.
      const exploration =
        0.6 * Math.sqrt(Math.log(1 + Math.max(1, totalAttempts)) / (1 + attempts));
      // Recency: untouched-for-weeks files resurface (max +0.2 at 14d).
      const daysSince = m?.lastTouchedAt
        ? (now - new Date(m.lastTouchedAt).getTime()) / 86_400_000
        : 30;
      const recency = Math.min(1, daysSince / 14) * 0.2;
      // Exhaustion: finished files sink (max -0.35).
      const exhaustion = finished * 0.35;
      // Momentum: consecutive-success bonus (+5%/pass, capped +15%).
      // Hot files rise; the cap keeps a streak from stacking past the
      // point where it drowns out exploration of everything else.
      const momentum = momentumFromStreak(m?.streak ?? 0);
      const score = empirical + exploration + recency + momentum - exhaustion;
      const reason =
        attempts > 0
          ? `${passes}/${attempts} passed, ${daysSince < 1 ? "touched today" : `${Math.round(daysSince)}d untouched`}, exhaustion ${finished.toFixed(2)}, momentum +${(momentum * 100).toFixed(0)}% (streak ${m?.streak ?? 0})`
          : "no history — exploring";
      return { abs: candidateAbsPaths[i], s: { filePath: r, score, reason } };
    });

    scored.sort((a, b) => b.s.score - a.s.score);
    // Self-explain the top 3 selections — the loop narrating its own
    // decision-making. This is the visible "cognitive" behavior.
    if (log) {
      for (const { s } of scored.slice(0, 3)) {
        log(
          `🧠 target: ${s.filePath} — score ${s.score.toFixed(2)} (${s.reason})`,
          "info"
        );
      }
    }
    return { ordered: scored.map((x) => x.abs), scores: scored.map((x) => x.s) };
  } catch {
    // Model unavailable — degrade to the incoming (tree) order.
    return { ordered: candidateAbsPaths, scores: [] };
  }
}

// ── Proactive saturation skip (audit 7 — "predict files that will zero-diff") ──

export interface ProactiveSkipDecision {
  skip: boolean;
  reason: string;
  /** The self-model's measured finished-score for this file (0-1). */
  finishedScore: number;
  /** The predicted confidence this attempt passes (0-1). */
  confidence: number;
  /** How many attempts the model has on this file (0 = no history). */
  attempts: number;
}

/** The cognitive layer's proactive "this file is finished" detector. The
 *  loop calls this BEFORE spending an LLM call on a file. When it returns
 *  skip=true, the loop logs the decision and moves on — turning a would-be
 *  zero-diff (which the old design only discovered AFTER burning quota) into
 *  a free, predicted skip.
 *
 *  The threshold is deliberately conservative but fires BEFORE the 3-strike
 *  lockout (which needs consecutiveNoGrowth >= 3, producing finishedScore
 *  0.75 — exactly the OLD >= 0.7 threshold). At 0.7, the proactive-skip was
 *  starved: any file reaching it was already locked out by the saturation
 *  lockout (which checks first in the cycle), so the proactive path NEVER
 *  fired and the skip-probe calibration stayed at 0. Lowering to 0.5
 *  (2 consecutive zero-diffs) fires on the cycle BEFORE the 3rd would
 *  trigger the lockout — saving the call AND feeding the skip-probe
 *  verdict with real samples.
 *
 *  A file must have:
 *    - enough history for a Laplace-smoothed rate (attempts >= 3),
 *    - a meaningful zero-diff pattern (finishedScore >= 0.5 — two+
 *      consecutive zero-diffs with no pass to pull it back down),
 *    - AND a low predicted confidence (< 0.2 — the pass predictor agrees
 *      this file is cold).
 *  A file that FAILS a lot (not zero-diffs) has a low confidence but a low
 *  finished-score → NOT skipped (failures are still learning signal for the
 *  debate tribunal and the corpus). Only files the model has CONVERGED on
 *  as "nothing left to improve" are proactively skipped.
 *
 *  Fail-soft: a missing table or DB error returns skip=false (the loop
 *  falls back to spending the LLM call — honest, just not optimal). */
export async function shouldProactivelySkip(
  filePath: string
): Promise<ProactiveSkipDecision> {
  try {
    const file = await db.selfModelFile.findUnique({ where: { filePath } });
    if (!file || file.attempts < 3) {
      return {
        skip: false,
        reason: file ? `only ${file.attempts} attempt(s) — too few to trust` : "no history yet",
        finishedScore: file?.finishedScore ?? 0,
        confidence: 0.5,
        attempts: file?.attempts ?? 0,
      };
    }
    const pred = await predictConfidence(filePath, "refactor");
    // 0.5 threshold (lowered from 0.7) — fires after 2 consecutive zero-diffs,
    // BEFORE the 3rd triggers the saturation lockout. The lockout and the
    // proactive-skip were racing for the same evidence at 0.7 (3 zero-diffs =
    // 0.75), and the lockout always won because it checks first in the cycle.
    // At 0.5, the proactive-skip gets one cycle of priority to predict the
    // 3rd zero-diff and save the call, and the skip-probe mechanism finally
    // accumulates resolved samples for its calibration verdict.
    //
    // PROBE-FEEDBACK CEILING (audit 8): the skip rule is scored by its own
    // probes (every 4th skip spends the call anyway). When probes show the
    // skipper DISCARDING live files (miss rate > 0.1 with n ≥ 3), tighten
    // the confidence ceiling from 0.20 to 0.10 — the 0.0-0.1 bucket
    // measures ~4% actual passes, so a sub-10% prediction is the only
    // "dead" signal still trusted at that evidence level. As probes
    // accumulate and the miss rate falls back to ≤ 0.1, the ceiling
    // relaxes to 0.20 again. The rule tunes itself on its own scored
    // evidence instead of waiting for an operator to read the verdict.
    const probeRows = await db.selfPrediction.findMany({
      where: { skipProbe: true, outcome: { in: ["pass", "fail", "zero-diff"] } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { outcome: true },
    });
    const probeN = probeRows.length;
    const probeMiss = probeRows.filter((p) => p.outcome === "pass").length;
    const missRate = probeN > 0 ? probeMiss / probeN : 0;
    const ceiling = probeN >= 3 && missRate > 0.1 ? 0.1 : 0.2;

    const skip = file.finishedScore >= 0.5 && pred.confidence < ceiling;
    return {
      skip,
      reason: skip
        ? `proactively skipping — finished ${file.finishedScore.toFixed(2)}, predicted ${(pred.confidence * 100).toFixed(0)}% < ${(ceiling * 100).toFixed(0)}% ceiling (will zero-diff); ${file.zeroDiffs}/${file.attempts} zero-diffs` +
          (probeN >= 3
            ? `; probe miss-rate ${(missRate * 100).toFixed(0)}% (n=${probeN}) → ceiling ${(ceiling * 100).toFixed(0)}%`
            : "")
        : `not skipping — finished ${file.finishedScore.toFixed(2)}, predicted ${(pred.confidence * 100).toFixed(0)}%` +
          (ceiling < 0.2
            ? ` vs tightened ${(ceiling * 100).toFixed(0)}% ceiling (probe miss-rate ${(missRate * 100).toFixed(0)}%, n=${probeN})`
            : ""),
      finishedScore: file.finishedScore,
      confidence: pred.confidence,
      attempts: file.attempts,
    };
  } catch {
    return {
      skip: false,
      reason: "self-model unavailable — spending the call (honest fallback)",
      finishedScore: 0,
      confidence: 0.5,
      attempts: 0,
    };
  }
}

// ── Calibration + summary (the self-awareness surface) ────────────────

export interface CalibrationBucket {
  bucket: string; // "0.5-0.6"
  n: number;
  predicted: number; // mean confidence in the bucket
  actual: number; // fraction that passed
  gap: number; // |predicted - actual| (lower = calibrated)
}

export interface SelfModelSummary {
  files: Array<{
    filePath: string;
    attempts: number;
    passes: number;
    fails: number;
    zeroDiffs: number;
    passRate: number | null;
    finishedScore: number;
    lastTouchedAt: string | null;
    lastOutcome: string | null;
    visualPolishAttempts: number;
    visualPolishPasses: number;
    /** Consecutive successful mutations (pass streak). Resets on any
     *  fail or zero-diff. Drives the momentum bonus. */
    streak: number;
    /** The momentum selection bonus as a percentage (0-15): +5% per
     *  streak step, capped at MOMENTUM_CAP. Surfaced so the panel can
     *  show WHICH files the bandit currently favors and why. */
    momentumPct: number;
  }>;
  calibration: {
    buckets: CalibrationBucket[];
    resolvedPredictions: number;
    pendingPredictions: number;
    brierScore: number | null; // mean (confidence - outcome)² — lower is better
    reliability: number | null; // mean |gap| across populated buckets
    verdict: string; // plain-language self-assessment
    /** The self-correcting confidence: the measured systematic bias,
     *  currently being APPLIED to predictConfidence's output. Closes the
     *  loop the calibration curve opened — the verdict becomes action. */
    correction: ConfidenceCorrection;
  };
  modeStats: {
    refactor: { attempts: number; passes: number };
    visualPolish: { attempts: number; passes: number };
  };
  totals: { attempts: number; passes: number; failss: number; zeroDiffs: number };
  /** Skip-rule scoring: the proactive-skip predictor ("finished + low
   *  confidence → will zero-diff, don't spend the call") measured via
   *  probes — skipped files never open prediction rows, so the ONLY
   *  data on whether the skipper is right comes from probed skips. */
  skipProbes: {
    probes: number;
    zeroDiffs: number;
    fails: number;
    passes: number;
    /** (zeroDiffs + fails) / probes — fraction where the skip would have
     *  saved a no-growth call (the skipper was right to save it). */
    savedRate: number | null;
    /** passes / probes — fraction where the file was LIVE (the skipper
     *  would have discarded a real enhancement — the costly error). */
    missedRate: number | null;
    verdict: string;
  };
}

/** Compute the full self-awareness summary for the API/UI: per-file
 *  knowledge, calibration curve, mode stats. Fail-soft: empty summary. */
export async function getSelfModelSummary(): Promise<SelfModelSummary> {
  const empty: SelfModelSummary = {
    files: [],
    calibration: {
      buckets: [],
      resolvedPredictions: 0,
      pendingPredictions: 0,
      brierScore: null,
      reliability: null,
      verdict: "no predictions resolved yet — calibration begins with the next cycles",
      correction: {
        active: false,
        shift: 0,
        n: 0,
        meanConfidence: 0,
        meanActual: 0,
        reason: "correction dormant — no measurement yet",
        buckets: [],
      },
    },
    modeStats: { refactor: { attempts: 0, passes: 0 }, visualPolish: { attempts: 0, passes: 0 } },
    totals: { attempts: 0, passes: 0, failss: 0, zeroDiffs: 0 },
    skipProbes: {
      probes: 0,
      zeroDiffs: 0,
      fails: 0,
      passes: 0,
      savedRate: null,
      missedRate: null,
      verdict: "no skip-probes resolved yet — the skip rule is unmeasured until probes land",
    },
  };
  try {
    const files = await db.selfModelFile.findMany({
      orderBy: { attempts: "desc" },
      take: 200,
    });
    const preds = await db.selfPrediction.findMany({
      where: { outcome: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 1000,
    });
    const pending = await db.selfPrediction.count({ where: { outcome: null } });

    // Calibration buckets over resolved, non-excluded predictions.
    const resolved = preds.filter((p) => p.outcome === "pass" || p.outcome === "fail" || p.outcome === "zero-diff");
    const buckets: CalibrationBucket[] = [];
    let brierSum = 0;
    for (let i = 0; i < 10; i++) {
      const lo = i / 10;
      const hi = (i + 1) / 10;
      const inBucket = resolved.filter(
        (p) => p.confidence >= lo && (i === 9 ? p.confidence <= hi : p.confidence < hi)
      );
      const n = inBucket.length;
      const predicted = n > 0 ? inBucket.reduce((a, p) => a + p.confidence, 0) / n : 0;
      const actual = n > 0 ? inBucket.filter((p) => p.outcome === "pass").length / n : 0;
      buckets.push({
        bucket: `${lo.toFixed(1)}-${hi.toFixed(1)}`,
        n,
        predicted: round2(predicted),
        actual: round2(actual),
        gap: n > 0 ? round2(Math.abs(predicted - actual)) : 0,
      });
    }
    for (const p of resolved) {
      const o = p.outcome === "pass" ? 1 : 0;
      brierSum += (p.confidence - o) * (p.confidence - o);
    }
    const brier = resolved.length > 0 ? round3(brierSum / resolved.length) : null;
    const populated = buckets.filter((b) => b.n >= 3);
    const reliability =
      populated.length > 0 ? round3(populated.reduce((a, b) => a + b.gap, 0) / populated.length) : null;

    let verdict: string;
    if (resolved.length < 20) {
      verdict = `calibrating — ${resolved.length}/20 resolved predictions (need ≥20 for a first read, ~100 for a stable curve)`;
    } else if (brier === null) {
      verdict = "insufficient data";
    } else if (brier <= 0.1) {
      verdict = `well-calibrated (Brier ${brier}) — when I say X% confident, I'm right ~X% of the time`;
    } else if (brier <= 0.25) {
      verdict = `moderately calibrated (Brier ${brier}) — my confidence roughly tracks my accuracy`;
    } else {
      // Direction of miscalibration: over- or under-confident?
      const meanConf = resolved.reduce((a, p) => a + p.confidence, 0) / resolved.length;
      const meanActual = resolved.filter((p) => p.outcome === "pass").length / resolved.length;
      verdict =
        meanConf > meanActual + 0.1
          ? `OVERCONFIDENT (Brier ${brier}) — I predict ${(meanConf * 100).toFixed(0)}% but pass ${(meanActual * 100).toFixed(0)}%; lowering my self-estimates`
          : meanConf < meanActual - 0.1
            ? `UNDERCONFIDENT (Brier ${brier}) — I predict ${(meanConf * 100).toFixed(0)}% but pass ${(meanActual * 100).toFixed(0)}%; my self-model undersells me`
            : `miscalibrated (Brier ${brier}) but directionally honest`;
    }

    // ── SELF-CORRECTION (calibration feedback) ──
    // The measured-bias shift that is CURRENTLY being applied to every
    // predictConfidence output. Surfaced so the panel can show the loop
    // acting on its own measured miscalibration, not just reporting it.
    const correction = await getConfidenceCorrection();
    if (correction.active) {
      verdict += ` Self-correction ACTIVE in ${correction.buckets.length} confidence range(s) — per-decile shifts now applied to predictions (worst: ${correction.shift >= 0 ? "+" : ""}${correction.shift.toFixed(2)}).`;
    }

    const totals = files.reduce(
      (a, f) => ({
        attempts: a.attempts + f.attempts,
        passes: a.passes + f.passes,
        failss: a.failss + f.fails,
        zeroDiffs: a.zeroDiffs + f.zeroDiffs,
      }),
      { attempts: 0, passes: 0, failss: 0, zeroDiffs: 0 }
    );

    // ── SKIP-RULE SCORING (the measured half of the proactive skip) ──
    // The skip rule ("finished ≥ 0.7 AND predicted pass < 0.2 → will
    // zero-diff, save the call") is only measurable on PROBED skips:
    // every 4th skip spends the call anyway with its prediction row
    // tagged skipProbe=true. Outcomes score the skipper — zero-diff or
    // fail = no growth, the skip would have saved a wasted call (right);
    // pass = the file was live and the skipper would have discarded a
    // real enhancement (wrong, and the costly kind of wrong).
    const probeRows = resolved.filter((p) => p.skipProbe === true);
    const pZero = probeRows.filter((p) => p.outcome === "zero-diff").length;
    const pFail = probeRows.filter((p) => p.outcome === "fail").length;
    const pPass = probeRows.filter((p) => p.outcome === "pass").length;
    const savedRate = probeRows.length > 0 ? round2((pZero + pFail) / probeRows.length) : null;
    const missedRate = probeRows.length > 0 ? round2(pPass / probeRows.length) : null;
    let skipVerdict: string;
    if (probeRows.length === 0) {
      skipVerdict = "no skip-probes resolved yet — the skip rule is unmeasured until probes land";
    } else if ((missedRate ?? 0) <= 0.1) {
      skipVerdict =
        `skip rule looks safe — ${probeRows.length} probe(s): ${pZero} zero-diffed, ${pFail} failed (no growth either way — the skip saved them), ${pPass} passed (missed enhancement)`;
    } else {
      skipVerdict =
        `skip rule is skipping LIVE files — ${pPass}/${probeRows.length} probes PASSED (real enhancements the skipper would have discarded); consider raising the finished-score threshold or lowering the confidence ceiling`;
    }

    return {
      files: files.map((f) => ({
        filePath: f.filePath,
        attempts: f.attempts,
        passes: f.passes,
        fails: f.fails,
        zeroDiffs: f.zeroDiffs,
        passRate: f.attempts > 0 ? round2(f.passes / f.attempts) : null,
        finishedScore: round2(f.finishedScore),
        lastTouchedAt: f.lastTouchedAt ? f.lastTouchedAt.toISOString() : null,
        lastOutcome: f.lastOutcome,
        visualPolishAttempts: f.visualPolishAttempts,
        visualPolishPasses: f.visualPolishPasses,
        streak: f.streak,
        momentumPct: Math.round(momentumFromStreak(f.streak) * 100),
      })),
      calibration: {
        buckets,
        resolvedPredictions: resolved.length,
        pendingPredictions: pending,
        brierScore: brier,
        reliability,
        verdict,
        correction,
      },
      modeStats: {
        refactor: {
          attempts: resolved.filter((p) => p.mode === "refactor").length,
          passes: resolved.filter((p) => p.mode === "refactor" && p.outcome === "pass").length,
        },
        visualPolish: {
          attempts: resolved.filter((p) => p.mode === "visual-polish").length,
          passes: resolved.filter((p) => p.mode === "visual-polish" && p.outcome === "pass").length,
        },
      },
      totals,
      skipProbes: {
        probes: probeRows.length,
        zeroDiffs: pZero,
        fails: pFail,
        passes: pPass,
        savedRate,
        missedRate,
        verdict: skipVerdict,
      },
    };
  } catch {
    return empty;
  }
}

// ── small helpers ─────────────────────────────────────────────────────

function clamp(x: number): number {
  return Math.max(0.05, Math.min(0.95, x));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
