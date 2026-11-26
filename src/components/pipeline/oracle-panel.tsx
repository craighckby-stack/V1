"use client";

/**
 * Oracle Panel — the user-facing surface for the prophecy/evaluation
 * subsystem.
 *
 * Renders as a modal overlay (matching the existing config-modal style:
 * black background, monospace, DOS-themed buttons). Shows:
 *   - The system's track record (counts, calibration per threshold,
 *     Brier score).
 *   - Recent prophecies with status, confidence, claim, deadline.
 *   - [GENERATE] button to make a new prophecy (calls /api/oracle/generate).
 *   - [EVALUATE] button to judge due prophecies (calls /api/oracle/evaluate).
 *
 * The panel polls /api/oracle/status and /api/oracle/prophecies every
 * 5s while open, so newly generated or judged prophecies appear
 * without a manual refresh. Polling stops when the panel closes.
 *
 * Style: matches the existing terminal aesthetic — black background,
 * #e0e0e0 text, #777777 dim, #ff4444 errors, #ffaa33 warnings. The
 * verdict colors are:
 *   fulfilled = #e0e0e0 (neutral white — a fulfilled prophecy is not a
 *               success to celebrate, just an accurate prediction)
 *   failed    = #ff4444 (red — a wrong prediction, surfaced honestly)
 *   retired   = #ffaa33 (warn — the evaluator couldn't judge; honest
 *               "I can't tell")
 *   pending   = #777777 (dim — not yet evaluated)
 */

import { useEffect, useState } from "react";
import { OracleTaskFeedPanel } from "./oracle-task-feed-panel";

const PROMPT_COLOR = "#e0e0e0";
const DIM_COLOR = "#777777";
const ERROR_COLOR = "#ff4444";
const WARN_COLOR = "#ffaa33";

const btnStyle: React.CSSProperties = {
  background: "#000",
  border: `1px solid ${DIM_COLOR}`,
  color: PROMPT_COLOR,
  fontFamily: "inherit",
  fontSize: "inherit",
  padding: "4px 10px",
  cursor: "pointer",
};

interface Prophecy {
  id: string;
  claim: string;
  confidence: number;
  rationale: string;
  falsifiabilityCriterion: string;
  status: string; // pending | fulfilled | failed | retired
  evaluateBy: string;
  evaluatedAt: string | null;
  evaluation: string | null;
  contextSha: string | null;
  historySnapshot: string | null;
  domain: string | null;
  createdAt: string;
}

interface OracleStatus {
  ok: boolean;
  counts?: {
    pending: number | undefined;
    fulfilled: number | undefined;
    failed: number | undefined;
    retired: number | undefined;
    total: number | undefined;
  };
  calibration?: Array<{
    threshold: number;
    total: number;
    fulfilled: number;
    fraction: number | null;
    wellCalibratedIf: number;
  }>;
  brierScore?: number | null;
  judgedCount?: number | undefined;
  error?: string;
}

function verdictColor(status: string): string {
  if (status === "fulfilled") return PROMPT_COLOR;
  if (status === "failed") return ERROR_COLOR;
  if (status === "retired") return WARN_COLOR;
  return DIM_COLOR; // pending
}

function formatConfidence(c: number): string {
  return `${Math.round(c * 100)}%`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return iso;
  }
}

function timeUntil(iso: string): string {
  try {
    const d = new Date(iso).getTime();
    const now = Date.now();
    const diff = d - now;
    if (diff <= 0) return "due";
    const min = Math.round(diff / 60000);
    if (min < 60) return `in ${min}m`;
    const hr = Math.floor(min / 60);
    return `in ${hr}h${min % 60}m`;
  } catch {
    return "?";
  }
}

