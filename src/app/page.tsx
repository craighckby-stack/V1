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

interface PushTargetInfo {
  configured: boolean;
  repo?: string;
  branch?: string;
  createdRepo?: boolean;
  lastPushAt?: string | null;
  lastPushSha?: string | null;
  lastPushError?: string | null;
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
const ERROR_COLOR = "#ff4444";

// Shared styles for the config panel (kept DOS-themed to match the terminal)
const cfgInputStyle = {
  flex: 1,
  background: "#000",
  border: `1px solid ${DIM_COLOR}`,
  color: USER_INPUT_COLOR,
  fontFamily: "inherit",
  fontSize: "inherit",
  padding: "4px 6px",
  outline: "none",
  caretColor: PROMPT_COLOR,
};
const cfgBtnStyle = {
  background: "#000",
  border: `1px solid ${DIM_COLOR}`,
  color: PROMPT_COLOR,
  fontFamily: "inherit",
  fontSize: "inherit",
  padding: "4px 10px",
  cursor: "pointer",
};

export default function Home() {
  const [status, setStatus] = useState<SelfEnhanceStatus | null>(null);
  const [pushTarget, setPushTarget] = useState<PushTargetInfo | null>(null);
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
    { type: "system", text: "Type 'help' for commands, or click [CONFIG] to set up GitHub push." },
    { type: "system", text: "" },
  ]);

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
  const [cfgTarget, setCfgTarget] = useState<PushTargetInfo | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cfgTokenRef = useRef<HTMLInputElement>(null);

  // Poll for status + push target every 2 seconds
  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const [statusRes, targetRes] = await Promise.all([
          fetch("/api/self-enhance/status"),
          fetch("/api/self-enhance/push-target"),
        ]);
        if (mounted && statusRes.ok) setStatus(await statusRes.json());
        if (mounted && targetRes.ok) setPushTarget(await targetRes.json());
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
    // Fetch the current target state for the panel
    try {
      const res = await fetch("/api/self-enhance/push-target");
      if (res.ok) {
        const t = (await res.json()) as PushTargetInfo;
        setCfgTarget(t);
        if (t.configured && t.repo) setCfgRepo(t.repo);
      }
    } catch {
      /* best-effort */
    }
    // Focus the token input after the modal renders (or the repo if already connected)
    setTimeout(() => {
      if (cfgTarget?.configured) {
        // already connected — focus the repo field for reconfiguration
      } else {
        cfgTokenRef.current?.focus();
      }
    }, 50);
  }

  function closeConfig() {
    setConfigOpen(false);
    setCfgError(null);
    setCfgStatusMsg(null);
    // Clear the sensitive token from component state on close
    setCfgToken("");
    setCfgShowToken(false);
    // Return focus to the terminal
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
        body: JSON.stringify({
          repo,
          token,
          isPublic: cfgPublic,
          createIfMissing: cfgAutoCreate,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCfgLoading(false);
        setCfgError(data.error ?? "Configuration failed");
        return;
      }
      setCfgStatusMsg(
        data.created
          ? `Created github.com/${data.repo} (private). Pushing first proof...`
          : `Connected as ${data.login}. Pushing first proof...`
      );
      // Immediately push the current state as the first proof
      try {
        const pushRes = await fetch("/api/self-enhance/push", { method: "POST" });
        const pushData = await pushRes.json();
        if (pushData.pushed) {
          emitOutput([
            `[CONFIG] Connected to github.com/${data.repo} as ${data.login}`,
            `[CONFIG] First proof push: commit ${pushData.commitSha} → github.com/${pushData.repo}`,
            `[CONFIG] Every successful self-enhancement will now push automatically.`,
          ]);
          // Refresh the panel's target view
          const fresh = await fetch("/api/self-enhance/push-target");
          if (fresh.ok) setCfgTarget(await fresh.json());
          setCfgToken("");
          setCfgShowToken(false);
          setCfgStatusMsg(`Pushed commit ${pushData.commitSha}. Connected ✓`);
        } else {
          setCfgError(`Connected, but initial push failed: ${pushData.error ?? "unknown"}`);
        }
      } catch {
        setCfgError("Connected, but initial push failed (network error). Try 'push force' from the terminal.");
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
        setCfgStatusMsg("Disconnected. The loop will commit locally only.");
        emitOutput(["[CONFIG] Push target disconnected. The loop will commit locally only."]);
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

    // Parse args from the RAW string — tokens and repo names are case-sensitive
    // (lowercasing everything would corrupt a pasted GitHub PAT).
    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case "help":
        return [
          "Available commands:",
          "  start       — Start continuous self-enhancement loop",
          "  stop        — Stop the loop",
          "  trigger     — Run one enhancement cycle",
          "  status      — Show current status",
          "  push        — Push current live state to GitHub",
          "  push <token> <owner/repo> [public] — Configure the GitHub push target",
          "                (auto-creates the repo if missing; private by default)",
          "  push force  — Force-push (overwrite a diverged remote)",
          "  push clear  — Disconnect the push target",
          "  config      — Open the Git config panel (or click [CONFIG] in header)",
          "  logs        — Show recent logs",
          "  files       — List files being enhanced",
          "  clear       — Clear the terminal",
          "  help        — Show this help",
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

      case "trigger":
      case "run": {
        try {
          const res = await fetch("/api/self-enhance/trigger", { method: "POST" });
          const data = await res.json();
          return [
            `Cycle complete: scanned ${data.filesScanned ?? 0}, enhanced ${data.filesEnhanced ?? 0}`,
          ];
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "status": {
        const s = status;
        if (!s) return ["No status available yet"];
        const lines = [
          `Running:       ${s.running ? "YES" : "NO"}`,
          `Files scanned: ${s.stats.totalScanned}`,
          `Files enhanced: ${s.stats.totalEnhanced}`,
          `Files reverted: ${s.stats.totalReverted}`,
          `Tests pinned:   ${s.stats.testsWritten}`,
          `Pushes to git:  ${s.stats.totalPushed}`,
          `Last enhanced:  ${s.stats.lastEnhancementAt ?? "never"}`,
          `Current file:   ${s.currentFile ?? "idle"}`,
        ];
        const t = pushTarget;
        if (t?.configured) {
          lines.push(
            `Push target:    github.com/${t.repo} (branch ${t.branch}${t.createdRepo ? ", auto-created" : ""})`,
            `Last push:      ${t.lastPushSha ? `commit ${t.lastPushSha}` : "never"}${t.lastPushAt ? ` at ${t.lastPushAt}` : ""}`
          );
          if (t.lastPushError) lines.push(`Last error:     ${t.lastPushError}`);
        } else {
          lines.push("Push target:    NOT CONFIGURED (click [CONFIG] or run 'config')");
        }
        return lines;
      }

      case "push": {
        const sub = parts[1]; // raw (case-preserved) subcommand/arg

        // push force — overwrite a diverged remote
        if (sub && sub.toLowerCase() === "force") {
          try {
            const res = await fetch("/api/self-enhance/push", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ force: true }),
            });
            const data = await res.json();
            if (data.pushed) return [`Force-pushed to GitHub: commit ${data.commitSha} (${data.repo})`];
            return [`Force-push failed: ${data.error ?? "unknown error"}`];
          } catch (e) {
            return [`Error: ${(e as Error).message}`];
          }
        }

        // push clear — disconnect the target
        if (sub && sub.toLowerCase() === "clear") {
          try {
            const res = await fetch("/api/self-enhance/push-target", { method: "DELETE" });
            const data = await res.json();
            return data.ok ? ["Push target cleared — the loop will commit locally only"] : [`Failed: ${data.error}`];
          } catch (e) {
            return [`Error: ${(e as Error).message}`];
          }
        }

        // push <token> <owner/repo> [public] — configure the target
        if (parts.length >= 3) {
          const token = parts[1];
          const repo = parts[2];
          const isPublic = (parts[3] ?? "").toLowerCase() === "public";
          try {
            const res = await fetch("/api/self-enhance/push-target", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ repo, token, isPublic }),
            });
            const data = await res.json();
            if (!data.ok) return [`Configuration failed: ${data.error}`];
            const lines = [
              data.created
                ? `Created repo github.com/${data.repo} (private) — push target configured`
                : `Connected to github.com/${data.repo} as ${data.login}`,
              "Token verified. Pushing current live state...",
            ];
            // Immediately push the current state as the first proof
            try {
              const pushRes = await fetch("/api/self-enhance/push", { method: "POST" });
              const pushData = await pushRes.json();
              if (pushData.pushed) {
                lines.push(`Pushed: commit ${pushData.commitSha} → github.com/${pushData.repo}`);
                lines.push("Every successful self-enhancement will now be pushed automatically.");
              } else {
                lines.push(`Initial push failed: ${pushData.error ?? "unknown"}`);
              }
            } catch {
              lines.push("Initial push failed — check 'push force' if the remote diverged");
            }
            return lines;
          } catch (e) {
            return [`Error: ${(e as Error).message}`];
          }
        }

        // plain push — push to the configured target
        try {
          const cfg = pushTarget;
          if (!cfg?.configured) {
            return [
              "No push target configured.",
              "Click [CONFIG] in the header, or run: push <github_token> <owner/repo> [public]",
              "Example: push ghp_xxxxxxxxxxxx yourname/self-enhance",
              "",
              "The repo is auto-created if it doesn't exist (private by default;",
              "add 'public' to make it public). The token needs repo scope.",
              "Get one at github.com/settings/tokens",
            ];
          }
          const res = await fetch("/api/self-enhance/push", { method: "POST" });
          const data = await res.json();
          if (data.pushed) return [`Pushed to GitHub: commit ${data.commitSha} (${data.repo})`];
          return [`Push failed: ${data.error ?? "unknown error"}`];
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "config":
      case "cfg": {
        openConfig();
        return ["Opening Git config panel... (or click [CONFIG] in the header)"];
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
          "  autonomous/ — loop-runtime, self-enhance-loop, loop-event-bus, push-target",
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

      case "about":
        return [
          "Architecture Helper Pipeline v4.3",
          "Self-enhancing autonomous refactoring system",
          "The system modifies its own source code in src/lib/pipeline/,",
          "verifies with tsc --noEmit, and pushes to GitHub as proof.",
          "What you see on GitHub IS the current live state of the server.",
          "",
          "Click [CONFIG] in the header to connect a GitHub push target.",
        ];

      default:
        return [`Unknown command: ${command}. Type 'help' for available commands.`];
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cmd = input;
    setInput("");
    if (!cmd.trim()) return;

    // Echo the command to the terminal — mask any pasted GitHub token
    const masked = cmd.replace(
      /\b(ghp_|github_pat_|gho_|ghu_|ghr_|ghs_)[A-Za-z0-9_]+/g,
      "$1****"
    );
    setTerminalLines((prev) => [...prev, { type: "command", text: masked }]);

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
  const connected = pushTarget?.configured ?? false;

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
              scanned={s.totalScanned} enhanced={s.totalEnhanced} pinned={s.testsWritten} reverted={s.totalReverted} pushed={s.totalPushed}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <span
            style={{ color: connected ? PROMPT_COLOR : DIM_COLOR }}
            aria-label={connected ? "Git push target connected" : "Git push target not configured"}
          >
            [GIT: {connected ? "ON" : "OFF"}]
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openConfig();
            }}
            aria-label="Open Git push configuration"
            style={cfgBtnStyle}
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

        {/* Terminal lines (bottom — boot sequence + command output) */}
        {/* Rendered AFTER logs so command output stays at the bottom and is
            always visible after auto-scroll. New server logs push older
            terminal lines up, but the latest command output stays visible. */}
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
            <div
              id="cfg-title"
              style={{
                fontWeight: "bold",
                borderBottom: `1px solid ${DIM_COLOR}`,
                paddingBottom: "8px",
                marginBottom: "12px",
                whiteSpace: "pre",
                overflow: "hidden",
              }}
            >
              ┌─ GIT CONFIG ──────────────────────────────┐
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
                  style={cfgInputStyle}
                />
                <button
                  type="button"
                  onClick={() => setCfgShowToken((v) => !v)}
                  style={cfgBtnStyle}
                >
                  {cfgShowToken ? "[HIDE]" : "[SHOW]"}
                </button>
              </div>
            </div>

            {/* Repo */}
            <div style={{ marginBottom: "12px" }}>
              <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>
                Repository (owner/name)
              </div>
              <input
                type="text"
                value={cfgRepo}
                onChange={(e) => setCfgRepo(e.target.value)}
                placeholder="yourname/self-enhance"
                autoComplete="off"
                spellCheck={false}
                style={cfgInputStyle}
              />
            </div>

            {/* Public toggle */}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                cursor: "pointer",
                marginBottom: "8px",
                color: PROMPT_COLOR,
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={cfgPublic}
                onChange={(e) => setCfgPublic(e.target.checked)}
                style={{ accentColor: PROMPT_COLOR }}
              />
              <span>Public repo (unchecked = private)</span>
            </label>

            {/* Auto-create toggle */}
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "6px",
                cursor: "pointer",
                marginBottom: "12px",
                color: PROMPT_COLOR,
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={cfgAutoCreate}
                onChange={(e) => setCfgAutoCreate(e.target.checked)}
                style={{ accentColor: PROMPT_COLOR, marginTop: "2px", flexShrink: 0 }}
              />
              <span>
                Auto-create repo if missing
                <span style={{ color: DIM_COLOR, display: "block", fontSize: "12px", marginTop: "2px" }}>
                  Creates {`{owner}/{name}`} under the token's account (or an org you
                  administer). Needs a classic PAT with repo scope — fine-grained PATs
                  cannot create repos.
                </span>
              </span>
            </label>

            {/* Current target status */}
            {cfgTarget?.configured && (
              <div
                style={{
                  borderTop: `1px solid ${DIM_COLOR}`,
                  marginTop: "12px",
                  paddingTop: "8px",
                  marginBottom: "12px",
                }}
              >
                <div style={{ color: DIM_COLOR, marginBottom: "4px" }}>CURRENT TARGET</div>
                <div style={{ wordBreak: "break-all" }}>
                  github.com/{cfgTarget.repo} (branch {cfgTarget.branch}
                  {cfgTarget.createdRepo ? ", auto-created" : ""})
                </div>
                <div style={{ color: DIM_COLOR }}>
                  Last push:{" "}
                  {cfgTarget.lastPushSha ? `commit ${cfgTarget.lastPushSha}` : "never"}
                  {cfgTarget.lastPushAt ? ` at ${cfgTarget.lastPushAt}` : ""}
                </div>
                {cfgTarget.lastPushError && (
                  <div style={{ color: ERROR_COLOR, marginTop: "4px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    Last error: {cfgTarget.lastPushError}
                  </div>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={submitConfig}
                disabled={cfgLoading}
                style={{
                  ...cfgBtnStyle,
                  opacity: cfgLoading ? 0.5 : 1,
                  cursor: cfgLoading ? "wait" : "pointer",
                }}
              >
                [ CONNECT &amp; PUSH ]
              </button>
              {cfgTarget?.configured && (
                <button
                  type="button"
                  onClick={disconnectTarget}
                  disabled={cfgLoading}
                  style={{
                    ...cfgBtnStyle,
                    opacity: cfgLoading ? 0.5 : 1,
                    cursor: cfgLoading ? "wait" : "pointer",
                  }}
                >
                  [ DISCONNECT ]
                </button>
              )}
              <button type="button" onClick={closeConfig} style={cfgBtnStyle}>
                [ CLOSE ]
              </button>
            </div>

            {/* Status / error */}
            {cfgStatusMsg && (
              <div style={{ color: PROMPT_COLOR, marginTop: "10px", whiteSpace: "pre-wrap" }}>
                {cfgStatusMsg}
              </div>
            )}
            {cfgError && (
              <div style={{ color: ERROR_COLOR, marginTop: "10px", whiteSpace: "pre-wrap" }}>
                {cfgError}
              </div>
            )}

            {/* Footer hint */}
            <div style={{ color: DIM_COLOR, marginTop: "12px", fontSize: "12px", lineHeight: 1.3 }}>
              Token verified with GitHub.{" "}
              {cfgAutoCreate
                ? "Repo auto-created if missing (private unless Public checked). For org repos, the token must administer that org."
                : "Repo must already exist — connect only, no creation."}
              {" "}Token stored locally only — never in git config, URLs, or the pushed
              repo. Need a token? github.com/settings/tokens (classic PAT, repo scope).
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
