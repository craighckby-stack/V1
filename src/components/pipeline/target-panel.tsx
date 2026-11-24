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

import { useCallback, useEffect, useState, useRef } from "react";
import { ManualPipelineRunner } from "./manual-runner";
import { AutoPipelineRunner } from "./auto-runner";

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

function triggeredByColor(source: string): string {
  if (source === "auto") return "#22d3ee"; // cyan — one-click gauntlet runs
  if (source === "autonomous") return "#ffaa33"; // the self-enhance loop
  return DIM_COLOR; // manual
}

export function TargetPanel({ open, onClose }: Props) {
  const [runs, setRuns] = useState<HistoryRun[]>([]);
  const [loading, setLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const loadHistory = useCallback(async () => {
    // Cancel any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    
    setLoading(true);
    setRuns([]); // Reset runs immediately upon starting load
    
    // Set up timeout mechanism
    const TIMEOUT_MS = 10000;
    timeoutRef.current = setTimeout(() => {
        if (signal.aborted) return;
        abortControllerRef.current?.abort();
        console.error("Pipeline history request timed out after 10s.");
        setRuns([]);
        setLoading(false);
        timeoutRef.current = null;
    }, TIMEOUT_MS);

    try {
      const fetchPromise = fetch("/api/pipeline/history", { signal });
      
      // Race fetch against a promise that rejects on timeout
      const res = await Promise.race([
        fetchPromise, 
        new Promise<Response>((_, reject) => {
            // This internal timeout promise is redundant if timeoutRef manages state,
            // but Promise.race requires a promise that resolves/rejects.
            // We rely on the external timeoutRef logic to set state, but this ensures Promise.race doesn't hang.
            setTimeout(() => {
                reject(new Error("Request timed out"));
            }, TIMEOUT_MS);
            // Note: We cannot reliably clear this internal timer here without complex state management,
            // relying on the external timeoutRef cleanup is safer for state consistency.
        })
      ]);
      
      // Clear external timeout if request completes successfully or with HTTP error
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      
      if (signal.aborted) return;
      
      if (!res.ok) {
        const errorText = await res.text().catch(() => "Could not read error body.");
        // Provide actionable error context including status and truncated body
        console.error(`Failed to load pipeline history: HTTP status ${res.status}. Context: ${errorText.substring(0, 100)}`);
        setRuns([]);
        setLoading(false);
        return;
      }
      
      const data = await res.json();
      
      // Validate response structure
      if (!data || !Array.isArray(data.runs)) {
        console.error("Unexpected response structure from pipeline history API: expected { runs: [...] }");
        setRuns([]);
        setLoading(false);
        return;
      }
      
      setRuns(data.runs);
      setLoading(false);
    } catch (error) {
      // Ignore abort errors
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      
      // Network or parsing error: log error with context but ensure loading state is resolved.
      console.error("Network or parsing error fetching pipeline history:", error instanceof Error ? error.message : "Unknown error during fetch/parse");
      setRuns([]);
      setLoading(false);
    } finally {
      // Ensure cleanup of timeout reference, even if fetch succeeded/failed before timeout fired
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (open) {
      // Only load when opening
      loadHistory();
    }
    
    // Cleanup function to cancel pending requests when component unmounts or closes
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
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
          repos; pushes need a PAT with repo scope. The{" "}
          <span style={{ color: "#22d3ee" }}>auto</span> card below does all
          of it in one click — auto runs are labeled{" "}
          <span style={{ color: "#22d3ee" }}>triggeredBy=auto</span> and feed
          postmortem scars per target repo, never the autonomous loop&apos;s
          lessons (sandbox, not population).
        </div>

        {/* The one-click auto runner (pick → gauntlet → push → feedback) */}
        <AutoPipelineRunner />

        <div style={{ height: "12px" }} />

        {/* The manual runner (repo/branch/token + file list + code + run button) */}
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
            <button type="button" onClick={loadHistory} style={btnStyle} aria-label="Refresh run history">
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
                  <span
                    style={{
                      color: triggeredByColor(r.triggeredBy),
                      minWidth: "86px",
                      border: `1px solid ${DIM_COLOR}`,
                      padding: "0 4px",
                      fontSize: "11px",
                    }}
                  >
                    {r.triggeredBy}
                  </span>
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