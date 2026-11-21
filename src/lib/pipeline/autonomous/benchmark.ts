/**
 * benchmark.ts — does the complexity earn its keep?
 *
 * WHAT THIS IS
 * ───────────
 * The #1 gap from the 10/10 list: prove the complexity (postmortems,
 * lessons, provenance, bandit) measurably improves mutation quality,
 * not just elaborate ceremony around an LLM. The honest, cheap,
 * retrospective A/B — no extra LLM calls, uses the data the loop
 * already generates.
 *
 * THREE NATURAL EXPERIMENTS
 * ─────────────────────────
 * 1. LESSONS A/B: attempts WITH lessons injected vs WITHOUT. The
 *    mutation corpus records `lessonIdsInjected` per attempt. Pass
 *    rate delta = the lessons' contribution. CONFOUNDER: lessons are
 *    injected by score, not randomly — high-score lessons inject on
 *    files the bandit thinks they'll help, which biases the "with"
 *    arm toward easier files. Flagged.
 * 2. PROVENANCE A/B: attempts BEFORE vs AFTER the provenance-injection
 *    commit (adea283c, 2026-11-21T03:42:12Z). Same files, same loop,
 *    same gates — the only difference is whether provenance was
 *    injected. CONFOUNDER: time-correlated changes (the panel fixes
 *    shipped in the same commit, but they don't affect mutation
 *    quality). Less confounded than the lessons A/B.
 * 3. POSTMORTEM A/B: attempts on files WITH an active postmortem vs
 *    WITHOUT. HEAVILY CONFOUNDED: files with scars are the ones that
 *    fail a lot — the postmortem is a SYMPTOM of difficulty, not a
 *    random assignment. A negative delta here is EXPECTED (scars are
 *    on harder files). This arm is reported for completeness, not as
 *    a causal estimate.
 *
 * HONESTY RULES
 * ────────────
 * - "enhanced" = pass; the FAILURE_OUTCOMES set = fail. "deferred",
 *   "no-change", "cosmetic" are NON-attempts (excluded from the
 *   denominator — a deferred cycle isn't a failed mutation).
 * - PASS RATE = enhanced / (enhanced + failures). NOT enhanced /
 *   total (which would let defers inflate the denominator).
 * - CONFIDENCE is a function of N (the denominator). <20 = "insufficient
 *   data". 20-99 = "low confidence". 100-499 = "medium". 500+ = "high".
 *   The confidence label is reported alongside every delta so the
 *   operator never over-reads a small-N fluke.
 * - CONFOUNDERS are stated in the output, not hidden. This is
 *   observational, not a randomized trial. The honest framing.
 *
 * PERFORMANCE
 * ───────────
 * One findMany on the mutation corpus (capped at 5000 rows, newest-
 * first) + one count on the postmortem table. ~50ms total. The corpus
 * is pruned to 2000 rows by retention, so this never reads more than
 * that. Fail-soft: returns null on any error.
 */

import { db } from "@/lib/db";

/** The FAILURE_OUTCOMES set — a gate rejection (a real failed
 *  mutation). Matches mutation-corpus.ts:63. Duplicated here to keep
 *  this module a pure leaf (no import cycle through mutation-corpus). */
const FAILURE_OUTCOMES = new Set([
  "typecheck-fail",
  "debate-fail",
  "test-fail",
  "truncation",
  "schema-rejected",
]);

/** The provenance-injection commit timestamp. Attempts before this
 *  are the "without provenance" arm; after are "with". Read from git
 *  at build time — hardcoded here (the commit SHA is stable). */
const PROVENANCE_COMMIT_ISO = "2026-11-21T03:42:12Z";

/** Minimum N (denominator) for each arm before we report a delta.
 *  Below this, the arm reports "insufficient data" rather than a
 *  potentially-fluke delta. */
const MIN_N_FOR_DELTA = 20;

/** A single arm of an A/B comparison. */
interface BenchmarkArm {
  /** How many attempts in this arm. */
  n: number;
  /** How many "enhanced" (passed the gate). */
  enhanced: number;
  /** How many gate failures (FAILURE_OUTCOMES). */
  failed: number;
  /** Pass rate = enhanced / (enhanced + failed), as a percentage. */
  passRatePct: number;
}

/** The result of one A/B comparison. */
interface BenchmarkResult {
  name: string;
  description: string;
  confounder: string;
  armA: BenchmarkArm;
  armB: BenchmarkArm;
  /** Pass-rate delta (B - A) in percentage points. */
  deltaPct: number;
  /** Honest confidence label based on the smaller arm's N. */
  confidence: "insufficient" | "low" | "medium" | "high";
  /** One-line conclusion the operator can act on. */
  verdict: string;
}

