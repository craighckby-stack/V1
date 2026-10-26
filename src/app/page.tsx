"use client";

import { useEffect, useRef, useState } from "react";

interface LogEntry {
  timestamp: string;
  message: string;
  type: "info" | "success" | "warn" | "error";
}

interface QueueStats {
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  skipped: number;
  lastScanAt: string | null;
}

interface SelfTask {
  id: string;
  kind: string;
  filePath: string;
  line: number;
  evidence: string;
  status: string;
  attempts: number;
  deferred: number;
  fixSummary?: string | null;
  commitSha?: string | null;
}

interface SelfEnhanceStatus {
  running: boolean;
  stats: {
    tasksGenerated: number;
    tasksDone: number;
    tasksFailed: number;
    tasksDeferred: number;
    tasksNoop: number;
    totalPushed: number;
    lastEnhancementAt: string | null;
    startedAt: string | null;
    cyclesSinceClaim: number;
    lastClaimAt: string | null;
  };
  logs: LogEntry[];
  currentTask: { kind: string; filePath: string; line: number } | null;
  queue: QueueStats | null;
  inputMode: string;
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

const METHOD_LABEL: Record<string, string> = {
  "todo-comment": "LLM",
  "empty-catch": "LLM",
  "any-usage": "LLM",
  "missing-return-type": "DET", // deterministic — runs even during 429
  "magic-number": "LLM",
  "non-null-assertion": "LLM",
};

export default function Home() {
  const [status, setStatus] = useState<SelfEnhanceStatus | null>(null);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [terminalLines, setTerminalLines] = useState<
    Array<{ type: "system" | "command" | "output"; text: string }>
  >([
    { type: "system", text: "ARCHITECTURE HELPER PIPELINE v4.4 — SELF-ENHANCE MODE" },
    { type: "system", text: "(c) 2026 Z.ai Code — Autonomous Self-Modifying System" },
    { type: "system", text: "" },
    { type: "system", text: "INPUT: SYSTEM-DEFINED" },
    { type: "system", text: "  The system scans its own source with the TypeScript" },
    { type: "system", text: "  compiler API and derives its own task queue. No user" },
    { type: "system", text: "  goals. No prompts. The queue IS the input." },
    { type: "system", text: "" },
    { type: "system", text: "Verification: in-memory typecheck before every write" },
    { type: "system", text: "Proof: git push of current live state on each fix" },
    { type: "system", text: "" },
    { type: "system", text: "Type 'help' for commands. Type 'tasks' to see the queue." },
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
  const [cfgTarget, setCfgTarget] = useState<{ configured: boolean; repo?: string; branch?: string; createdRepo?: boolean; lastPushSha?: string | null; lastPushAt?: string | null; lastPushError?: string | null } | null>(null);
  const [pushTarget, setPushTarget] = useState<{ configured: boolean; repo?: string } | null>(null);
  const [cmdBusy, setCmdBusy] = useState(false);
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
    const command = lower.split(/\s+/)[0];

    switch (command) {
      case "help":
        return [
          "Available commands:",
          "  start       — Start continuous self-enhancement loop",
          "  stop        — Stop the loop",
          "  trigger     — Run one cycle (scan queue + execute next tasks)",
          "  tasks       — Show the system-defined task queue",
          "  rescan      — Force re-scan of own source (re-define input)",
          "  skip        — Veto the next pending task (user's only input power)",
          "  status      — Show current status",
          "  push        — Push current live state to GitHub",
          "  config      — Open Git config panel",
          "  logs        — Show recent logs",
          "  clear       — Clear the terminal",
          "  help        — Show this help",
          "",
          "INPUT IS SYSTEM-DEFINED:",
          "  The system scans its own source code and generates its own",
          "  task queue (TODOs, any-types, empty catches, magic numbers,",
          "  missing return types, non-null assertions). You do not feed",
          "  it goals. Your only power over the input is 'skip' (veto).",
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
        setCmdBusy(true);
        try {
          const res = await fetch("/api/self-enhance/trigger", { method: "POST" });
          const data = await res.json();
          const lines = [`Cycle complete: ${data.processed ?? 0} task(s) processed.`];
          for (const r of data.results ?? []) {
            const tag =
              r.status === "applied" ? "✓ FIXED" :
              r.status === "deferred" ? "… DEFERRED (LLM 429)" :
              r.status === "failed" ? "✗ FAILED" : "· NO-OP";
            lines.push(`  ${tag} [${r.kind}] ${r.filePath}:${r.line}${r.status === "applied" && r.pushed ? ` — pushed ${r.commitSha}` : ""}`);
          }
          return lines;
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        } finally {
          setCmdBusy(false);
        }
      }

      case "tasks":
      case "queue": {
        setCmdBusy(true);
        try {
          const res = await fetch("/api/self-enhance/tasks?status=pending&limit=15");
          const data = await res.json();
          const q = data.queue as QueueStats | undefined;
          const header = [
            `QUEUE — pending=${q?.pending ?? 0} in-progress=${q?.in_progress ?? 0} done=${q?.done ?? 0} failed=${q?.failed ?? 0} skipped=${q?.skipped ?? 0}`,
            `Last input scan: ${q?.lastScanAt ?? "not yet (runs when queue empties or via 'rescan')"}`,
            "",
          ];
          const tasks = (data.tasks ?? []) as SelfTask[];
          if (tasks.length === 0) {
            return [...header, "  (no pending tasks — run 'rescan' to define new input)"];
          }
          return [
            ...header,
            ...tasks.map(
              (t) =>
                `  [P${t.kind === "todo-comment" ? 1 : t.kind === "empty-catch" ? 2 : t.kind === "any-usage" ? 3 : t.kind === "missing-return-type" ? 4 : t.kind === "magic-number" ? 5 : 6}/${METHOD_LABEL[t.kind] ?? "?"}] ${t.kind} — ${t.filePath}:${t.line}`
            ),
            "",
            `  (${tasks.length} shown${q && q.pending > tasks.length ? `, ${q.pending - tasks.length} more pending` : ""})`,
          ];
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        } finally {
          setCmdBusy(false);
        }
      }

      case "rescan": {
        setCmdBusy(true);
        try {
          const res = await fetch("/api/self-enhance/rescan", { method: "POST" });
          const data = await res.json();
          return [
            `Input re-defined by system scan:`,
            `  files analyzed: ${data.filesAnalyzed}`,
            `  findings:       ${data.findings}`,
            `  new tasks:      ${data.newTasks}`,
            `  already known:  ${data.alreadyQueued}`,
          ];
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        } finally {
          setCmdBusy(false);
        }
      }

      case "skip":
      case "veto": {
        try {
          const res = await fetch("/api/self-enhance/skip", { method: "POST" });
          const data = await res.json();
          if (data.skipped) {
            return [`Vetoed: [${data.kind}] ${data.filePath}:${data.line} — task marked skipped`];
          }
          return ["Nothing to veto — queue is empty."];
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "status": {
        const s = status;
        if (!s) return ["No status available yet"];
        const q = s.queue;
        return [
          `Running:         ${s.running ? "YES" : "NO"}`,
          `Input mode:      ${s.inputMode ?? "system-defined"} (system scans own source)`,
          `Queue:           pending=${q?.pending ?? 0} in-progress=${q?.in_progress ?? 0} done=${q?.done ?? 0} failed=${q?.failed ?? 0} skipped=${q?.skipped ?? 0}`,
          `Current task:    ${s.currentTask ? `[${s.currentTask.kind}] ${s.currentTask.filePath}:${s.currentTask.line}` : "idle"}`,
          `Tasks generated: ${s.stats.tasksGenerated}`,
          `Tasks done:      ${s.stats.tasksDone}`,
          `Tasks failed:    ${s.stats.tasksFailed}`,
          `Deferred (429):  ${s.stats.tasksDeferred}`,
          `Pushes to git:   ${s.stats.totalPushed}`,
          `Last fix:        ${s.stats.lastEnhancementAt ?? "never"}`,
          `Liveness:        ${s.stats.cyclesSinceClaim ?? 0} idle cycle(s) since last claim (${s.stats.lastClaimAt ?? "never"})${(s.stats.cyclesSinceClaim ?? 0) >= 5 ? " — WARN: possible stall" : ""}`,
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

      case "clear":
      case "cls": {
        setTerminalLines([]);
        return [""];
      }

      case "exit":
      case "quit":
        return ["Cannot exit — the system runs continuously. Use 'stop' to halt enhancement."];

      case "about":
        return [
          "Architecture Helper Pipeline v4.4",
          "Self-enhancing autonomous system with SYSTEM-DEFINED INPUT.",
          "",
          "The system scans its own source (src/lib/pipeline/) with the",
          "TypeScript compiler API and derives a task queue: TODOs, any",
          "types, empty catches, magic numbers, missing return types,",
          "non-null assertions. It executes tasks one by one — deterministic",
          "fixes run even when the LLM API is rate-limited; LLM fixes are",
          "focused single-issue prompts. Every fix is verified in memory",
          "before it touches disk, then pushed to GitHub as proof.",
          "",
          "What you see on GitHub IS the current live state of the server.",
        ];

      default: {
        // Not a command — the system does not accept user goals.
        return [
          `'${trimmed}' is not a command.`,
          "",
          "INPUT IS SYSTEM-DEFINED: this system does not take goals from",
          "users. It scans its own source and generates its own task queue.",
          "",
          "Type 'tasks' to see the queue, 'rescan' to re-define the input,",
          "or 'skip' to veto the next task. Type 'help' for all commands.",
        ];
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
  const q = status?.queue;
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
            ARCHITECTURE HELPER PIPELINE v4.4 — SELF-ENHANCE MODE
          </span>
          <span style={{ color: DIM_COLOR, marginLeft: "16px" }}>─┐</span>
          <span style={{ color: DIM_COLOR, marginLeft: "16px" }}>│</span>
          <span style={{ marginLeft: "8px", color: running ? "#00ff00" : "#ff4444" }}>
            [{running ? "ENHANCING" : "IDLE"}]
          </span>
          <span style={{ color: DIM_COLOR, marginLeft: "16px" }}>INPUT: SYSTEM-DEFINED</span>
          {q && (
            <span style={{ color: DIM_COLOR, marginLeft: "16px" }}>
              queue={q.pending + q.in_progress} done={q.done} failed={q.failed}
            </span>
          )}
          {s && s.totalPushed > 0 && (
            <span style={{ color: DIM_COLOR, marginLeft: "16px" }}>pushed={s.totalPushed}</span>
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
        {cmdBusy && (
          <div style={{ color: DIM_COLOR }}>working...</div>
        )}
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
            aria-label="Terminal command input"
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
