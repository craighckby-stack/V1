"use client";

/**
 * Target panel — the external-repository pipeline (the "rea" revival,
 * DIRECTIONS.md Direction 3).
 *
 * The system was BORN as an external-repo pipeline: fetch a real repo,
 * find real issues, push verified fixes to an evolution branch. The
 * self-enhance loop was built to harden the machinery; this panel points
 * the hardened machinery back OUTWARD.
 *
 * House modal pattern (same as OraclePanel): page.tsx owns open/close
 * (Escape + click-outside + the [TARGET] header button); the panel body
 * renders the ManualPipelineRunner card plus a compact run-history strip
 * backed by /api/pipeline/history (PipelineRun table, newest 25).
 */

import { useCallback, useEffect, useState } from "react";
import { ManualPipelineRunner } from "./manual-runner";

const PROMPT_COLOR = "#e0e0e0";
const DIM_COLOR = "#777777";
const GOOD_COLOR = "#22c55e";
const BAD_COLOR = "#ff4444";
const WARN_COLOR = "#ffaa33";

const btnStyle: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${DIM_COLOR}`,
  color: PROMPT_COLOR,
  fontFamily: "inherit",
  fontSize: "12px",
  padding: "2px 8px",
  cursor: "pointer",
};

interface HistoryRun {
  id: string;
  targetRepo: string;
  filePath: string;
  evolutionBranch: string;
  status: string;
  astScore: number;
  consensus: string;
  proofHash: string;
  triggeredBy: string;
  createdAt: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function statusColor(status: string): string {
  if (status === "COMPLETED") return GOOD_COLOR;
  if (status === "REJECTED" || status === "HALTED") return BAD_COLOR;
  return WARN_COLOR;
}

export function TargetPanel({ open, onClose }: Props) {
  const [runs, setRuns] = useState<HistoryRun[]>([]);
  const [loading, setLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/pipeline/history");
      const data = (await res.json()) as { runs?: HistoryRun[] };
      if (res.ok) setRuns(data.runs ?? []);
    } catch {
      // History is a convenience strip — never block the panel on it.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadHistory();
  }, [open, loadHistory]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Target panel — run the 6-stage verified pipeline against an external repository"
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
          maxWidth: "980px",
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
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <span style={{ color: PROMPT_COLOR, fontWeight: "bold" }}>TARGET</span>
            <span style={{ color: DIM_COLOR, marginLeft: "8px" }}>
              — the 6-stage gauntlet, pointed at any GitHub repo
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close the Target panel" style={btnStyle}>
            [ CLOSE ]
          </button>
        </div>

        {/* Explanation strip — one honest paragraph, house voice */}
        <div style={{ color: DIM_COLOR, marginBottom: "12px" }}>
          fetch a repo → pick a file → sanitize → reason (LLM) → AST gate →
          debate tribunal → push survivors to an{" "}
          <span style={{ color: PROMPT_COLOR }}>&lt;branch&gt;-evolution</span> branch
          — never the target branch itself. Reads work anonymously on public
          repos; pushes need a PAT with repo scope.
        </div>

        {/* The runner (repo/branch/token + file list + code + run button) */}
        <ManualPipelineRunner />

        {/* Run history strip */}
        <div style={{ marginTop: "14px" }}>
          <div
            style={{
              color: DIM_COLOR,
              marginBottom: "6px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            <span>RECENT RUNS (newest 25, persisted in PipelineRun)</span>
            <button type="button" onClick={() => void loadHistory()} style={btnStyle} aria-label="Refresh run history">
              [ REFRESH ]
            </button>
          </div>
          {loading ? (
            <div style={{ color: DIM_COLOR }}>loading…</div>
          ) : runs.length === 0 ? (
            <div style={{ color: DIM_COLOR }}>
              no runs yet — scan a repo above and run the pipeline
            </div>
          ) : (
            <div style={{ maxHeight: "180px", overflowY: "auto", border: `1px solid ${DIM_COLOR}`, padding: "4px 8px" }}>
              {runs.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    gap: "10px",
                    flexWrap: "wrap",
                    padding: "2px 0",
                    borderBottom: `1px solid #1a1a1a`,
                  }}
                >
                  <span style={{ color: statusColor(r.status), minWidth: "110px" }}>{r.status}</span>
                  <span style={{ color: PROMPT_COLOR, flex: 1, minWidth: "180px", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.targetRepo}:{r.filePath}
                  </span>
                  <span style={{ color: DIM_COLOR }}>AST {r.astScore}</span>
                  <span style={{ color: DIM_COLOR, maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.consensus}
                  </span>
                  <span style={{ color: DIM_COLOR }}>{new Date(r.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
