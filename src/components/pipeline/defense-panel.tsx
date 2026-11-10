"use client";

/**
 * Defense Panel — the operator-facing surface for the three defensive
 * grafts mined from the operator's GitHub account (see
 * docs/CONCEPTS-GRAFTED.md):
 *
 *   - DURESS / SAFE-MODE (GRAFT 2, from PKM): shows the current safe-mode
 *     state + the consecutive-push-auth-failure counter, with [PURGE]
 *     (manual duress purge) and [CLEAR] (operator clears safe-mode).
 *   - RED-TEAM (GRAFT 4, from Aether_Forge aetherforge-eval): the probe
 *     catalog + the last run's verdict + per-probe results, with
 *     [RUN SUITE] (manual trigger) and [DRY RUN] (no LLM).
 *   - SECRET-SCAN (GRAFT 1, from Git-Secret-PII-Sanitizer): a paste-and-
 *     scan tool exposing the SAME scanner that runs as the pre-push gate.
 *
 * Renders as a modal overlay matching the existing terminal aesthetic
 * (black bg, monospace, DOS-themed buttons). Polls /api/duress/status
 * and /api/red-team/status every 5s while open so a purge or a red-team
 * bypass is reflected live.
 */

import { useEffect, useState } from "react";

const PROMPT_COLOR = "#e0e0e0";
const DIM_COLOR = "#777777";
const ERROR_COLOR = "#ff4444";
const WARN_COLOR = "#ffaa33";
const OK_COLOR = "#44dd88";

const btnStyle: React.CSSProperties = {
  background: "#000",
  border: `1px solid ${DIM_COLOR}`,
  color: PROMPT_COLOR,
  fontFamily: "inherit",
  fontSize: "inherit",
  padding: "4px 10px",
  cursor: "pointer",
};

interface SafeModeState {
  active: boolean;
  setBy: string | null;
  reason: string | null;
  setAt: string | null;
}

interface DuressStatus {
  ok: boolean;
  safeMode: SafeModeState;
  consecutiveAuthFailures: number;
  authFailureThreshold: number;
  runtimeFlag: boolean;
  error?: string;
}

interface ProbeMeta {
  id: string;
  name: string;
  target: "containment" | "behavioral";
  expectedBehavior: string;
  riskCategory: string;
  mitigation: string;
}

interface ProbeRunResult {
  probeId: string;
  probeName: string;
  target: "containment" | "behavioral";
  verdict: "BLOCKED" | "BYPASSED" | "ERROR" | "SKIPPED";
  outputExcerpt: string;
  refusalSignal: string | null;
  complySignal: string | null;
  latencyMs: number;
  error?: string;
}

interface RedTeamRunSummary {
  suiteVersion: string;
  startedAt: string;
  finishedAt: string;
  totalAttempts: number;
  bypassesAllowed: number;
  blockedAttempts: number;
  errored: number;
  verdict: "PASSED" | "FAILED";
  probes: ProbeRunResult[];
  safeModeRaised: boolean;
}

interface RedTeamStatus {
  ok: boolean;
  suiteVersion: string;
  probeCount: number;
  probes: ProbeMeta[];
  lastRun: RedTeamRunSummary | null;
  error?: string;
}

interface ScanFinding {
  patternId: string;
  patternName: string;
  severity: "Critical" | "High" | "Medium";
  confidence: "High" | "Medium" | "Low";
  redactedPreview: string;
  filePath: string;
  line: number;
  lineContentRedacted: string;
}

interface ScanResult {
  ok: boolean;
  findings: ScanFinding[];
  summary: {
    block: boolean;
    worst: { patternId: string; patternName: string; severity: string; filePath: string; line: number } | null;
    reason: string;
  };
  patternCount: number;
  error?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return iso;
  }
}

function verdictColor(v: string): string {
  if (v === "BLOCKED" || v === "PASSED") return OK_COLOR;
  if (v === "BYPASSED" || v === "FAILED") return ERROR_COLOR;
  if (v === "ERROR") return WARN_COLOR;
  return DIM_COLOR; // SKIPPED
}

function severityColor(s: string): string {
  if (s === "Critical") return ERROR_COLOR;
  if (s === "High") return WARN_COLOR;
  return DIM_COLOR;
}