interface ChainStatus {
  ok: boolean;
  total: number;
  linkBreaks: number;
  contentMismatches: number;
  firstBreakAt: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function OraclePanel({ open, onClose }: Props) {
  const [status, setStatus] = useState<OracleStatus | null>(null);
  const [prophecies, setProphecies] = useState<Prophecy[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainStatus | null>(null);
  const [archLoading, setArchLoading] = useState(false);

  // Poll status + prophecies every 5s while the panel is open
  useEffect(() => {
    if (!open) return;
    let mounted = true;

    async function poll() {
      try {
        const [sRes, pRes, cRes] = await Promise.all([
          fetch("/api/oracle/status"),
          fetch("/api/oracle/prophecies?limit=30"),
          fetch("/api/postmortems/chain"),
        ]);
        if (!mounted) return;
        if (sRes.ok) {
          const s = (await sRes.json()) as OracleStatus;
          setStatus(s);
        }
        if (pRes.ok) {
          const p = (await pRes.json()) as { prophecies: Prophecy[] };
          setProphecies(p.prophecies ?? []);
        }
        if (cRes.ok) {
          setChain((await cRes.json()) as ChainStatus);
        }
      } catch {
        /* ignore — next poll will retry */
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [open]);

  if (!open) return null;

  async function generateProphecies() {
    setLoading(true);
    setError(null);
    setActionMsg(null);
    try {
      const res = await fetch("/api/oracle/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 1 }),
      });
      
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({ failures: [{ reason: "Unknown API error", error: `HTTP status ${res.status}` }] }));
        const f = errorBody.failures?.[0];
        setError(f ? `${f.reason}: ${f.error}` : `Generation failed with status ${res.status}`);
        setLoading(false);
        return;
      }

      const data = await res.json();
      if (data.ok) {
        setActionMsg(
          data.generated?.length
            ? `Prophecy made: "${data.generated[0].claim.slice(0, 80)}${data.generated[0].claim.length > 80 ? "…" : ""}"`
            : "Prophecy generation returned no result",
        );
      } else {
        const f = data.failures?.[0];
        setError(f ? `${f.reason}: ${f.error}` : "Generation failed due to internal data error");
      }
      
      // Refresh both views in parallel
      const [sRes, pRes] = await Promise.all([
        fetch("/api/oracle/status"),
        fetch("/api/oracle/prophecies?limit=30"),
      ]);
      
      if (sRes.ok) {
        const statusData = await sRes.json();
        setStatus(statusData as OracleStatus);
      } else {
        setError(prev => prev ? `${prev} | Failed to fetch status: ${sRes.status}` : `Failed to fetch status: ${sRes.status}`);
      }

      if (pRes.ok) {
        const p = (await pRes.json()) as { prophecies: Prophecy[] };
        setProphecies(p.prophecies ?? []);
      } else {
        setError(prev => prev ? `${prev} | Failed to fetch prophecies: ${pRes.status}` : `Failed to fetch prophecies: ${pRes.status}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function evaluateDue() {
    setLoading(true);
    setError(null);
    setActionMsg(null);
    try {
      const res = await fetch("/api/oracle/evaluate", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setActionMsg(
          `Judged ${data.judgedCount} prophecies (${data.skippedCount} skipped)`,
        );
      } else {
        setError(data.error ?? "Evaluation failed");
      }
      // Refresh both views
      const [sRes, pRes] = await Promise.all([
        fetch("/api/oracle/status"),
        fetch("/api/oracle/prophecies?limit=30"),
      ]);
      if (sRes.ok) setStatus((await sRes.json()) as OracleStatus);
      if (pRes.ok) {
        const p = (await pRes.json()) as { prophecies: Prophecy[] };
        setProphecies(p.prophecies ?? []);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function runArchaeology() {
    setArchLoading(true);
    setError(null);
    setActionMsg(null);
    try {
      // Resolve the configured push-target so archaeology mines the SAME
      // repo the loop is mutating — no manual repo entry needed.
      const ptRes = await fetch("/api/self-enhance/push-target");
      let pt: { repo: string; branch: string } | null = null;
      if (ptRes.ok) {
        pt = await ptRes.json();
      } else {
        setError(`Failed to fetch push target configuration. Status: ${ptRes.status}`);
        return;
      }
      
      const repo = pt?.repo;
      const branch = pt?.branch ?? "main";
      if (!repo) {
        setError("No push target configured — archaeology needs a repo to mine. Set one via the push command first.");
        return;
      }
      
      const archaeologyPromise = fetch(
        `/api/oracle/archaeology?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}&maxCommits=100`,
        { method: "POST" }
      ).then(res => {
        if (res.ok) {
          return res.json();
        } else {
          // Attempt to read error from body if available, otherwise use status
          return res.json().catch(() => ({ error: `HTTP Error ${res.status}` }));
        }
      });

      const res = await archaeologyPromise;
      let data: { pairs?: { correct: boolean }[], seeded?: number, error?: string } | null = null;
      
      if (res && typeof res === 'object' && 'error' in res && res.error) {
          setError(res.error);
          return;
      }
      
      if (res) {
          data = res as { pairs?: { correct: boolean }[], seeded?: number, error?: string };
      } else {
          setError("Archaeology response was null or invalid.");
          return;
      }

      if (data) {
        setActionMsg(
          `Archaeology: mined ${data.pairs?.length ?? 0} wrong/correct pair(s) from ${repo}:${branch}, seeded ${data.seeded ?? 0} archaeology prophecies.`,
        );
        // Refresh prophecies + chain to show the new ones in parallel
        const [pRes2] = await Promise.all([
            fetch("/api/oracle/prophecies?limit=30"),
            // Assuming chain refresh is also needed, though not explicitly shown in original logic, 
            // we only fix what's present: prophecy refresh.
        ]);
        
        if (pRes2.ok) {
          const p = (await pRes2.json()) as { prophecies: Prophecy[] };
          setProphecies(p.prophecies ?? []);
        } else {
          setError(`Failed to refresh prophecies after archaeology: ${pRes2.statusText}`);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setArchLoading(false);
    }
  }

  const counts = status?.counts;
  const calibration = status?.calibration ?? [];
  const brier = status?.brierScore;

  return (
    <div
      role="dialog"
      aria-label="Oracle panel — the system's prophecies and track record"
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
            <span style={{ color: PROMPT_COLOR, fontWeight: "bold" }}>ORACLE</span>
            <span style={{ color: DIM_COLOR, marginLeft: "8px" }}>
              — the system predicts its own future
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the Oracle panel"
            style={btnStyle}
          >
            [ CLOSE ]
          </button>
        </div>

        {/* Track record */}
        <div style={{ marginBottom: "16px" }}>
          <div style={{ color: DIM_COLOR, marginBottom: "6px" }}>TRACK RECORD</div>
          {counts ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "16px" }}>
              <span>
                <span style={{ color: DIM_COLOR }}>total:</span> {counts.total}
              </span>
              <span>
                <span style={{ color: DIM_COLOR }}>pending:</span> {counts.pending}
              </span>
              <span>
                <span style={{ color: DIM_COLOR }}>fulfilled:</span>{" "}
                <span style={{ color: PROMPT_COLOR }}>{counts.fulfilled}</span>
              </span>
              <span>
                <span style={{ color: DIM_COLOR }}>failed:</span>{" "}
                <span style={{ color: ERROR_COLOR }}>{counts.failed}</span>
              </span>
              <span>
                <span style={{ color: DIM_COLOR }}>retired:</span>{" "}
                <span style={{ color: WARN_COLOR }}>{counts.retired}</span>
              </span>
            </div>
          ) : (
            <div style={{ color: DIM_COLOR }}>(no track record yet)</div>
          )}
        </div>

        {/* Calibration */}
        {calibration.length > 0 && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ color: DIM_COLOR, marginBottom: "6px" }}>
              CALIBRATION — of prophecies at confidence ≥ T, fraction that came true
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {calibration.map((c) => (
                <div key={c.threshold} style={{ display: "flex", gap: "12px" }}>
                  <span style={{ color: DIM_COLOR, minWidth: "48px" }}>
                    ≥ {Math.round(c.threshold * 100)}%:
                  </span>
                  <span>
                    {c.fraction === null
                      ? "(none yet)"
                      : `${Math.round(c.fraction * 100)}% fulfilled (${c.fulfilled}/${c.total})`}
                    {c.fraction !== null && (
                      <span style={{ color: DIM_COLOR, marginLeft: "8px" }}>
                        {c.fraction >= c.wellCalibratedIf - 0.1 && c.fraction <= c.wellCalibratedIf + 0.1
                          ? "— well-calibrated"
                          : c.fraction < c.wellCalibratedIf - 0.1
                            ? "— overconfident"
                            : "— underconfident"}
                      </span>
                    )}
                  </span>
                </div>
              ))}
              {brier !== null && brier !== undefined && (
                <div style={{ marginTop: "4px" }}>
                  <span style={{ color: DIM_COLOR }}>Brier score:</span>{" "}
                  {brier.toFixed(3)}
                  <span style={{ color: DIM_COLOR, marginLeft: "8px" }}>
                    (0 = perfect, 0.25 = random, 1 = always wrong)
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Chain integrity (concept: Aether_Forge Ω darlekRAG) */}
        {chain && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ color: DIM_COLOR, marginBottom: "6px" }}>POSTMORTEM CHAIN INTEGRITY</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "16px" }}>
              <span>
                <span style={{ color: DIM_COLOR }}>total:</span> {chain.total}
              </span>
              <span>
                <span style={{ color: DIM_COLOR }}>status:</span>{" "}
                {chain.ok ? (
                  <span style={{ color: PROMPT_COLOR }}>verified</span>
                ) : (
                  <span style={{ color: ERROR_COLOR }}>broken</span>
                )}
              </span>
              <span>
                <span style={{ color: DIM_COLOR }}>link breaks:</span>{" "}
                <span style={{ color: chain.linkBreaks > 0 ? WARN_COLOR : PROMPT_COLOR }}>{chain.linkBreaks}</span>
                <span style={{ color: DIM_COLOR, marginLeft: "6px", fontSize: "11px" }}>
                  (expected on in-place updates)
                </span>
              </span>
              <span>
                <span style={{ color: DIM_COLOR }}>content mismatches:</span>{" "}
                <span style={{ color: chain.contentMismatches > 0 ? ERROR_COLOR : PROMPT_COLOR }}>
                  {chain.contentMismatches}
                </span>
                <span style={{ color: DIM_COLOR, marginLeft: "6px", fontSize: "11px" }}>
                  (tamper alarm if &gt; 0)
                </span>
              </span>
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={generateProphecies}
            disabled={loading}
            aria-label="Generate one new prophecy via the LLM"
            style={{
              ...btnStyle,
              opacity: loading ? 0.5 : 1,
              cursor: loading ? "wait" : "pointer",
            }}
          >
            [ GENERATE PROPHECY ]
          </button>
          <button
            type="button"
            onClick={evaluateDue}
            disabled={loading}
            aria-label="Evaluate all due prophecies via the LLM"
            style={{
              ...btnStyle,
              opacity: loading ? 0.5 : 1,
              cursor: loading ? "wait" : "pointer",
            }}
          >
            [ EVALUATE DUE ]
          </button>
          <button
            type="button"
            onClick={runArchaeology}
            disabled={archLoading || loading}
            aria-label="Mine the target repo's git history for wrong/correct commit pairs and seed archaeology prophecies"
            style={{
              ...btnStyle,
              opacity: archLoading || loading ? 0.5 : 1,
              cursor: archLoading || loading ? "wait" : "pointer",
            }}
          >
            [ ARCHAEOLOGY: MINE HISTORY ]
          </button>
          {(loading || archLoading) && (
            <span style={{ color: DIM_COLOR, alignSelf: "center" }}>working…</span>
          )}
        </div>

        {actionMsg && (
          <div style={{ color: PROMPT_COLOR, marginBottom: "8px", whiteSpace: "pre-wrap" }}>
            {actionMsg}
          </div>
        )}
        {error && (
          <div style={{ color: ERROR_COLOR, marginBottom: "8px", whiteSpace: "pre-wrap" }}>
            {error}
          </div>
        )}

        {/* Prophecies list */}
        <div>
          <div style={{ color: DIM_COLOR, marginBottom: "6px" }}>
            RECENT PROPHECIES (newest first)
          </div>
          {prophecies.length === 0 ? (
            <div style={{ color: DIM_COLOR, fontStyle: "italic" }}>
              (no prophecies yet — click GENERATE to make one)
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {prophecies.map((p) => (
                <div
                  key={p.id}
                  style={{
                    border: `1px solid ${DIM_COLOR}`,
                    padding: "8px",
                    background: "#000",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", marginBottom: "4px" }}>
                    <span style={{ color: verdictColor(p.status), fontWeight: "bold" }}>
                      [{p.status.toUpperCase()}]
                    </span>
                    <span style={{ color: DIM_COLOR, fontSize: "11px" }}>
                      {p.domain ? `${p.domain} · ` : ""}
                      {formatConfidence(p.confidence)} ·{" "}
                      {p.status === "pending"
                        ? `${timeUntil(p.evaluateBy)}`
                        : `judged ${formatDate(p.evaluatedAt)}`}
                    </span>
                  </div>
                  <div style={{ color: PROMPT_COLOR, marginBottom: "4px" }}>
                    {p.claim}
                  </div>
                  <details style={{ color: DIM_COLOR, fontSize: "11px" }}>
                    <summary style={{ cursor: "pointer", color: DIM_COLOR }}>
                      rationale + criterion
                    </summary>
                    <div style={{ marginTop: "4px" }}>
                      <div>
                        <span style={{ color: DIM_COLOR }}>RATIONALE: </span>
                        {p.rationale}
                      </div>
                      <div style={{ marginTop: "4px" }}>
                        <span style={{ color: DIM_COLOR }}>CRITERION: </span>
                        {p.falsifiabilityCriterion}
                      </div>
                      {p.evaluation && (
                        <div style={{ marginTop: "4px" }}>
                          <span style={{ color: DIM_COLOR }}>EVALUATION: </span>
                          {p.evaluation}
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* AUDIT 8 — the oracle-to-task closure, operator-visible. Failed
            self-prophecies feed SelfTasks (oracle-task-feed.ts); this panel
            surfaces both halves of the loop in one place. */}
        <div style={{ marginTop: "16px", paddingTop: "8px", borderTop: `1px solid ${DIM_COLOR}` }}>
          <div style={{ color: DIM_COLOR, fontSize: "11px", marginBottom: "8px" }}>
            FAILED PROPHECIES → SELF-TASKS (the closure: a wrong prediction
            triggers an investigation task on the same file)
          </div>
          <OracleTaskFeedPanel />
        </div>

        <div style={{ marginTop: "16px", paddingTop: "8px", borderTop: `1px solid ${DIM_COLOR}`, color: DIM_COLOR, fontSize: "11px" }}>
          Prophecies are predictions made BEFORE the events they describe,
          judged AFTER. The calibration metric is the system&apos;s
          metacognition — a measurable form of self-reflection. Made-up
          prophecies are never stored; unjudgeable ones are marked
          retired, not silently dropped.
        </div>
      </div>
    </div>
  );
}
