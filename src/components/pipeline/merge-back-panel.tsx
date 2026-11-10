"use client";

/**
 * Merge-Back Panel — reviewed catch-up of a retained `loop-NN` mutation
 * branch into the operator-curated `main` branch.
 *
 * WHY THIS EXISTS: the autonomous loop creates a new `loop-NN` remote
 * branch per successful mutation but has NO path back to `main` — main is
 * operator-curated (deliberate merges, e.g. `Merge origin/loop-175`). After
 * 198 cycles main was 35 mutations behind loop-198: the running system was
 * NOT benefiting from its own recent self-enhancements. This panel is the
 * reviewed, typecheck-gated catch-up path (see merge-back.ts).
 *
 * Flow:
 *   1. Fetch the retained loop-NN branches (GET /api/self-enhance/merge-back)
 *   2. Operator picks a branch → fetch the full plan (GET ?branch=loop-NN)
 *   3. Operator clicks [DRY-RUN] → POST with strategy:"dry-run" (changes nothing)
 *   4. Operator clicks [EXECUTE] → POST with strategy:"theirs-for-source"
 *      Stages src/ files from the loop branch, runs tsc --noEmit, commits
 *      ONLY if typecheck passes. Push is OFF by default — the operator
 *      pushes via the existing [PUSH] UI so the merge stays reversible.
 *
 * Renders as a modal matching the terminal aesthetic (black bg, mono).
 */

import { useEffect, useState } from "react";

const PROMPT_COLOR = "#e0e0e0";
const DIM_COLOR = "#777777";
const ERROR_COLOR = "#ff4444";
const WARN_COLOR = "#ffaa33";
const OK_COLOR = "#44dd88";
const LINK_COLOR = "#6699cc";
const ACCENT_COLOR = "#dd99ff";

const btnStyle: React.CSSProperties = {
  background: "#000",
  border: `1px solid ${DIM_COLOR}`,
  color: PROMPT_COLOR,
  fontFamily: "inherit",
  fontSize: "inherit",
  padding: "4px 10px",
  cursor: "pointer",
};

const dangerBtnStyle: React.CSSProperties = {
  ...btnStyle,
  border: `1px solid ${WARN_COLOR}`,
  color: WARN_COLOR,
};

interface Candidate {
  name: string;
  number: number;
  sha: string;
  commitSubject: string;
  commitsAhead: number;
  sourceFilesDelta: number;
}

interface PlanFile {
  path: string;
  status: "modified" | "added" | "deleted";
}

interface Plan {
  branch: string;
  branchSha: string;
  mainSha: string;
  commitsAhead: number;
  commitsBehind: number;
  sourceFilesToChange: PlanFile[];
  mainOnlyFiles: string[];
  loopMetadataFiles: string[];
  loopBranchTypecheck: "unknown" | "pass" | "fail";
  conflictsIfMerged: string[];
}