export function DefensePanel({ open, onClose }: Props) {
  const [duress, setDuress] = useState<DuressStatus | null>(null);
  const [rtStatus, setRtStatus] = useState<RedTeamStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Secret-scan tool state
  const [scanInput, setScanInput] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    async function poll() : Promise<void> {
      try {
        const [dRes, rRes] = await Promise.all([
          fetch("/api/duress/status"),
          fetch("/api/red-team/status"),
        ]);
        if (!mounted) return;
        if (dRes.ok) setDuress((await dRes.json()) as DuressStatus);
        if (rRes.ok) setRtStatus((await rRes.json()) as RedTeamStatus);
      } catch {
        /* best-effort */
      }
    }
    void poll();
    const t = setInterval(poll, 5000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, [open]);

  if (!open) return null;

  async function doPurge() : Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/duress/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual operator trigger from defense panel" }),
      });
      const data = await res.json();
      if (data.ok) {
        const r = data.result;
        setMsg(
          `PURGE ${r.outcome}: keys=${r.keysPurged.tier2 ? "✓" : "✗"}/${r.keysPurged.tier3 ? "✓" : "✗"}/${r.keysPurged.db ? "✓" : "✗"} ` +
          `readBack=${r.readBack.allGone ? "GONE" : "STILL PRESENT"} safeMode=${r.safeModeRaised ? "RAISED" : "—"}`
        );
      } else {
        setMsg(`PURGE FAILED: ${data.error ?? "unknown"}`);
      }
    } catch (err) {
      setMsg(`PURGE ERROR: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function doClear() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/duress/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ by: "operator" }),
      });
      const data = await res.json();
      setMsg(data.ok ? "SAFE-MODE CLEARED — autonomous loop may resume." : `CLEAR FAILED: ${data.error}`);
    } catch (err) {
      setMsg(`CLEAR ERROR: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function doRunSuite(skipLlm: boolean) {
    setBusy(true);
    setMsg(skipLlm ? "Dry run (no LLM)…" : "Running red-team suite (7 probes, ~30-90s)…");
    try {
      const res = await fetch("/api/red-team/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipLlm }),
      });
      const data = await res.json();
      if (data.ok) {
        const s = data.summary as RedTeamRunSummary;
        setMsg(
          `RUN ${s.verdict}: ${s.totalAttempts} attempts, ${s.bypassesAllowed} bypasses, ${s.blockedAttempts} blocked, ${s.errored} errored` +
          (s.safeModeRaised ? " [SAFE-MODE RAISED]" : "")
        );
        // Refresh status to pick up the persisted last-run.
        try {
          const rRes = await fetch("/api/red-team/status");
          if (rRes.ok) setRtStatus((await rRes.json()) as RedTeamStatus);
        } catch { /* best-effort */ }
      } else {
        setMsg(`RUN FAILED: ${data.error ?? "unknown"}`);
      }
    } catch (err) {
      setMsg(`RUN ERROR: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function doScan() {
    if (!scanInput.trim()) {
      setMsg("Paste some content to scan first.");
      return;
    }
    setScanning(true);
    setScanResult(null);
    try {
      const res = await fetch("/api/secret-scan/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: scanInput, filePath: "paste.txt", blockOnMedium: false }),
      });
      const data = (await res.json()) as ScanResult;
      if (data.ok) {
        setScanResult(data);
      } else {
        setMsg(`SCAN FAILED: ${data.error ?? "unknown"}`);
      }
    } catch (err) {
      setMsg(`SCAN ERROR: ${(err as Error).message}`);
    } finally {
      setScanning(false);
    }
  }

  const safeModeActive = duress?.safeMode?.active ?? duress?.runtimeFlag ?? false;
  const lastRun = rtStatus?.lastRun ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Defense panel — duress, red-team, secret-scan"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#000",
          border: `1px solid ${DIM_COLOR}`,
          maxWidth: "900px",
          width: "100%",
          maxHeight: "88vh",
          overflowY: "auto",
          padding: "16px 18px",
          fontFamily: "inherit",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <strong style={{ color: PROMPT_COLOR, fontSize: "1.05em" }}>
            DEFENSE — duress · red-team · secret-scan
          </strong>
          <button type="button" onClick={onClose} style={btnStyle} aria-label="Close defense panel">
            [CLOSE]
          </button>
        </div>

        {msg && (
          <div
            style={{
              border: `1px solid ${DIM_COLOR}`,
              padding: "6px 10px",
              marginBottom: "10px",
              color: msg.startsWith("PURGE FAILED") || msg.startsWith("RUN FAILED") || msg.includes("ERROR")
                ? ERROR_COLOR
                : msg.includes("SAFE-MODE") || msg.includes("BYPASS") || msg.includes("STILL PRESENT")
                  ? WARN_COLOR
                  : OK_COLOR,
              fontSize: "0.92em",
            }}
          >
            {msg}
          </div>
        )}

        {/* ── DURESS / SAFE-MODE ────────────────────────────────────── */}
        <section style={{ marginBottom: "16px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "6px", borderBottom: `1px solid ${DIM_COLOR}`, paddingBottom: "2px" }}>
            DURESS / SAFE-MODE — concept: PKM §3 phased purge + load-bearing read-back
          </div>
          <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", marginBottom: "8px" }}>
            <span style={{ color: safeModeActive ? ERROR_COLOR : OK_COLOR, fontWeight: "bold" }}>
              {safeModeActive ? "■ SAFE-MODE ACTIVE" : "□ safe-mode off"}
            </span>
            {duress?.safeMode?.setBy && (
              <span style={{ color: DIM_COLOR }}>
                raised by <strong style={{ color: WARN_COLOR }}>{duress.safeMode.setBy}</strong> at {fmt(duress.safeMode.setAt)}
              </span>
            )}
            <span style={{ color: DIM_COLOR }}>
              auth failures: {duress?.consecutiveAuthFailures ?? 0}/{duress?.authFailureThreshold ?? 5}
            </span>
          </div>
          {duress?.safeMode?.reason && (
            <div style={{ color: WARN_COLOR, fontSize: "0.9em", marginBottom: "8px", paddingLeft: "10px", borderLeft: `2px solid ${WARN_COLOR}` }}>
              {duress.safeMode.reason}
            </div>
          )}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button type="button" onClick={doPurge} disabled={busy} style={{ ...btnStyle, color: ERROR_COLOR, opacity: busy ? 0.5 : 1 }}>
              [PURGE PAT]
            </button>
            <button type="button" onClick={doClear} disabled={busy || !safeModeActive} style={{ ...btnStyle, color: OK_COLOR, opacity: busy || !safeModeActive ? 0.5 : 1 }}>
              [CLEAR SAFE-MODE]
            </button>
          </div>
        </section>

        {/* ── RED-TEAM ─────────────────────────────────────────────── */}
        <section style={{ marginBottom: "16px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "6px", borderBottom: `1px solid ${DIM_COLOR}`, paddingBottom: "2px" }}>
            RED-TEAM — concept: Aether_Forge aetherforge-eval (suite v{rtStatus?.suiteVersion ?? "—"}, {rtStatus?.probeCount ?? 0} probes)
          </div>
          {lastRun ? (
            <div style={{ marginBottom: "8px" }}>
              <span style={{ color: verdictColor(lastRun.verdict), fontWeight: "bold" }}>
                LAST RUN: {lastRun.verdict}
              </span>
              <span style={{ color: DIM_COLOR, marginLeft: "10px" }}>
                {lastRun.totalAttempts} attempts · {lastRun.bypassesAllowed} bypasses · {lastRun.blockedAttempts} blocked · {lastRun.errored} errored · {fmt(lastRun.finishedAt)}
              </span>
              {lastRun.safeModeRaised && (
                <span style={{ color: ERROR_COLOR, marginLeft: "10px", fontWeight: "bold" }}>
                  [SAFE-MODE RAISED]
                </span>
              )}
              <div style={{ marginTop: "6px", maxHeight: "180px", overflowY: "auto", border: `1px solid ${DIM_COLOR}`, padding: "6px" }}>
                {lastRun.probes.map((p) => (
                  <div key={p.probeId} style={{ marginBottom: "4px", fontSize: "0.88em" }}>
                    <span style={{ color: verdictColor(p.verdict), fontWeight: "bold" }}>{p.verdict.padEnd(8)}</span>
                    <span style={{ color: PROMPT_COLOR }}> {p.probeName}</span>
                    <span style={{ color: DIM_COLOR }}> ({p.target}, {p.latencyMs}ms)</span>
                    {p.refusalSignal && <span style={{ color: OK_COLOR }}> · refused: "{p.refusalSignal}"</span>}
                    {p.complySignal && <span style={{ color: ERROR_COLOR }}> · BYPASS: {p.complySignal}</span>}
                    {p.error && <span style={{ color: ERROR_COLOR }}> · err: {p.error.slice(0, 80)}</span>}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ color: DIM_COLOR, marginBottom: "8px", fontSize: "0.9em" }}>
              No red-team run recorded yet. Run the suite to test the LLM enhancement path against {rtStatus?.probeCount ?? 0} adversarial probes.
            </div>
          )}
          <details style={{ marginBottom: "8px" }}>
            <summary style={{ color: DIM_COLOR, cursor: "pointer", fontSize: "0.9em" }}>
              Probe catalog ({rtStatus?.probeCount ?? 0})
            </summary>
            <div style={{ marginTop: "6px", maxHeight: "200px", overflowY: "auto", border: `1px solid ${DIM_COLOR}`, padding: "6px" }}>
              {rtStatus?.probes.map((p) => (
                <div key={p.id} style={{ marginBottom: "6px", fontSize: "0.88em" }}>
                  <span style={{ color: PROMPT_COLOR, fontWeight: "bold" }}>{p.name}</span>
                  <span style={{ color: DIM_COLOR }}> [{p.target}/{p.riskCategory}]</span>
                  <div style={{ color: DIM_COLOR, paddingLeft: "10px" }}>expect: {p.expectedBehavior}</div>
                  <div style={{ color: DIM_COLOR, paddingLeft: "10px" }}>mitigation: {p.mitigation}</div>
                </div>
              ))}
            </div>
          </details>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button type="button" onClick={() => doRunSuite(false)} disabled={busy} style={{ ...btnStyle, color: WARN_COLOR, opacity: busy ? 0.5 : 1 }}>
              [RUN SUITE]
            </button>
            <button type="button" onClick={() => doRunSuite(true)} disabled={busy} style={{ ...btnStyle, opacity: busy ? 0.5 : 1 }}>
              [DRY RUN]
            </button>
          </div>
        </section>

        {/* ── SECRET-SCAN ──────────────────────────────────────────── */}
        <section>
          <div style={{ color: DIM_COLOR, marginBottom: "6px", borderBottom: `1px solid ${DIM_COLOR}`, paddingBottom: "2px" }}>
            SECRET-SCAN — concept: Git-Secret-PII-Sanitizer ({scanResult?.patternCount ?? 12} patterns). Same scanner as the pre-push gate.
          </div>
          <textarea
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            placeholder="Paste content to scan (a file, a diff, a commit message)…"
            aria-label="Content to scan for secrets"
            style={{
              width: "100%",
              minHeight: "80px",
              background: "#0a0a0a",
              border: `1px solid ${DIM_COLOR}`,
              color: PROMPT_COLOR,
              fontFamily: "inherit",
              fontSize: "0.9em",
              padding: "6px",
              resize: "vertical",
              marginBottom: "6px",
            }}
          />
          <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
            <button type="button" onClick={doScan} disabled={scanning} style={{ ...btnStyle, color: PROMPT_COLOR, opacity: scanning ? 0.5 : 1 }}>
              [SCAN]
            </button>
            <button type="button" onClick={() => { setScanInput(""); setScanResult(null); }} style={btnStyle}>
              [CLEAR]
            </button>
          </div>
          {scanResult && (
            <div>
              {scanResult.summary.block ? (
                <div style={{ color: ERROR_COLOR, fontWeight: "bold", marginBottom: "6px" }}>
                  ■ BLOCK: {scanResult.summary.reason}
                </div>
              ) : scanResult.findings.length > 0 ? (
                <div style={{ color: WARN_COLOR, marginBottom: "6px" }}>
                  □ WARN: {scanResult.findings.length} low-confidence finding(s) (would not block a push).
                </div>
              ) : (
                <div style={{ color: OK_COLOR, marginBottom: "6px" }}>
                  ✓ CLEAN: no secrets detected.
                </div>
              )}
              {scanResult.findings.length > 0 && (
                <div style={{ maxHeight: "200px", overflowY: "auto", border: `1px solid ${DIM_COLOR}`, padding: "6px" }}>
                  {scanResult.findings.map((f, i) => (
                    <div key={i} style={{ marginBottom: "4px", fontSize: "0.88em" }}>
                      <span style={{ color: severityColor(f.severity), fontWeight: "bold" }}>{f.severity}</span>
                      <span style={{ color: PROMPT_COLOR }}> {f.patternName}</span>
                      <span style={{ color: DIM_COLOR }}> in {f.filePath}:{f.line}</span>
                      <div style={{ color: DIM_COLOR, paddingLeft: "10px" }}>
                        preview: <code style={{ color: WARN_COLOR }}>{f.redactedPreview}</code>
                      </div>
                      <div style={{ color: DIM_COLOR, paddingLeft: "10px" }}>
                        line: <code>{f.lineContentRedacted}</code>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
