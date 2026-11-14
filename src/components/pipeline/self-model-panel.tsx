"use client";

/**
 * Self-Model Panel — the user-facing surface for the loop's measured
 * self-knowledge (audit 7, the cognitive core).
 *
 * Shows the three surfaces wired in audit 7:
 *   1. CALIBRATION VERDICT — Brier score + plain-language self-assessment
 *      ("well-calibrated" / "OVERCONFIDENT" / "UNDERCONFIDENT"). Built from
 *      resolved self-predictions.
 *   2. CALIBRATION CURVE — 10 confidence buckets, predicted vs actual pass
 *      rate. The closer the bars match, the better the loop knows itself.
 *   3. PER-FILE SELF-KNOWLEDGE — every file's pass/fail/zero-diff counts,
 *      finished-score, last outcome. Sorted by attempts (most-examined first).
 *
 * Polls /api/self-model every 8s while open. Polling stops on close.
 *
 * Style: matches the terminal aesthetic (black bg, monospace, DOS buttons)
 * used by the other pipeline panels.
 */

import { useEffect, useState } from "react";

const PROMPT_COLOR = "#e0e0e0";
const DIM_COLOR = "#777777";
const ACCENT_COLOR = "#88cc88";
const WARN_COLOR = "#ffaa33";
const ERROR_COLOR = "#ff4444";
const GOOD_COLOR = "#66ddaa";

const btnStyle: React.CSSProperties = {
  background: "#000",
  border: `1px solid ${DIM_COLOR}`,
  color: PROMPT_COLOR,
  fontFamily: "inherit",
  fontSize: "inherit",
  padding: "4px 10px",
  cursor: "pointer",
};

interface FileRow {
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
  /** Consecutive successful mutations — rises +1 per pass, resets to 0
   *  on any fail or zero-diff. Older payloads may omit it. */
  streak?: number;
  /** The momentum selection bonus as a percentage (0-15): +5% per
   *  streak step, capped at +15%. Older payloads may omit it. */
  momentumPct?: number;
}

interface CalibrationBucket {
  bucket: string;
  n: number;
  predicted: number;
  actual: number;
  gap: number;
}