interface ExecResult {
  ok: boolean;
  branch: string;
  strategy: string;
  committed: boolean;
  commitSha?: string;
  filesChanged: number;
  typecheckPassed: boolean;
  pushed?: boolean;
  error?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function MergeBackPanel({ open, onClose }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch candidates on open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingCandidates(true);
    setError(null);
    fetch("/api/self-enhance/merge-back", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { ok: boolean; candidates: Candidate[]; error?: string }) => {
        if (cancelled) return;
        if (j.ok) {
          setCandidates(j.candidates ?? []);
          // Auto-select the highest-numbered (newest) branch.
          if ((j.candidates ?? []).length > 0) {
            setSelected(j.candidates[0].name);
          }
        } else {
          setError(j.error || "Could not load merge-back candidates.");
        }
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoadingCandidates(false));
    return () => { cancelled = true; };
  }, [open]);

  // Fetch the plan when selection changes.
  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;
    setLoadingPlan(true);
    setResult(null);
    setError(null);
    fetch(`/api/self-enhance/merge-back?branch=${encodeURIComponent(selected)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { ok: boolean; plan: Plan; error?: string }) => {
        if (cancelled) return;
        if (j.ok) setPlan(j.plan);
        else setError(j.error || "Could not load plan.");
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoadingPlan(false));
    return () => { cancelled = true; };
  }, [open, selected]);

  if (!open) return null;

  const runExecute = async (strategy: "dry-run" | "theirs-for-source") => {
    if (!selected) return;
    setExecuting(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/self-enhance/merge-back", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: selected, strategy }),
      });
      const j: ExecResult = await res.json();
      setResult(j);
      if (j.committed) {
        // Refresh candidates after a successful commit (commitsAhead changes).
        setLoadingCandidates(true);
        fetch("/api/self-enhance/merge-back", { cache: "no-store" })
          .then((r) => r.json())
          .then((jj: { ok: boolean; candidates: Candidate[] }) => {
            if (jj.ok) setCandidates(jj.candidates ?? []);
          })
          .finally(() => setLoadingCandidates(false));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Merge-back panel — catch main up to a loop-NN branch"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        zIndex: 110,
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
          border: `1px solid ${ACCENT_COLOR}`,
          maxWidth: "980px",
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: "16px 18px",
          fontFamily: "inherit",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "12px",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <strong style={{ color: ACCENT_COLOR, fontSize: "1.05em" }}>
            MERGE-BACK — catch main up to a retained loop-NN branch
          </strong>
          <button type="button" onClick={onClose} style={btnStyle} aria-label="Close merge-back panel">
            [CLOSE]
          </button>
        </div>

        {/* Why box */}
        <div
          style={{
            color: DIM_COLOR,
            fontSize: "0.85em",
            lineHeight: 1.5,
            border: `1px solid ${DIM_COLOR}`,
            padding: "8px 10px",
            marginBottom: "12px",
          }}
        >
          The loop creates a new <span style={{ color: OK_COLOR }}>loop-NN</span> branch per
          mutation but has no path back to <span style={{ color: PROMPT_COLOR }}>main</span> (main is
          operator-curated). This panel brings src/ mutations forward, typecheck-gated. Main&apos;s
          metadata (README, memory/, postmortems/) is kept. Push is off by default — use [PUSH]
          afterward so the merge stays reversible until then.
        </div>

        {error && (
          <div style={{ color: ERROR_COLOR, padding: "8px 0" }}>ERROR: {error}</div>
        )}

        {/* Candidates list */}
        <div style={{ marginBottom: "14px" }}>
          <div style={{ color: DIM_COLOR, fontSize: "0.88em", marginBottom: "6px" }}>
            {loadingCandidates
              ? "Loading retained branches..."
              : `${candidates.length} retained loop-NN branch(es). Pick one to see the merge-back plan:`}
          </div>
          {!loadingCandidates && candidates.length > 0 && (
            <div
              style={{
                maxHeight: "180px",
                overflowY: "auto",
                border: `1px solid ${DIM_COLOR}`,
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9em" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${DIM_COLOR}`, color: DIM_COLOR, textAlign: "left" }}>
                    <th style={{ padding: "5px 8px", width: "70px" }}>branch</th>
                    <th style={{ padding: "5px 8px", width: "70px" }}>sha</th>
                    <th style={{ padding: "5px 8px" }}>mutation</th>
                    <th style={{ padding: "5px 8px", width: "60px" }}>ahead</th>
                    <th style={{ padding: "5px 8px", width: "60px" }}>Δ src</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr
                      key={c.name}
                      onClick={() => setSelected(c.name)}
                      style={{
                        borderBottom: "1px solid #222",
                        cursor: "pointer",
                        background: selected === c.name ? "#1a1a1a" : "transparent",
                      }}
                    >
                      <td style={{ padding: "4px 8px", color: OK_COLOR, whiteSpace: "nowrap" }}>{c.name}</td>
                      <td style={{ padding: "4px 8px", color: DIM_COLOR, whiteSpace: "nowrap" }}>{c.sha}</td>
                      <td style={{ padding: "4px 8px", color: PROMPT_COLOR, wordBreak: "break-word" }}>{c.commitSubject}</td>
                      <td style={{ padding: "4px 8px", color: c.commitsAhead > 0 ? WARN_COLOR : DIM_COLOR, whiteSpace: "nowrap" }}>
                        +{c.commitsAhead}
                      </td>
                      <td style={{ padding: "4px 8px", color: c.sourceFilesDelta > 0 ? ACCENT_COLOR : DIM_COLOR, whiteSpace: "nowrap" }}>
                        {c.sourceFilesDelta}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Plan + actions */}
        {selected && loadingPlan && (
          <div style={{ color: DIM_COLOR, padding: "8px 0" }}>Loading plan for {selected}...</div>
        )}
        {selected && plan && !loadingPlan && (
          <div style={{ borderTop: `1px solid ${DIM_COLOR}`, paddingTop: "12px" }}>
            <div style={{ color: PROMPT_COLOR, marginBottom: "8px" }}>
              <span style={{ color: DIM_COLOR }}>plan for </span>
              <span style={{ color: OK_COLOR }}>{plan.branch}</span>
              <span style={{ color: DIM_COLOR }}> ({plan.branchSha})</span>
              {" — main ("}
              <span style={{ color: PROMPT_COLOR }}>{plan.mainSha}</span>):
            </div>
            <div style={{ color: DIM_COLOR, fontSize: "0.88em", lineHeight: 1.6, marginBottom: "10px" }}>
              <span style={{ color: plan.commitsAhead > 0 ? WARN_COLOR : DIM_COLOR }}>{plan.commitsAhead} loop commits</span>
              {" not in main | "}
              <span style={{ color: plan.commitsBehind > 0 ? WARN_COLOR : DIM_COLOR }}>{plan.commitsBehind} main commits</span>
              {" not in loop | "}
              <span style={{ color: plan.sourceFilesToChange.length > 0 ? ACCENT_COLOR : DIM_COLOR }}>
                {plan.sourceFilesToChange.length} src/ files would change
              </span>
              {" | "}
              {plan.conflictsIfMerged.length} file(s) would conflict in a raw git merge
            </div>

            {plan.sourceFilesToChange.length > 0 && (
              <div
                style={{
                  maxHeight: "200px",
                  overflowY: "auto",
                  border: `1px solid ${DIM_COLOR}`,
                  padding: "6px 8px",
                  fontSize: "0.85em",
                  marginBottom: "10px",
                }}
              >
                {plan.sourceFilesToChange.slice(0, 100).map((f) => (
                  <div key={f.path} style={{ color: PROMPT_COLOR, lineHeight: 1.5, wordBreak: "break-word" }}>
                    <span style={{
                      color: f.status === "added" ? OK_COLOR : f.status === "deleted" ? ERROR_COLOR : WARN_COLOR,
                      marginRight: "6px",
                    }}>
                      {f.status === "added" ? "+" : f.status === "deleted" ? "−" : "~"}
                    </span>
                    {f.path}
                  </div>
                ))}
                {plan.sourceFilesToChange.length > 100 && (
                  <div style={{ color: DIM_COLOR, marginTop: "4px" }}>
                    ... and {plan.sourceFilesToChange.length - 100} more
                  </div>
                )}
              </div>
            )}

            {plan.loopMetadataFiles.length > 0 && (
              <div style={{ color: DIM_COLOR, fontSize: "0.82em", marginBottom: "10px" }}>
                <span style={{ color: PROMPT_COLOR }}>{plan.loopMetadataFiles.length}</span> non-src file(s)
                differ on the loop branch — <span style={{ color: OK_COLOR }}>kept on main</span> (not
                brought over).
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
              <button
                type="button"
                onClick={() => runExecute("dry-run")}
                disabled={executing || plan.sourceFilesToChange.length === 0}
                style={btnStyle}
                aria-label="Dry-run the merge-back (changes nothing)"
              >
                [DRY-RUN]
              </button>
              <button
                type="button"
                onClick={() => runExecute("theirs-for-source")}
                disabled={executing || plan.sourceFilesToChange.length === 0}
                style={dangerBtnStyle}
                aria-label="Execute the merge-back — typecheck-gated, commits but does not push"
              >
                [EXECUTE — stage src/, typecheck, commit]
              </button>
              {executing && (
                <span style={{ color: WARN_COLOR, fontSize: "0.88em", alignSelf: "center" }}>
                  running tsc --noEmit (up to 3 min)...
                </span>
              )}
            </div>

            {/* Result */}
            {result && (
              <div
                style={{
                  border: `1px solid ${result.ok ? OK_COLOR : ERROR_COLOR}`,
                  padding: "8px 10px",
                  fontSize: "0.88em",
                  lineHeight: 1.6,
                  color: result.ok ? PROMPT_COLOR : ERROR_COLOR,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                <div>
                  <span style={{ color: result.ok ? OK_COLOR : ERROR_COLOR }}>
                    {result.ok ? "✓" : "✗"}
                  </span>{" "}
                  {result.committed ? "committed" : result.strategy}
                  {result.commitSha ? ` (${result.commitSha})` : ""}
                  {result.pushed ? " + pushed" : ""}
                  {" — "}
                  {result.filesChanged} file(s)
                  {result.typecheckPassed ? ", typecheck passed" : result.typecheckPassed === false ? ", typecheck FAILED" : ""}
                </div>
                {result.error && (
                  <div style={{ color: result.ok ? WARN_COLOR : ERROR_COLOR, marginTop: "4px" }}>
                    {result.error}
                  </div>
                )}
                {result.committed && (
                  <div style={{ color: DIM_COLOR, marginTop: "6px" }}>
                    Next: push via the [PUSH] button so origin/main catches up. Until then, the
                    commit is local and reversible (<code style={{ color: LINK_COLOR }}>git reset --soft HEAD~1</code>).
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