/** The overall benchmark report. */
export interface BenchmarkReport {
  overall: {
    lifetime: { enhanced: number; failed: number; passRatePct: number };
    recent: { enhanced: number; failed: number; passRatePct: number; trend: string };
    cyclesCompleted: number;
  };
  experiments: BenchmarkResult[];
  generatedAt: string;
}

/** Compute a pass rate from a list of gate outcomes.
 *  enhanced = pass; FAILURE_OUTCOMES = fail; everything else = non-
 *  attempt (excluded). Returns the arm + the raw counts. */
function armFromOutcomes(outcomes: string[]): BenchmarkArm {
  let enhanced = 0;
  let failed = 0;
  for (const o of outcomes) {
    if (o === "enhanced") enhanced++;
    else if (FAILURE_OUTCOMES.has(o)) failed++;
  }
  const denom = enhanced + failed;
  return {
    n: denom,
    enhanced,
    failed,
    passRatePct: denom > 0 ? Math.round((enhanced / denom) * 1000) / 10 : 0,
  };
}

/** Confidence label from the smaller arm's N. */
function confidenceFor(minArmN: number): BenchmarkResult["confidence"] {
  if (minArmN < MIN_N_FOR_DELTA) return "insufficient";
  if (minArmN < 100) return "low";
  if (minArmN < 500) return "medium";
  return "high";
}

/** A verdict string from the delta + confidence. */
function verdictFor(name: string, deltaPct: number, confidence: BenchmarkResult["confidence"]): string {
  if (confidence === "insufficient") {
    return `Insufficient data — need ${MIN_N_FOR_DELTA}+ attempts in each arm to call it. Accumulating as the loop runs.`;
  }
  const sign = deltaPct > 0 ? "+" : "";
  const abs = Math.abs(deltaPct).toFixed(1);
  if (Math.abs(deltaPct) < 2) {
    return `${name} shows no measurable effect (${sign}${abs}pp, ${confidence}). The complexity may be neutral here.`;
  }
  if (deltaPct > 0) {
    return `${name} HELPS — pass rate ${sign}${abs}pp higher when active (${confidence}). The complexity earns its keep on this axis.`;
  }
  return `${name} HURTS — pass rate ${abs}pp lower when active (${confidence}). The complexity may be counterproductive on this axis. Investigate.`;
}

/** Build the full benchmark report. Fail-soft: returns null on any
 *  error (the `benchmark` command reports "unavailable"). Reads the
 *  mutation corpus (capped 5000, newest-first) + the postmortem table.
 *  No extra LLM calls, no writes. */
