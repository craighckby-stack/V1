"use client";

import { useEffect, useRef, useState } from "react";

interface LogEntry {
  timestamp: string;
  message: string;
  type: "info" | "success" | "warn" | "error";
}

interface SelfEnhanceStatus {
  running: boolean;
  stats: {
    totalScanned: number;
    totalEnhanced: number;
    totalReverted: number;
    totalPushed: number;
    lastEnhancementAt: string | null;
  };
  logs: LogEntry[];
  currentFile: string | null;
}

const COLOR_MAP: Record<LogEntry["type"], string> = {
  info: "#00ff00",
  success: "#00ff00",
  warn: "#ffff00",
  error: "#ff4444",
};

const PROMPT_COLOR = "#00ff00";
const DIM_COLOR = "#008800";
const USER_INPUT_COLOR = "#ffffff";

export default function Home() {
  const [status, setStatus] = useState<SelfEnhanceStatus | null>(null);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [terminalLines, setTerminalLines] = useState<
    Array<{ type: "system" | "command" | "output"; text: string }>
  >([
    { type: "system", text: "ARCHITECTURE HELPER PIPELINE v4.3 — SELF-ENHANCE MODE" },
    { type: "system", text: "(c) 2026 Z.ai Code — Autonomous Self-Modifying System" },
    { type: "system", text: "" },
    { type: "system", text: "Target: src/lib/pipeline/ (self-enhancement)" },
    { type: "system", text: "Mode: continuous autonomous refactoring" },
    { type: "system", text: "Verification: tsc --noEmit before every write" },
    { type: "system", text: "Proof: git push of current live state on each enhancement" },
    { type: "system", text: "" },
    { type: "system", text: "Type 'help' for commands, or type a goal in plain English." },
    { type: "system", text: "Example: 'add a search input that filters the file list'" },
    { type: "system", text: "" },
  ]);
  const [pendingPlan, setPendingPlan] = useState<{
    userGoal: string;
    understanding: string;
    files: Array<{ path: string; action: string; reason: string }>;
    summary: string;
  } | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);

  // Config panel state
  const [configOpen, setConfigOpen] = useState(false);
  const [cfgToken, setCfgToken] = useState("");
  const [cfgRepo, setCfgRepo] = useState("");
  const [cfgPublic, setCfgPublic] = useState(false);
  const [cfgAutoCreate, setCfgAutoCreate] = useState(true);
  const [cfgShowToken, setCfgShowToken] = useState(false);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [cfgStatusMsg, setCfgStatusMsg] = useState<string | null>(null);
  const [cfgTarget, setCfgTarget] = useState<{ configured: boolean; repo?: string; branch?: string; createdRepo?: boolean; lastPushSha?: string | null; lastPushAt?: string | null; lastPushError?: string | null } | null>(null);
  const [pushTarget, setPushTarget] = useState<{ configured: boolean; repo?: string } | null>(null);
  const cfgTokenRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Poll for status every 2 seconds
  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const [statusRes, targetRes] = await Promise.all([
          fetch("/api/self-enhance/status"),
          fetch("/api/self-enhance/push-target"),
        ]);
        if (statusRes.ok && mounted) setStatus(await statusRes.json());
        if (targetRes.ok && mounted) setPushTarget(await targetRes.json());
      } catch {
        // ignore
      }
    }

    poll();
    const interval = setInterval(poll, 2000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Auto-scroll to bottom of log when NEW COMMAND OUTPUT appears (terminalLines),
  // not when server logs update (which would yank the view away from what the
  // user just typed).
  const terminalLineCount = terminalLines.length;
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [terminalLineCount]);

  // Focus input on click anywhere — but NOT while the config modal is open
  useEffect(() => {
    const handler = () => {
      if (!configOpen) inputRef.current?.focus();
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [configOpen]);

  // Escape closes the config modal
  useEffect(() => {
    if (!configOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeConfig();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [configOpen]);

  /** Append output lines to the terminal (used by the config flow). */
  function emitOutput(lines: string[]) {
    setTerminalLines((prev) => [
      ...prev,
      ...lines.map((l) => ({ type: "output" as const, text: l })),
    ]);
  }

  async function openConfig() {
    setConfigOpen(true);
    setCfgError(null);
    setCfgStatusMsg(null);
    setCfgLoading(false);
    try {
      const res = await fetch("/api/self-enhance/push-target");
      if (res.ok) {
        const t = await res.json();
        setCfgTarget(t);
        if (t.configured && t.repo) setCfgRepo(t.repo);
      }
    } catch {
      /* best-effort */
    }
    setTimeout(() => cfgTokenRef.current?.focus(), 50);
  }

  function closeConfig() {
    setConfigOpen(false);
    setCfgError(null);
    setCfgStatusMsg(null);
    setCfgToken("");
    setCfgShowToken(false);
    inputRef.current?.focus();
  }

  async function submitConfig() {
    setCfgLoading(true);
    setCfgError(null);
    setCfgStatusMsg(null);
    const token = cfgToken.trim();
    const repo = cfgRepo.trim();
    if (!token || !repo) {
      setCfgLoading(false);
      setCfgError("Both token and repo are required.");
      return;
    }
    try {
      const res = await fetch("/api/self-enhance/push-target", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, token, isPublic: cfgPublic, createIfMissing: cfgAutoCreate }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCfgLoading(false);
        setCfgError(data.error ?? "Configuration failed");
        return;
      }
      setCfgStatusMsg(data.created ? `Created github.com/${data.repo}. Pushing first proof...` : `Connected as ${data.login}. Pushing first proof...`);
      try {
        const pushRes = await fetch("/api/self-enhance/push", { method: "POST" });
        const pushData = await pushRes.json();
        if (pushData.pushed) {
          emitOutput([
            `[CONFIG] Connected to github.com/${data.repo} as ${data.login}`,
            `[CONFIG] First proof push: commit ${pushData.commitSha}`,
          ]);
          const fresh = await fetch("/api/self-enhance/push-target");
          if (fresh.ok) setCfgTarget(await fresh.json());
          setCfgToken("");
          setCfgShowToken(false);
          setCfgStatusMsg(`Pushed commit ${pushData.commitSha}. Connected ✓`);
        } else {
          setCfgError(`Connected, but initial push failed: ${pushData.error ?? "unknown"}`);
        }
      } catch {
        setCfgError("Connected, but initial push failed (network error).");
      }
    } catch (e) {
      setCfgError((e as Error).message);
    } finally {
      setCfgLoading(false);
    }
  }

  async function disconnectTarget() {
    setCfgLoading(true);
    setCfgError(null);
    setCfgStatusMsg(null);
    try {
      const res = await fetch("/api/self-enhance/push-target", { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setCfgTarget({ configured: false });
        setCfgRepo("");
        setCfgStatusMsg("Disconnected. The system will commit locally only.");
        emitOutput(["[CONFIG] Push target disconnected."]);
      } else {
        setCfgError(data.error ?? "Disconnect failed");
      }
    } catch (e) {
      setCfgError((e as Error).message);
    } finally {
      setCfgLoading(false);
    }
  }

  async function executeCommand(cmd: string) {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    setHistory((prev) => [...prev, trimmed]);
    setHistoryIdx(-1);

    const lower = trimmed.toLowerCase();
    const parts = lower.split(/\s+/);
    const command = parts[0];

    switch (command) {
      case "help":
        return [
          "Available commands:",
          "  start       — Start continuous self-enhancement loop",
          "  stop        — Stop the loop",
          "  trigger     — Run one enhancement cycle",
          "  status      — Show current status",
          "  push        — Push current live state to GitHub",
          "  config      — Open Git config panel",
          "  logs        — Show recent logs",
          "  files       — List files being enhanced",
          "  clear       — Clear the terminal",
          "  help        — Show this help",
          "",
          "CHAT MODE:",
          "  Type anything that's not a command and the system will",
          "  analyze the codebase, propose a plan, and ask you to approve.",
          "  Example: 'add a search input that filters the file list'",
          "  Then type 'yes' to apply, or anything else to cancel.",
          "",
        ];

      case "start": {
        try {
          const res = await fetch("/api/self-enhance/start", { method: "POST" });
          const data = await res.json();
          return [data.message || "Started"];
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "stop": {
        try {
          await fetch("/api/self-enhance/stop", { method: "POST" });
          return ["Self-enhancement loop stopped"];
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "config":
      case "cfg": {
        openConfig();
        return ["Opening Git config panel... (or click [CONFIG] in the header)"];
      }

      case "trigger":
      case "run": {
        return ["Running one cycle... (check logs for progress)"];
      }

      case "status": {
        const s = status;
        if (!s) return ["No status available yet"];
        return [
          `Running:       ${s.running ? "YES" : "NO"}`,
          `Files scanned: ${s.stats.totalScanned}`,
          `Files enhanced: ${s.stats.totalEnhanced}`,
          `Files reverted: ${s.stats.totalReverted}`,
          `Pushes to git:  ${s.stats.totalPushed}`,
          `Last enhanced:  ${s.stats.lastEnhancementAt ?? "never"}`,
          `Current file:   ${s.currentFile ?? "idle"}`,
        ];
      }

      case "push": {
        try {
          const res = await fetch("/api/self-enhance/push", { method: "POST" });
          const data = await res.json();
          if (data.pushed) return [`Pushed to GitHub: commit ${data.commitSha}`];
          if (data.committed) return [`Committed ${data.commitSha} but push failed (no remote?)`];
          return ["No changes to push"];
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "logs": {
        const logs = status?.logs ?? [];
        if (logs.length === 0) return ["No logs yet"];
        return logs.slice(0, 20).map((l) => `[${l.timestamp}] ${l.message}`);
      }

      case "files":
      case "list": {
        return [
          "Self-enhancement targets (src/lib/pipeline/):",
          "  core/       — unified-pipeline, ast-diff-gate, siphon, binaryShield",
          "  emg/        — sanitizer, debate, halt, emg-rag",
          "  engines/    — clean-room-runtime",
          "  postmortem/ — postmortem-store",
          "",
          "Protected (not modified):",
          "  autonomous/ — loop-runtime, self-enhance-loop, loop-event-bus",
          "  llm/         — agent-llm, debate-llm",
        ];
      }

      case "clear":
      case "cls":
        setStatus(null);
        return [""];

      case "exit":
      case "quit":
        return ["Cannot exit — the system runs continuously. Use 'stop' to halt enhancement."];

      case "yes":
      case "y":
      case "approve": {
        if (!pendingPlan) {
          return ["No pending plan to approve. Type a goal first."];
        }
        setTaskLoading(true);
        try {
          const res = await fetch("/api/self-enhance/chat-task/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...pendingPlan, ok: true }),
          });
          const data = await res.json();
          setPendingPlan(null);
          if (data.ok) {
            const lines = [
              "APPLIED:",
              ...data.results.map(
                (r: { path: string; applied: boolean; reason: string }) =>
                  `  ${r.applied ? "✓" : "✗"} ${r.path} — ${r.reason}`
              ),
            ];
            if (data.pushed) {
              lines.push(`Pushed to GitHub: commit ${data.commitSha}`);
            } else if (data.error) {
              lines.push(`⚠ ${data.error}`);
            }
            return lines;
          }
          return [`Failed: ${data.error}`];
        } catch (e) {
          setPendingPlan(null);
          return [`Error applying plan: ${(e as Error).message}`];
        } finally {
          setTaskLoading(false);
        }
      }

      case "no":
      case "n":
      case "cancel": {
        if (pendingPlan) {
          setPendingPlan(null);
          return ["Plan cancelled."];
        }
        return ["Nothing to cancel."];
      }

      case "about":
        return [
          "Architecture Helper Pipeline v4.3",
          "Self-enhancing autonomous refactoring system",
          "The system modifies its own source code in src/lib/pipeline/,",
          "verifies with tsc --noEmit, and pushes to GitHub as proof.",
          "What you see on GitHub IS the current live state of the server.",
          "",
          "CHAT MODE: type a goal in plain English to direct the system.",
        ];

      default: {
        // Not a command — treat as a chat task goal
        if (taskLoading) return ["Task in progress, please wait..."];

        setTaskLoading(true);
        try {
          const res = await fetch("/api/self-enhance/chat-task/propose", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ goal: trimmed }),
          });
          const plan = await res.json();

          if (!plan.ok) {
            return [`Could not plan: ${plan.error ?? "unknown error"}`];
          }

          // Store the plan for "yes" approval
          setPendingPlan({
            userGoal: plan.userGoal,
            understanding: plan.understanding,
            files: plan.files,
            summary: plan.summary,
          });

          const lines = [
            `UNDERSTANDING: ${plan.understanding}`,
            "",
            "PROPOSED CHANGES:",
            ...plan.files.map(
              (f: { path: string; action: string; reason: string }) =>
                `  ${f.action.toUpperCase()}: ${f.path} — ${f.reason}`
            ),
            "",
            `SUMMARY: ${plan.summary}`,
            "",
            "Type 'yes' to apply and push, or 'no' to cancel.",
          ];
          return lines;
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        } finally {
          setTaskLoading(false);
        }
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cmd = input;
    setInput("");
    if (!cmd.trim()) return;

    // Echo the command to the terminal
    setTerminalLines((prev) => [...prev, { type: "command", text: cmd }]);

    // Execute and show output
    const output = await executeCommand(cmd);
    if (output && output.length > 0) {
      setTerminalLines((prev) => [
        ...prev,
        ...output.map((line) => ({ type: "output" as const, text: line })),
      ]);
    }

    // Force a status poll
    setTimeout(async () => {
      try {
        const res = await fetch("/api/self-enhance/status");
        if (res.ok) setStatus(await res.json());
      } catch {
        /* ignore */
      }
    }, 500);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length > 0) {
        const newIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(newIdx);
        setInput(history[newIdx]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx !== -1) {
        const newIdx = historyIdx + 1;
        if (newIdx >= history.length) {
          setHistoryIdx(-1);
          setInput("");
        } else {
          setHistoryIdx(newIdx);
          setInput(history[newIdx]);
        }
      }
    }
  }

  const logs = status?.logs ?? [];
  const s = status?.stats;
  const running = status?.running ?? false;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        color: PROMPT_COLOR,
        fontFamily: "'Courier New', 'Lucida Console', monospace",
        fontSize: "14px",
        lineHeight: "1.4",
        padding: "8px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header bar */}
      <div
        style={{
          borderBottom: `1px solid ${DIM_COLOR}`,
          paddingBottom: "4px",
          marginBottom: "8px",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
          <span style={{ color: DIM_COLOR }}>┌─ </span>
          <span style={{ color: PROMPT_COLOR, fontWeight: "bold" }}>
            ARCHITECTURE HELPER PIPELINE v4.3 — SELF-ENHANCE MODE
          </span>
          <span style={{ color: DIM_COLOR, marginLeft: "16px" }}>─┐</span>
          <span style={{ color: DIM_COLOR, marginLeft: "16px" }}>│</span>
          <span style={{ marginLeft: "8px", color: running ? "#00ff00" : "#ff4444" }}>
            [{running ? "ENHANCING" : "IDLE"}]
          </span>
          {s && (
            <span style={{ color: DIM_COLOR, marginLeft: "16px" }}>
              scanned={s.totalScanned} enhanced={s.totalEnhanced} reverted={s.totalReverted} pushed={s.totalPushed}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <span style={{ color: pushTarget?.configured ? PROMPT_COLOR : DIM_COLOR }}>
            [GIT: {pushTarget?.configured ? "ON" : "OFF"}]
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openConfig();
            }}
            aria-label="Open Git push configuration"
            style={{
              background: "#000",
              border: `1px solid ${DIM_COLOR}`,
              color: PROMPT_COLOR,
              fontFamily: "inherit",
              fontSize: "inherit",
              padding: "2px 8px",
              cursor: "pointer",
            }}
          >
            [CONFIG]
          </button>
        </div>
      </div>

      {/* Log area */}
      <div
        ref={logRef}
        style={{
          flex: 1,
          overflowY: "auto",
          paddingRight: "4px",
        }}
      >
        {/* Server logs (top — scrolling history of loop activity) */}
        {logs.map((log, idx) => (
          <div key={`log-${idx}`} style={{ color: COLOR_MAP[log.type], whiteSpace: "pre-wrap" }}>
            <span style={{ color: DIM_COLOR }}>[{log.timestamp}]</span>{" "}
            {log.message}
          </div>
        ))}

        {/* Terminal lines (bottom — command output stays visible after auto-scroll) */}
        {terminalLines.map((line, idx) => (
          <div
            key={`term-${idx}`}
            style={{
              color:
                line.type === "command"
                  ? "#ffffff"
                  : line.type === "output"
                  ? "#00ff00"
                  : "#008800",
              whiteSpace: "pre-wrap",
            }}
          >
            {line.type === "command" ? `> ${line.text}` : line.text || "\u00a0"}
          </div>
        ))}
      </div>

      {/* Prompt */}
      <div
        style={{
          borderTop: `1px solid ${DIM_COLOR}`,
          paddingTop: "4px",
          marginTop: "4px",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
        }}
      >
        <form onSubmit={handleSubmit} style={{ flex: 1, display: "flex" }}>
          <span style={{ color: PROMPT_COLOR, marginRight: "8px" }}>{">"}</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: USER_INPUT_COLOR,
              fontFamily: "inherit",
              fontSize: "inherit",
              caretColor: PROMPT_COLOR,
            }}
          />
        </form>
      </div>

      {/* Git config modal — DOS-styled, click-outside + Escape to close */}
      {configOpen && (
        <div
          onClick={closeConfig}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: "16px",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cfg-title"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#000",
              border: `1px solid ${PROMPT_COLOR}`,
              color: PROMPT_COLOR,
              fontFamily: "inherit",
              fontSize: "14px",
              padding: "16px",
              width: "min(560px, 92vw)",
              maxHeight: "90vh",
              overflowY: "auto",
              boxShadow: "0 0 24px rgba(0, 255, 0, 0.15)",
            }}
          >
            <div id="cfg-title" style={{ fontWeight: "bold", borderBottom: `1px solid ${DIM_COLOR}`, paddingBottom: "8px", marginBottom: "12px" }}>
              ┌─ GIT CONFIG ──────────────────────┐
            </div>

            {/* Token */}
            <div style={{ marginBottom: "12px" }}>
              <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>GitHub Token</div>
              <div style={{ display: "flex", gap: "4px" }}>
                <input
                  ref={cfgTokenRef}
                  type={cfgShowToken ? "text" : "password"}
                  value={cfgToken}
                  onChange={(e) => setCfgToken(e.target.value)}
                  placeholder="ghp_... (paste your GitHub PAT)"
                  autoComplete="off"
                  spellCheck={false}
                  style={{ flex: 1, background: "#000", border: `1px solid ${DIM_COLOR}`, color: USER_INPUT_COLOR, fontFamily: "inherit", fontSize: "inherit", padding: "4px 6px", outline: "none" }}
                />
                <button
                  type="button"
                  onClick={() => setCfgShowToken((v) => !v)}
                  style={{ background: "#000", border: `1px solid ${DIM_COLOR}`, color: PROMPT_COLOR, fontFamily: "inherit", fontSize: "inherit", padding: "4px 10px", cursor: "pointer" }}
                >
                  {cfgShowToken ? "[HIDE]" : "[SHOW]"}
                </button>
              </div>
            </div>

            {/* Repo */}
            <div style={{ marginBottom: "12px" }}>
              <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>Repository (owner/name)</div>
              <input
                type="text"
                value={cfgRepo}
                onChange={(e) => setCfgRepo(e.target.value)}
                placeholder="yourname/self-enhance"
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, width: "100%", background: "#000", border: `1px solid ${DIM_COLOR}`, color: USER_INPUT_COLOR, fontFamily: "inherit", fontSize: "inherit", padding: "4px 6px", outline: "none" }}
              />
            </div>

            {/* Toggles */}
            <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", marginBottom: "8px", color: PROMPT_COLOR, userSelect: "none" }}>
              <input type="checkbox" checked={cfgPublic} onChange={(e) => setCfgPublic(e.target.checked)} style={{ accentColor: PROMPT_COLOR }} />
              <span>Public repo (unchecked = private)</span>
            </label>
            <label style={{ display: "flex", alignItems: "flex-start", gap: "6px", cursor: "pointer", marginBottom: "12px", color: PROMPT_COLOR, userSelect: "none" }}>
              <input type="checkbox" checked={cfgAutoCreate} onChange={(e) => setCfgAutoCreate(e.target.checked)} style={{ accentColor: PROMPT_COLOR, marginTop: "2px", flexShrink: 0 }} />
              <span>
                Auto-create repo if missing
                <span style={{ color: DIM_COLOR, display: "block", fontSize: "12px", marginTop: "2px" }}>
                  Needs a classic PAT with repo scope — fine-grained PATs cannot create repos.
                </span>
              </span>
            </label>

            {/* Current target */}
            {cfgTarget?.configured && (
              <div style={{ borderTop: `1px solid ${DIM_COLOR}`, marginTop: "12px", paddingTop: "8px", marginBottom: "12px" }}>
                <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>CURRENT TARGET</div>
                <div style={{ wordBreak: "break-all" }}>
                  github.com/{cfgTarget.repo} (branch {cfgTarget.branch}{cfgTarget.createdRepo ? ", auto-created" : ""})
                </div>
                <div style={{ color: DIM_COLOR }}>
                  Last push: {cfgTarget.lastPushSha ? `commit ${cfgTarget.lastPushSha}` : "never"}
                </div>
                {cfgTarget.lastPushError && (
                  <div style={{ color: "#ff4444", marginTop: "4px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    Last error: {cfgTarget.lastPushError}
                  </div>
                )}
              </div>
            )}

            {/* Buttons */}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={submitConfig}
                disabled={cfgLoading}
                style={{ background: "#000", border: `1px solid ${DIM_COLOR}`, color: PROMPT_COLOR, fontFamily: "inherit", fontSize: "inherit", padding: "4px 10px", cursor: cfgLoading ? "wait" : "pointer", opacity: cfgLoading ? 0.5 : 1 }}
              >
                [ CONNECT &amp; PUSH ]
              </button>
              {cfgTarget?.configured && (
                <button
                  type="button"
                  onClick={disconnectTarget}
                  disabled={cfgLoading}
                  style={{ background: "#000", border: `1px solid ${DIM_COLOR}`, color: PROMPT_COLOR, fontFamily: "inherit", fontSize: "inherit", padding: "4px 10px", cursor: cfgLoading ? "wait" : "pointer", opacity: cfgLoading ? 0.5 : 1 }}
                >
                  [ DISCONNECT ]
                </button>
              )}
              <button type="button" onClick={closeConfig} style={{ background: "#000", border: `1px solid ${DIM_COLOR}`, color: PROMPT_COLOR, fontFamily: "inherit", fontSize: "inherit", padding: "4px 10px", cursor: "pointer" }}>
                [ CLOSE ]
              </button>
            </div>

            {/* Status / error */}
            {cfgStatusMsg && (
              <div style={{ color: PROMPT_COLOR, marginTop: "10px", whiteSpace: "pre-wrap" }}>{cfgStatusMsg}</div>
            )}
            {cfgError && (
              <div style={{ color: "#ff4444", marginTop: "10px", whiteSpace: "pre-wrap" }}>{cfgError}</div>
            )}

            <div style={{ color: DIM_COLOR, marginTop: "12px", fontSize: "12px", lineHeight: 1.3 }}>
              Token verified with GitHub. Token stored locally only — never in git config,
              URLs, or the pushed repo. Need a token? github.com/settings/tokens (classic PAT, repo scope).
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
