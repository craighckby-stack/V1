"use client";

/**
 * Branches Panel — shows the autonomous loop's mutation history on
 * the configured GitHub remote. Each `loop-NN` branch is one successful
 * self-enhancement (mutation); the panel lists them with their commit
 * message, sha, date, and a link to the branch on GitHub.
 *
 * WHY THIS EXISTS: the loop creates one branch per mutation so each
 * change is independently reviewable/mergeable. After a sandbox reboot
 * that wiped the local branch counter, the loop was about to reuse
 * `loop-01` and contaminate the first mutation's branch. The panel
 * makes the full mutation history visible + inspectable, and shows the
 * reconciled "next mutation will target loop-{N+1}" so the operator can
 * verify the counter is correct.
 *
 * Renders as a modal overlay matching the existing terminal aesthetic
 * (black bg, monospace, DOS-themed buttons). Fetches /api/branches on
 * open and on [REFRESH].
 */

import { useEffect, useState } from "react";

const PROMPT_COLOR = "#e0e0e0";
const DIM_COLOR = "#777777";
const ERROR_COLOR = "#ff4444";
const WARN_COLOR = "#ffaa33";
const OK_COLOR = "#44dd88";
const LINK_COLOR = "#6699cc";

const btnStyle: React.CSSProperties = {
  background: "#000",
  border: `1px solid ${DIM_COLOR}`,
  color: PROMPT_COLOR,
  fontFamily: "inherit",
  fontSize: "inherit",
  padding: "4px 10px",
  cursor: "pointer",
};

interface BranchInfo {
  name: string;
  number: number;
  sha: string;
  message: string;
  date: string | null;
  url: string;
}

interface OtherBranch {
  name: string;
  sha: string;
  message: string;
}

interface BranchesData {
  ok: boolean;
  repo?: string;
  total: number;
  maxLoopNumber: number;
  nextMutationBranch: string;
  truncated?: boolean;
  branches: BranchInfo[];
  otherBranches?: OtherBranch[];
  reason?: string;
  error?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function BranchesPanel({ open, onClose }: Props) {
  const [data, setData] = useState<BranchesData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);

