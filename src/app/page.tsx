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
          `Pushes to git:  ${s.stats.totalPushed}`,
          `Last enhanced:  ${s.stats.lastEnhancementAt ?? "never"}`,
          `Current file:   ${s.currentFile ?? "idle"}`,
        ];
        try {
          const res = await fetch("/api/self-enhance/push-target");
          const t = await res.json();
          if (t.configured) {
            lines.push(
              `Push target:    github.com/${t.repo} (branch ${t.branch}${t.createdRepo ? ", auto-created" : ""})`,
              `Last push:      ${t.lastPushSha ? `commit ${t.lastPushSha}` : "never"}${t.lastPushAt ? ` at ${t.lastPushAt}` : ""}`
            );
            if (t.lastPushError) lines.push(`Last error:     ${t.lastPushError}`);
          } else {
            lines.push("Push target:    NOT CONFIGURED (run: push <token> <owner/repo>)");
          }
        } catch {
          /* status is best-effort */
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
          const cfgRes = await fetch("/api/self-enhance/push-target");
          const cfg = await cfgRes.json();
          if (!cfg.configured) {
            return [
              "No push target configured.",
              "Usage:  push <github_token> <owner/repo> [public]",
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
          "",
          "Push target: configure with 'push <token> <owner/repo> [public]'.",
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