export async function buildBenchmarkReport(): Promise<BenchmarkReport | null> {
  try {
    // ── 1. READ THE MUTATION CORPUS ──────────────────────────────
    // Capped at 5000 (the retention sweep keeps 2000, so this is
    // always a full read in practice). Newest-first so the "recent"
    // window is the first 20 resolvable attempts.
    const rows = await db.mutationCorpus.findMany({
      orderBy: { createdAt: "desc" },
      take: 5000,
      select: { gateOutcome: true, lessonIdsInjected: true, createdAt: true, filePath: true },
    });

    // ── 2. OVERALL LIFETIME + RECENT TREND ───────────────────────
    // Lifetime: all rows. Recent: last 20 resolvable (enhanced + failed).
    const lifetimeOutcomes = rows.map((r) => r.gateOutcome);
    const lifetimeArm = armFromOutcomes(lifetimeOutcomes);

    // Recent: first 20 resolvable (rows are newest-first).
    const resolvable = rows.filter(
      (r) => r.gateOutcome === "enhanced" || FAILURE_OUTCOMES.has(r.gateOutcome),
    );
    const recent20 = resolvable.slice(0, 20).map((r) => r.gateOutcome);
    const recentArm = armFromOutcomes(recent20);

    // Trend: second half vs first half of the recent 20.
    const first10 = resolvable.slice(10, 20).map((r) => r.gateOutcome);
    const second10 = resolvable.slice(0, 10).map((r) => r.gateOutcome);
    const firstArm = armFromOutcomes(first10);
    const secondArm = armFromOutcomes(second10);
    const trendDelta = secondArm.passRatePct - firstArm.passRatePct;
    const trend =
      Math.abs(trendDelta) < 10 ? "FLAT"
      : trendDelta > 0 ? "IMPROVING"
      : "DECLINING";

    // ── 3. LESSONS A/B ──────────────────────────────────────────
    // Split by lessonIdsInjected (per-attempt, recorded in the corpus).
    const withLessons = rows
      .filter((r) => r.lessonIdsInjected && r.lessonIdsInjected !== "[]")
      .map((r) => r.gateOutcome);
    const withoutLessons = rows
      .filter((r) => !r.lessonIdsInjected || r.lessonIdsInjected === "[]")
      .map((r) => r.gateOutcome);
    const lessonsA = armFromOutcomes(withoutLessons);
    const lessonsB = armFromOutcomes(withLessons);
    const lessonsConf = confidenceFor(Math.min(lessonsA.n, lessonsB.n));
    const lessonsDelta = lessonsB.passRatePct - lessonsA.passRatePct;

    // ── 4. PROVENANCE A/B ───────────────────────────────────────
    // Split by the provenance commit timestamp.
    const provTime = new Date(PROVENANCE_COMMIT_ISO);
    const beforeProv = rows
      .filter((r) => r.createdAt < provTime)
      .map((r) => r.gateOutcome);
    const afterProv = rows
      .filter((r) => r.createdAt >= provTime)
      .map((r) => r.gateOutcome);
    const provA = armFromOutcomes(beforeProv);
    const provB = armFromOutcomes(afterProv);
    const provConf = confidenceFor(Math.min(provA.n, provB.n));
    const provDelta = provB.passRatePct - provA.passRatePct;

    // ── 5. POSTMORTEM A/B (CONFOUNDED) ─────────────────────────
    // Files with an active postmortem vs without. CONFOUNDED: scars
    // are on harder files. Reported for completeness, not causal.
    // Read the active postmortem file paths, then split the corpus
    // by whether the attempt's filePath is in that set.
    let activeScarFiles = new Set<string>();
    try {
      const active = await db.postmortem.findMany({
        where: { status: "active", source: "autonomous" },
        select: { filePath: true },
      });
      activeScarFiles = new Set(active.map((a) => a.filePath));
    } catch {
      /* postmortem read failed — skip this experiment */
    }
    const withScar = rows
      .filter((r) => activeScarFiles.has(r.filePath))
      .map((r) => r.gateOutcome);
    const withoutScar = rows
      .filter((r) => !activeScarFiles.has(r.filePath))
      .map((r) => r.gateOutcome);
    const scarA = armFromOutcomes(withoutScar);
    const scarB = armFromOutcomes(withScar);
    const scarConf = confidenceFor(Math.min(scarA.n, scarB.n));
    const scarDelta = scarB.passRatePct - scarA.passRatePct;

    const experiments: BenchmarkResult[] = [
      {
        name: "Lessons injected",
        description: "Attempts WITH lessons injected vs WITHOUT (per-attempt, from lessonIdsInjected).",
        confounder: "Lessons are injected by score, not randomly — high-score lessons go on files the bandit thinks they'll help, biasing the 'with' arm toward easier files.",
        armA: { ...lessonsA, n: lessonsA.n },
        armB: { ...lessonsB, n: lessonsB.n },
        deltaPct: Math.round(lessonsDelta * 10) / 10,
        confidence: lessonsConf,
        verdict: verdictFor("Lessons injection", lessonsDelta, lessonsConf),
      },
      {
        name: "Provenance digest",
        description: "Attempts BEFORE vs AFTER the provenance-injection commit (2026-11-21T03:42:12Z).",
        confounder: "Time-correlated: the panel fixes shipped in the same commit, but they don't affect mutation quality. The cleanest of the three natural experiments.",
        armA: { ...provA, n: provA.n },
        armB: { ...provB, n: provB.n },
        deltaPct: Math.round(provDelta * 10) / 10,
        confidence: provConf,
        verdict: verdictFor("Provenance digest", provDelta, provConf),
      },
      {
        name: "Active postmortem",
        description: "Attempts on files WITH an active postmortem vs WITHOUT.",
        confounder: "HEAVILY CONFOUNDED: files with scars are the ones that fail a lot — the scar is a symptom of difficulty, not a random assignment. A negative delta is EXPECTED and does NOT mean the postmortem hurts.",
        armA: { ...scarA, n: scarA.n },
        armB: { ...scarB, n: scarB.n },
        deltaPct: Math.round(scarDelta * 10) / 10,
        confidence: scarConf,
        verdict: verdictFor("Active postmortem", scarDelta, scarConf),
      },
    ];

    return {
      overall: {
        lifetime: {
          enhanced: lifetimeArm.enhanced,
          failed: lifetimeArm.failed,
          passRatePct: lifetimeArm.passRatePct,
        },
        recent: {
          enhanced: recentArm.enhanced,
          failed: recentArm.failed,
          passRatePct: recentArm.passRatePct,
          trend,
        },
        cyclesCompleted: rows.length > 0 ? Math.max(...rows.map((r) => r.createdAt.getTime())) : 0,
      },
      experiments,
      generatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