  // Fetch on open. Not polled — branches change slowly (one per ~10min
  // cycle) and the fetch hits GitHub 38+ times, so polling would burn
  // quota. The operator clicks [REFRESH] to re-fetch.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/branches", { cache: "no-store" });
        const json = (await res.json()) as BranchesData;
        if (!cancelled) {
          setData(json);
          setLastFetchAt(Date.now());
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const branches = data?.branches ?? [];
  const otherBranches = data?.otherBranches ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Branches panel — the loop's mutation history on GitHub"
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
          maxWidth: "920px",
          width: "100%",
          maxHeight: "88vh",
          overflowY: "auto",
          padding: "16px 18px",
          fontFamily: "inherit",
        }}
      >
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
          <strong style={{ color: PROMPT_COLOR, fontSize: "1.05em" }}>
            BRANCHES — the loop&apos;s mutation history
          </strong>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => {
                // Force a refetch by toggling state via the effect dep.
                setLoading(true);
                fetch("/api/branches", { cache: "no-store" })
                  .then((r) => r.json())
                  .then((j: BranchesData) => {
                    setData(j);
                    setLastFetchAt(Date.now());
                  })
                  .catch((e) => setError((e as Error).message))
                  .finally(() => setLoading(false));
              }}
              style={btnStyle}
              aria-label="Refresh the branch list"
              disabled={loading}
            >
              [REFRESH]
            </button>
            <button
              type="button"
              onClick={onClose}
              style={btnStyle}
              aria-label="Close branches panel"
            >
              [CLOSE]
            </button>
          </div>
        </div>

        {loading && !data && (
          <div style={{ color: DIM_COLOR, padding: "12px 0" }}>
            Fetching branch list from GitHub (this hits the API once per
            branch — takes a few seconds)...
          </div>
        )}

        {error && (
          <div style={{ color: ERROR_COLOR, padding: "8px 0" }}>
            ERROR: {error}
          </div>
        )}

        {data && !data.ok && (
          <div style={{ color: WARN_COLOR, padding: "8px 0" }}>
            {data.reason || data.error || "Could not load branches."}
          </div>
        )}

        {data && data.ok && (
          <>
            <div
              style={{
                color: DIM_COLOR,
                fontSize: "0.9em",
                marginBottom: "10px",
                lineHeight: 1.5,
              }}
            >
              repo: <span style={{ color: PROMPT_COLOR }}>{data.repo}</span>
              {" | "}total mutation branches:{" "}
              <span style={{ color: OK_COLOR }}>{data.total}</span>
              {" | "}highest:{" "}
              <span style={{ color: PROMPT_COLOR }}>
                loop-{String(data.maxLoopNumber).padStart(2, "0")}
              </span>
              {" | "}next mutation will target:{" "}
              <span style={{ color: OK_COLOR }}>
                {data.nextMutationBranch}
              </span>
              {data.truncated && (
                <span style={{ color: WARN_COLOR }}>
                  {" "}(list was truncated at 100 — more branches exist)
                </span>
              )}
            </div>

            {branches.length === 0 ? (
              <div style={{ color: DIM_COLOR, padding: "12px 0" }}>
                No loop-NN branches yet. The first successful enhancement
                will create loop-01.
              </div>
            ) : (
              <div
                style={{
                  maxHeight: "55vh",
                  overflowY: "auto",
                  border: `1px solid ${DIM_COLOR}`,
                }}
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontFamily: "inherit",
                    fontSize: "0.92em",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        borderBottom: `1px solid ${DIM_COLOR}`,
                        color: DIM_COLOR,
                        textAlign: "left",
                      }}
                    >
                      <th style={{ padding: "6px 8px", width: "70px" }}>#</th>
                      <th style={{ padding: "6px 8px", width: "80px" }}>sha</th>
                      <th style={{ padding: "6px 8px" }}>mutation</th>
                      <th style={{ padding: "6px 8px", width: "120px" }}>date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {branches.map((b) => (
                      <tr
                        key={b.name}
                        style={{ borderBottom: `1px solid #222` }}
                      >
                        <td
                          style={{
                            padding: "5px 8px",
                            color: OK_COLOR,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {b.name}
                        </td>
                        <td
                          style={{
                            padding: "5px 8px",
                            color: DIM_COLOR,
                            fontFamily: "inherit",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {b.sha}
                        </td>
                        <td
                          style={{
                            padding: "5px 8px",
                            color: PROMPT_COLOR,
                            wordBreak: "break-word",
                          }}
                        >
                          <a
                            href={b.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: LINK_COLOR,
                              textDecoration: "none",
                            }}
                          >
                            {b.message || "(no commit message)"}
                          </a>
                        </td>
                        <td
                          style={{
                            padding: "5px 8px",
                            color: DIM_COLOR,
                            whiteSpace: "nowrap",
                            fontSize: "0.85em",
                          }}
                        >
                          {b.date
                            ? new Date(b.date).toISOString().slice(0, 16).replace("T", " ")
                            : "?"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {otherBranches.length > 0 && (
              <div style={{ marginTop: "14px" }}>
                <div
                  style={{
                    color: DIM_COLOR,
                    fontSize: "0.88em",
                    marginBottom: "6px",
                  }}
                >
                  other branches (not created by the loop):
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  {otherBranches.map((b) => (
                    <span
                      key={b.name}
                      style={{
                        color: PROMPT_COLOR,
                        border: `1px solid ${DIM_COLOR}`,
                        padding: "2px 8px",
                        fontSize: "0.88em",
                      }}
                    >
                      {b.name}{" "}
                      <span style={{ color: DIM_COLOR }}>{b.sha}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {lastFetchAt && (
              <div
                style={{
                  color: DIM_COLOR,
                  fontSize: "0.8em",
                  marginTop: "12px",
                }}
              >
                last fetched {new Date(lastFetchAt).toISOString().slice(11, 19)}Z
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