interface SelfModelStatus {
  files: FileRow[];
  calibration: {
    buckets: CalibrationBucket[];
    resolvedPredictions: number;
    pendingPredictions: number;
    brierScore: number | null;
    reliability: number | null;
    verdict: string;
    /** Self-correcting confidence — the measured bias currently being
     *  applied to predictions (see self-model.ts getConfidenceCorrection). */
    correction?: {
      active: boolean;
      shift: number;
      n: number;
      meanConfidence: number;
      meanActual: number;
      reason: string;
      /** Audit 8: per-decile corrections — the loop's bias is directional
       *  by range (underconfident low, overconfident mid), so the single
       *  scalar headline hides the real picture. Older payloads omit it. */
      buckets?: Array<{
        lo: number;
        hi: number;
        n: number;
        meanPredicted: number;
        meanActual: number;
        shift: number;
      }>;
    };
  };
  modeStats: {
    refactor: { attempts: number; passes: number };
    visualPolish: { attempts: number; passes: number };
  };
  totals: { attempts: number; passes: number; failss: number; zeroDiffs: number };
  skipProbes?: {
    probes: number;
    zeroDiffs: number;
    fails: number;
    passes: number;
    savedRate: number | null;
    missedRate: number | null;
    verdict: string;
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SelfModelPanel({ open, onClose }: Props) {
  const [status, setStatus] = useState<SelfModelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;

    async function poll() {
      try {
        const res = await fetch("/api/self-model");
        if (!res.ok) {
          if (active) setError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as SelfModelStatus;
        if (active) {
          setStatus(data);
          setError(null);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }

    poll();
    const timer = setInterval(poll, 8000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);

  async function rebootstrap() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/self-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as SelfModelStatus;
      setStatus(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const cal = status?.calibration;
  const totals = status?.totals;
  const sp = status?.skipProbes;
  // Skip-rule verdict color: green while probes confirm the skipper saves
  // no-growth calls, warn/error once probes show it skipping live files.
  const skipVerdictColor =
    !sp || sp.probes === 0
      ? DIM_COLOR
      : (sp.missedRate ?? 0) > 0.25
        ? ERROR_COLOR
        : (sp.missedRate ?? 0) > 0.1
          ? WARN_COLOR
          : GOOD_COLOR;

  // Calibration verdict color
  const verdictText = cal?.verdict ?? "loading…";
  const verdictColor = cal?.brierScore === null
    ? DIM_COLOR
    : (cal?.brierScore ?? 1) <= 0.1
      ? GOOD_COLOR
      : (cal?.brierScore ?? 1) <= 0.25
        ? ACCENT_COLOR
        : WARN_COLOR;

  return (
    <div
      role="dialog"
      aria-label="Self-model panel — the loop's measured self-knowledge"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#000",
          border: `1px solid ${DIM_COLOR}`,
          color: PROMPT_COLOR,
          fontFamily: "'Courier New', 'Lucida Console', monospace",
          fontSize: "13px",
          lineHeight: 1.4,
          padding: "16px",
          maxWidth: "900px",
          width: "calc(100% - 32px)",
          maxHeight: "calc(100vh - 64px)",
          overflowY: "auto",
        }}
      >
        {/* Header */}
        <div
          style={{
            borderBottom: `1px solid ${DIM_COLOR}`,
            paddingBottom: "8px",
            marginBottom: "12px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <span style={{ color: PROMPT_COLOR, fontWeight: "bold" }}>🧠 SELF-MODEL</span>
            <span style={{ color: DIM_COLOR, marginLeft: "8px" }}>
              — the loop&apos;s measured self-knowledge (audit 7)
            </span>
          </div>
          <button type="button" onClick={onClose} style={btnStyle} aria-label="Close self-model panel">
            [ESC]
          </button>
        </div>

        {error && (
          <div style={{ color: ERROR_COLOR, marginBottom: "8px" }}>error: {error}</div>
        )}

        {/* Verdict */}
        <div style={{ marginBottom: "16px", padding: "8px", border: `1px solid ${DIM_COLOR}` }}>
          <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>CALIBRATION VERDICT</div>
          <div style={{ color: verdictColor, fontWeight: "bold" }}>
            {verdictText}
          </div>
          <div style={{ color: DIM_COLOR, marginTop: "4px", fontSize: "11px" }}>
            brier: {cal?.brierScore ?? "—"} · reliability: {cal?.reliability ?? "—"} ·
            resolved: {cal?.resolvedPredictions ?? 0} · pending: {cal?.pendingPredictions ?? 0}
          </div>
          {/* Self-correcting confidence — the loop acting on its own measured
              miscalibration, not just reporting it. Accent color when active.
              Audit 8: per-decile ranges — the aggregate scalar stayed dormant
              because low-range underconfidence canceled mid-range
              overconfidence; the ranges show WHERE the bias lives. */}
          <div
            style={{
              color: cal?.correction?.active ? ACCENT_COLOR : DIM_COLOR,
              marginTop: "4px",
              fontSize: "11px",
            }}
          >
            self-correction: {cal?.correction?.reason ?? "—"}
          </div>
          {cal?.correction?.active && (cal.correction.buckets?.length ?? 0) > 0 && (
            <div style={{ marginTop: "4px" }}>
              {cal.correction.buckets!.map((b) => {
                // Range color: over-confident (negative shift) warns — the
                // loop regretted trusting this range; under-confident
                // (positive) accent — the loop undersold itself here.
                const bColor = b.shift < 0 ? WARN_COLOR : ACCENT_COLOR;
                return (
                  <div key={`${b.lo}`} style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "2px" }}>
                    <span style={{ color: DIM_COLOR, width: "56px", fontSize: "10px" }}>
                      {(b.lo * 100).toFixed(0)}-{(b.hi * 100).toFixed(0)}%
                    </span>
                    <div
                      style={{
                        background: bColor,
                        height: "8px",
                        width: `${Math.min(60, Math.round(Math.abs(b.shift) * 200))}px`,
                      }}
                    />
                    <span style={{ color: bColor, fontSize: "10px" }}>
                      {`predict ${(b.meanPredicted * 100).toFixed(0)}% → actual ${(b.meanActual * 100).toFixed(0)}% · shift ${b.shift >= 0 ? "+" : ""}${b.shift.toFixed(2)} (n=${b.n})`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Calibration curve */}
        <div style={{ marginBottom: "16px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "6px" }}>
            CALIBRATION CURVE — predicted vs actual pass rate per confidence bucket
          </div>
          {cal && cal.buckets.filter((b) => b.n > 0).length > 0 ? (
            <div>
              {cal.buckets.filter((b) => b.n > 0).map((b) => {
                const maxBar = 200;
                const predW = Math.round(b.predicted * maxBar);
                const actW = Math.round(b.actual * maxBar);
                const gapColor = b.gap < 0.05 ? GOOD_COLOR : b.gap < 0.15 ? ACCENT_COLOR : WARN_COLOR;
                return (
                  <div key={b.bucket} style={{ marginBottom: "4px" }}>
                    <div style={{ color: DIM_COLOR, fontSize: "11px" }}>
                      {b.bucket} (n={b.n}) gap={b.gap}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "2px" }}>
                      <span style={{ color: DIM_COLOR, width: "48px", fontSize: "10px" }}>pred</span>
                      <div style={{ background: ACCENT_COLOR, height: "8px", width: `${predW}px` }} />
                      <span style={{ color: ACCENT_COLOR, fontSize: "10px" }}>{(b.predicted * 100).toFixed(0)}%</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ color: DIM_COLOR, width: "48px", fontSize: "10px" }}>actual</span>
                      <div style={{ background: gapColor, height: "8px", width: `${actW}px` }} />
                      <span style={{ color: gapColor, fontSize: "10px" }}>{(b.actual * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ color: DIM_COLOR }}>
              no populated buckets yet — resolved predictions: {cal?.resolvedPredictions ?? 0} (need ≥20 for a first read)
            </div>
          )}
        </div>

        {/* Skip-rule scoring — the predictor that drives skip decisions.
            The calibration curve above scores the PASS predictor on files
            the loop attempted; this section scores the SKIP rule on files
            it would have skipped — measured via probes (every 4th skip
            spends the call anyway so the claim can be checked). */}
        <div style={{ marginBottom: "16px", padding: "8px", border: `1px solid ${DIM_COLOR}` }}>
          <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>
            SKIP-RULE SCORING — probes of the proactive-skip predictor (the decision that saves quota)
          </div>
          <div style={{ color: skipVerdictColor, fontWeight: "bold" }}>
            {sp?.verdict ?? "no skip-probe data yet"}
          </div>
          <div style={{ color: DIM_COLOR, marginTop: "4px", fontSize: "11px" }}>
            probes: {sp?.probes ?? 0} · zero-diffed: {sp?.zeroDiffs ?? 0} · failed (no growth): {sp?.fails ?? 0} · passed (missed enhancement): {sp?.passes ?? 0} ·
            saved: {sp?.savedRate === null || sp?.savedRate === undefined ? "—" : `${(sp.savedRate * 100).toFixed(0)}%`} ·
            missed: {sp?.missedRate === null || sp?.missedRate === undefined ? "—" : `${(sp.missedRate * 100).toFixed(0)}%`}
          </div>
        </div>

        {/* Mode stats + totals */}
        <div style={{ marginBottom: "16px", display: "flex", gap: "24px", flexWrap: "wrap" }}>
          <div>
            <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>MODE STATS</div>
            <div style={{ color: PROMPT_COLOR }}>
              refactor: {status?.modeStats.refactor.passes ?? 0}/{status?.modeStats.refactor.attempts ?? 0} passed
            </div>
            <div style={{ color: PROMPT_COLOR }}>
              visual-polish: {status?.modeStats.visualPolish.passes ?? 0}/{status?.modeStats.visualPolish.attempts ?? 0} passed
            </div>
          </div>
          <div>
            <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>TOTALS</div>
            <div style={{ color: PROMPT_COLOR }}>
              attempts: {totals?.attempts ?? 0} · passes: {totals?.passes ?? 0}
            </div>
            <div style={{ color: PROMPT_COLOR }}>
              fails: {totals?.failss ?? 0} · zero-diffs: {totals?.zeroDiffs ?? 0}
            </div>
          </div>
        </div>

        {/* Per-file knowledge */}
        <div style={{ marginBottom: "16px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "6px" }}>
            PER-FILE SELF-KNOWLEDGE — what the bandit knows (sorted by attempts)
          </div>
          {status && status.files.length > 0 ? (
            <div style={{ maxHeight: "300px", overflowY: "auto", border: `1px solid ${DIM_COLOR}` }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${DIM_COLOR}`, color: DIM_COLOR, textAlign: "left" }}>
                    <th style={{ padding: "4px 6px" }}>file</th>
                    <th style={{ padding: "4px 6px" }}>pass/attempts</th>
                    <th style={{ padding: "4px 6px" }}>zero-diff</th>
                    <th style={{ padding: "4px 6px" }}>finished</th>
                    <th
                      style={{ padding: "4px 6px" }}
                      title="Momentum — mutability percentage that rises with each successful mutation (+5% per consecutive pass, capped +15% at 3 in a row; any fail or zero-diff resets it to 0%)"
                    >
                      momentum
                    </th>
                    <th style={{ padding: "4px 6px" }}>last</th>
                  </tr>
                </thead>
                <tbody>
                  {status.files.map((f) => {
                    const finishedColor = f.finishedScore >= 0.7 ? WARN_COLOR : f.finishedScore >= 0.4 ? ACCENT_COLOR : DIM_COLOR;
                    const lastColor = f.lastOutcome === "pass" ? GOOD_COLOR : f.lastOutcome === "fail" ? ERROR_COLOR : f.lastOutcome === "zero-diff" ? DIM_COLOR : PROMPT_COLOR;
                    const momentumPct = f.momentumPct ?? 0;
                    const streak = f.streak ?? 0;
                    // Momentum color: cold (0%) = dim, warming (+5/+10%) =
                    // accent, maxed (+15%) = good — the file is hot and
                    // the bandit is favoring it at the cap.
                    const momentumColor =
                      momentumPct <= 0 ? DIM_COLOR : momentumPct >= 15 ? GOOD_COLOR : ACCENT_COLOR;
                    return (
                      <tr key={f.filePath} style={{ borderBottom: `1px solid #222` }}>
                        <td style={{ padding: "3px 6px", color: PROMPT_COLOR }}>{f.filePath}</td>
                        <td style={{ padding: "3px 6px", color: PROMPT_COLOR }}>{f.passes}/{f.attempts}</td>
                        <td style={{ padding: "3px 6px", color: DIM_COLOR }}>{f.zeroDiffs}</td>
                        <td style={{ padding: "3px 6px", color: finishedColor }}>{f.finishedScore.toFixed(2)}</td>
                        <td
                          style={{ padding: "3px 6px", color: momentumColor }}
                          title={`streak ${streak} — consecutive successful mutations (resets on fail/zero-diff)`}
                        >
                          {momentumPct > 0 ? `+${momentumPct}%` : "0%"}
                          {streak > 0 ? ` (${streak})` : ""}
                        </td>
                        <td style={{ padding: "3px 6px", color: lastColor }}>{f.lastOutcome ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ color: DIM_COLOR }}>no per-file data yet — self-model bootstraps from the mutation corpus on first cycle</div>
          )}
        </div>

        {/* Re-bootstrap button */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={rebootstrap}
            disabled={loading}
            style={{ ...btnStyle, opacity: loading ? 0.5 : 1 }}
          >
            {loading ? "…" : "[RE-BOOTSTRAP]"}
          </button>
          <span style={{ color: DIM_COLOR, fontSize: "11px" }}>
            re-aggregates the mutation corpus into per-file self-model rows (idempotent; the bandit uses these)
          </span>
        </div>
      </div>
    </div>
  );
}
