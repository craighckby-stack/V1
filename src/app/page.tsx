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
    { type: "system", text: "Type 'help' for commands, 'start' to begin enhancing." },
    { type: "system", text: "" },
  ]);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Poll for status every 2 seconds
  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const res = await fetch("/api/self-enhance/status");
        if (res.ok) {
          const data = await res.json();
          if (mounted) setStatus(data);
        }
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

  // Auto-scroll to bottom of log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [status?.logs]);

  // Focus input on click anywhere
  useEffect(() => {
    const handler = () => inputRef.current?.focus();
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

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

      case "about":
        return [
          "Architecture Helper Pipeline v4.3",
          "Self-enhancing autonomous refactoring system",
          "The system modifies its own source code in src/lib/pipeline/,",
          "verifies with tsc --noEmit, and pushes to GitHub as proof.",
          "What you see on GitHub IS the current live state of the server.",
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
      <div style={{ borderBottom: `1px solid ${DIM_COLOR}`, paddingBottom: "4px", marginBottom: "8px", flexShrink: 0 }}>
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
        <span style={{ color: DIM_COLOR, marginLeft: "16px" }}>│</span>
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
        {/* Terminal lines (boot sequence + command output) */}
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

        {/* Server logs */}
        {logs.map((log, idx) => (
          <div key={`log-${idx}`} style={{ color: COLOR_MAP[log.type], whiteSpace: "pre-wrap" }}>
            <span style={{ color: DIM_COLOR }}>[{log.timestamp}]</span>{" "}
            {log.message}
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
    </div>
  );
}
