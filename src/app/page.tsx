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
    testsWritten: number;
    cyclesCompleted: number;
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

/** One row of the system's self-generated task queue (static analysis finding). */
interface SelfTask {
  id: string;
  kind: string;
  filePath: string;
  line: number;
  evidence: string;
  priority: number;
  status: string;
  attempts: number;
  deferred: number;
  lastError: string | null;
  fixSummary: string | null;
  commitSha: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

interface QueueCounts {
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  skipped: number;
  lastScanAt: string | null;
}

/** A proposed plan from the chat agent — nothing changes until 'task apply'. */
interface ChatTaskPlan {
  ok: boolean;
  userGoal: string;
  understanding: string;
  files: Array<{ path: string; action: "modify" | "create"; reason: string }>;
  summary: string;
  error?: string;
}

interface ChatTaskApplyResult {
  ok: boolean;
  results: Array<{
    path: string;
    applied: boolean;
    reason: string;
    diffBytes: number;
  }>;
  pushed: boolean;
  commitSha?: string;
  error?: string;
}

/** Render a proposed plan as terminal lines (shared by 'task <goal>' and 'task show'). */
function renderPlan(p: ChatTaskPlan): string[] {
  return [
    "PROPOSED PLAN (nothing has changed yet):",
    `  goal:          ${p.userGoal}`,
    `  understanding: ${p.understanding}`,
    "  files:",
    ...p.files.map((f) => `    ${f.action.padEnd(7)} ${f.path} — ${f.reason}`),
    `  summary:       ${p.summary}`,
    "",
    "Type 'task apply' to execute (each file LLM-rewritten, tsc-gated,",
    "committed and pushed as proof), or 'task deny' to discard.",
  ];
}

// Body text is soft-white for readability (was green — hard on the eyes on
// black). Green is kept only for accents: the prompt symbol, the header
// title, and genuine "success" log lines. Warn stays yellow, error stays red.
const COLOR_MAP: Record<LogEntry["type"], string> = {
  info: "#e0e0e0",
  success: "#00ff00",
  warn: "#ffff00",
  error: "#ff4444",
};

const PROMPT_COLOR = "#00ff00";
const TEXT_COLOR = "#e0e0e0";
const DIM_COLOR = "#777777";
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
  // Unified console stream — boot, commands, output, and live server logs
  // all flow in ONE chronological timeline. This fixes the "logs generate in
  // the middle" issue: previously logs rendered as a separate block ABOVE
  // the terminal section, so streaming logs appeared in the middle of the
  // screen. Now everything is one stream — new activity (command output OR
  // loop logs) always appears at the bottom near the prompt, like a real
  // terminal with a background process.
  type ConsoleLine = {
    id: string;
    type: "system" | "command" | "output" | "log";
    text: string;
    ts?: string;
    logType?: LogEntry["type"];
  };
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([
    { id: "boot-0", type: "system", text: "ARCHITECTURE HELPER PIPELINE v4.4 — SELF-ENHANCE MODE" },
    { id: "boot-1", type: "system", text: "(c) 2026 Z.ai Code — Autonomous Self-Modifying System" },
    { id: "boot-2", type: "system", text: "" },
    { id: "boot-3", type: "system", text: "Target: src/lib/pipeline/ (self-enhancement)" },
    { id: "boot-4", type: "system", text: "Mode: continuous autonomous refactoring" },
    { id: "boot-5", type: "system", text: "Input: self-generated task queue + chat goals ('task <goal>')" },
    { id: "boot-6", type: "system", text: "Verification: tsc --noEmit before every write" },
    { id: "boot-7", type: "system", text: "Proof: git push of current live state on each enhancement" },
    { id: "boot-8", type: "system", text: "" },
    { id: "boot-9", type: "system", text: "Type 'help' for commands. Header: [STOP]/[START] loop, [CLEAR] screen, [CONFIG] GitHub." },
    { id: "boot-10", type: "system", text: "" },
  ]);

  // Task engine state — queue counts (polled) + pending chat-task plan
  const [queue, setQueue] = useState<QueueCounts | null>(null);
  const [pendingPlan, setPendingPlan] = useState<ChatTaskPlan | null>(null);

  // Loop start/stop busy state (for the [STOP]/[START] header button)
  const [loopBusy, setLoopBusy] = useState(false);

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
  // Dedup set for server logs — once a log (timestamp|message) is in the
  // unified stream, it's never re-added even if it reappears in a later poll
  // (the server sends a fixed-size log buffer on every poll).
  const seenLogKeys = useRef(new Set<string>());
  const lineIdCounter = useRef(0);
  const nextId = () => `cl-${++lineIdCounter.current}`;

  // Poll for status + push target every 2 seconds
  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const [statusRes, targetRes] = await Promise.all([
          fetch("/api/self-enhance/status"),
          fetch("/api/self-enhance/push-target"),
        ]);
        if (mounted && statusRes.ok) {
          const s = (await statusRes.json()) as SelfEnhanceStatus;
          setStatus(s);
          // Diff incoming logs against what's already in the unified stream.
          // Only genuinely new logs (timestamp|message not yet seen) are
          // appended — prevents duplicates when the server re-sends its
          // fixed-size log buffer on every poll.
          const newLogs = (s.logs ?? []).filter(
            (l) => !seenLogKeys.current.has(`${l.timestamp}|${l.message}`)
          );
          if (newLogs.length > 0) {
            for (const l of newLogs) seenLogKeys.current.add(`${l.timestamp}|${l.message}`);
            setConsoleLines((prev) => [
              ...prev,
              ...newLogs.map((l) => ({
                id: nextId(),
                type: "log" as const,
                text: l.message,
                ts: l.timestamp,
                logType: l.type,
              })),
            ]);
          }
        }
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

  // Poll the task-queue counts every 5s (limit=1 keeps the payload tiny —
  // the queue stats come back regardless of the limit).
  useEffect(() => {
    let mounted = true;

    async function pollQueue() {
      try {
        const res = await fetch("/api/self-enhance/tasks?limit=1");
        if (mounted && res.ok) {
          const data = (await res.json()) as { queue: QueueCounts };
          setQueue(data.queue);
        }
      } catch {
        // ignore
      }
    }

    pollQueue();
    const interval = setInterval(pollQueue, 5000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Auto-scroll to bottom whenever the unified stream grows — whether from a
  // new command, command output, or a new server log. One stream, one scroll.
  const consoleLineCount = consoleLines.length;
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [consoleLineCount]);

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

  /** Append output lines to the unified console stream. */
  function emitOutput(lines: string[]) {
    if (lines.length === 0) return;
    setConsoleLines((prev) => [
      ...prev,
      ...lines.map((l) => ({ id: nextId(), type: "output" as const, text: l })),
    ]);
  }

  /** Clear the entire console (boot + commands + output + logs). Seen-log
   *  keys are preserved so only genuinely NEW logs reappear after clearing
   *  (the loop keeps running and its future logs still show up). */
  function clearConsole() {
    setConsoleLines([]);
    inputRef.current?.focus();
  }

  /** Start or stop the loop from the header [STOP]/[START] button. */
  async function toggleLoop() {
    setLoopBusy(true);
    try {
      const endpoint = running ? "/api/self-enhance/stop" : "/api/self-enhance/start";
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      // Refresh status immediately so the button label + ENHANCING/IDLE flip
      const sres = await fetch("/api/self-enhance/status");
      if (sres.ok) setStatus(await sres.json());
      emitOutput([
        running
          ? `[LOOP] Stopped — ${data.message ?? "self-enhancement halted"}`
          : `[LOOP] Started — ${data.message ?? "continuous self-enhancement running"}`,
      ]);
    } catch (e) {
      emitOutput([`[LOOP] Error: ${(e as Error).message}`]);
    } finally {
      setLoopBusy(false);
    }
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
          "  tasks [status] — Self-generated task queue (system-defined input)",
          "  rescan      — Re-analyze own source, queue new tasks",
          "  skip        — Veto the next pending task (user override)",
          "  task <goal> — Assign the agent a goal — it proposes a plan",
          "  task apply  — Execute the pending plan (LLM + tsc gate + push)",
          "  task deny   — Discard the pending plan",
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
        if (queue) {
          lines.push(
            `Task queue:     ${queue.pending} pending / ${queue.done} done / ${queue.failed} failed / ${queue.skipped} skipped`
          );
        }
        if (pendingPlan) {
          lines.push(
            `Pending plan:   "${pendingPlan.userGoal.slice(0, 60)}" — 'task apply' or 'task deny'`
          );
        }
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
        // Fetched LIVE from /api/self-enhance/files (scanned from disk) —
        // never a hardcoded listing, so it can't drift from reality.
        try {
          const res = await fetch("/api/self-enhance/files");
          if (!res.ok) return [`Error: files endpoint returned ${res.status}`];
          const data = (await res.json()) as {
            root: string;
            totalFiles: number;
            protectedCount: number;
            enhanceableCount: number;
            files: Array<{ path: string; protectedFile: boolean }>;
          };
          const byDir = new Map<string, string[]>();
          for (const f of data.files) {
            const parts = f.path.split("/");
            const dir = parts.slice(0, -1).join("/").replace("src/lib/pipeline/", "");
            const name = parts[parts.length - 1].replace(/\.ts$/, "");
            const label = f.protectedFile ? `${name} [protected]` : name;
            if (!byDir.has(dir)) byDir.set(dir, []);
            byDir.get(dir)!.push(label);
          }
          const lines = [
            `Self-enhancement targets (${data.root}) — scanned from disk:`,
            "",
          ];
          for (const [dir, names] of [...byDir.entries()].sort()) {
            lines.push(`  ${dir || "."}/ — ${names.join(", ")}`);
          }
          lines.push(
            "",
            `${data.totalFiles} files total: ${data.enhanceableCount} enhanceable, ${data.protectedCount} protected (the gates themselves).`
          );
          return lines;
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "tasks":
      case "queue": {
        try {
          const arg1 = (parts[1] ?? "").toLowerCase();
          const validStatuses = ["pending", "in_progress", "done", "failed", "skipped"];
          const statusFilter = validStatuses.includes(arg1) ? arg1 : undefined;
          const limitToken = parts.slice(1).find((p) => /^\d+$/.test(p));
          const limit = limitToken ? Math.min(Math.max(Number(limitToken), 1), 50) : 15;
          const params = new URLSearchParams({ limit: String(limit) });
          if (statusFilter) params.set("status", statusFilter);
          const res = await fetch(`/api/self-enhance/tasks?${params.toString()}`);
          if (!res.ok) return [`Error: tasks endpoint returned ${res.status}`];
          const data = (await res.json()) as { tasks: SelfTask[]; queue: QueueCounts };
          const q = data.queue;
          const lines = [
            "TASK QUEUE — the system's self-defined input",
            "(static analysis of src/lib/pipeline/ — deterministic, no LLM):",
            `  pending=${q.pending} in_progress=${q.in_progress} done=${q.done} failed=${q.failed} skipped=${q.skipped}`,
            "",
          ];
          if (data.tasks.length === 0) {
            lines.push(
              statusFilter
                ? `No ${statusFilter} tasks right now.`
                : "Queue is empty — run 'rescan' to analyze the source and queue tasks."
            );
          } else {
            lines.push(`${statusFilter ?? "next"} tasks (showing ${data.tasks.length}):`);
            for (const t of data.tasks) {
              const loc = `${t.filePath.replace("src/lib/pipeline/", "")}:${t.line}`;
              const ev = t.evidence.length > 58 ? `${t.evidence.slice(0, 57)}…` : t.evidence;
              lines.push(`  p${t.priority}  ${t.kind.padEnd(19)} ${loc.padEnd(40)} ${ev}`);
            }
          }
          lines.push(
            "",
            "Commands: 'rescan' re-analyzes the source, 'skip' vetoes the next",
            "pending task, 'task <goal>' assigns the agent a goal of your own.",
            ""
          );
          return lines;
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "rescan":
      case "scan": {
        emitOutput(["[RESCAN] Analyzing src/lib/pipeline with the TypeScript compiler API..."]);
        try {
          const res = await fetch("/api/self-enhance/rescan", { method: "POST" });
          const data = await res.json();
          if (!data.ok) return [`Rescan failed: ${data.error ?? "unknown error"}`];
          return [
            "Rescan complete — the system re-defined its own input:",
            `  files analyzed:   ${data.filesAnalyzed}`,
            `  findings:         ${data.findings}`,
            `  new tasks queued: ${data.newTasks}`,
            `  already queued:   ${data.alreadyQueued}`,
            `  protected files:  ${data.skippedProtected} (the gates — never self-modified)`,
          ];
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "skip":
      case "veto": {
        try {
          const res = await fetch("/api/self-enhance/skip", { method: "POST" });
          const data = (await res.json()) as {
            skipped: boolean;
            kind?: string;
            filePath?: string;
            line?: number;
          };
          if (!data.skipped) return ["No pending task to skip — the queue is empty."];
          return [
            `Vetoed: ${data.kind} at ${data.filePath?.replace("src/lib/pipeline/", "")}:${data.line} (marked skipped).`,
            "The system defines its own input — you just overrode one item of it.",
          ];
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "task": {
        // Single-token subcommands are reserved; anything longer is a goal
        // (so "task apply" is a command, but "task apply the fix to X" is a goal).
        const sub = (parts[1] ?? "").toLowerCase();
        const isSub =
          parts.length === 2 &&
          ["apply", "run", "deny", "cancel", "discard", "show", "plan"].includes(sub);
        const goal = trimmed.slice(parts[0].length).trim();

        // task apply — execute the pending plan
        if (isSub && (sub === "apply" || sub === "run")) {
          if (!pendingPlan) {
            return [
              "No plan pending. Describe a goal first:",
              "  task <what you want, in plain English>",
            ];
          }
          emitOutput([
            "[TASK] Applying the approved plan...",
            "[TASK] (per file: LLM rewrite -> brace gate -> tsc gate -> commit -> push)",
            "[TASK] (this can take a minute or two — the tsc gate alone runs ~10-30s)",
          ]);
          try {
            const res = await fetch("/api/self-enhance/chat-task/apply", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(pendingPlan),
            });
            const data = (await res.json()) as ChatTaskApplyResult;
            if (!res.ok || data.ok === false) {
              return [`Apply failed: ${data.error ?? `HTTP ${res.status}`}`];
            }
            const lines = ["PLAN RESULTS:"];
            for (const r of data.results) {
              lines.push(`  ${r.applied ? "OK  " : "FAIL"} ${r.path} — ${r.reason}`);
            }
            if (data.commitSha) lines.push(`  committed: ${data.commitSha}`);
            lines.push(`  pushed:    ${data.pushed ? "yes — GitHub holds the proof" : "no"}`);
            if (data.error) lines.push(`  note:      ${data.error}`);
            setPendingPlan(null);
            return lines;
          } catch (e) {
            return [`Error: ${(e as Error).message}`];
          }
        }

        // task deny — discard the pending plan
        if (isSub && ["deny", "cancel", "discard"].includes(sub)) {
          if (!pendingPlan) return ["No pending plan to discard."];
          const discarded = pendingPlan.userGoal;
          setPendingPlan(null);
          return [`Plan discarded: "${discarded}" — nothing was changed.`];
        }

        // task show — redisplay the pending plan / usage
        if (isSub && ["show", "plan"].includes(sub)) {
          return pendingPlan ? renderPlan(pendingPlan) : [
            "No plan pending. Usage:",
            "  task <describe a goal in plain English>  — propose a plan",
            "  task apply                               — execute the pending plan",
            "  task deny                                — discard the pending plan",
          ];
        }

        // bare 'task' — usage or pending plan
        if (!goal) {
          return pendingPlan
            ? renderPlan(pendingPlan)
            : [
                "Usage:",
                "  task <describe a goal in plain English>  — propose a plan",
                "  task apply                               — execute the pending plan",
                "  task deny                                — discard the pending plan",
                "Example: task make the sanitizer log every redaction it makes",
              ];
        }

        // task <goal> — propose a plan (the agent reads codebase context)
        emitOutput([
          `[TASK] Goal received: ${goal}`,
          "[TASK] Gathering codebase context, asking the LLM to plan...",
        ]);
        try {
          const res = await fetch("/api/self-enhance/chat-task/propose", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ goal }),
          });
          const plan = (await res.json()) as ChatTaskPlan;
          if (!plan.ok) {
            return [`Plan proposal failed: ${plan.error ?? "LLM unavailable"}`];
          }
          if (plan.files.length === 0) {
            return [
              `The LLM could not map the goal to files: ${plan.understanding}`,
              "Try describing the goal more concretely (which module, what behavior).",
            ];
          }
          setPendingPlan(plan);
          return renderPlan(plan);
        } catch (e) {
          return [`Error: ${(e as Error).message}`];
        }
      }

      case "clear":
      case "cls":
        clearConsole();
        return ["Terminal cleared."];

      case "exit":
      case "quit":
        return ["Cannot exit — the system runs continuously. Use 'stop' to halt enhancement."];

      case "about":
        return [
          "Architecture Helper Pipeline v4.4",
          "Self-enhancing autonomous refactoring system",
          "The system modifies its own source code in src/lib/pipeline/,",
          "verifies with tsc --noEmit, and pushes to GitHub as proof.",
          "What you see on GitHub IS the current live state of the server.",
          "",
          "It also defines its own input: a task queue generated by statically",
          "analyzing its own source ('tasks'). You can veto items ('skip'),",
          "or assign goals of your own ('task <goal>') — you are the feedback.",
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
    setConsoleLines((prev) => [...prev, { id: nextId(), type: "command", text: masked }]);

    // Execute and show output
    const output = await executeCommand(cmd);
    if (output && output.length > 0) {
      setConsoleLines((prev) => [
        ...prev,
        ...output.map((line) => ({ id: nextId(), type: "output" as const, text: line })),
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

  const s = status?.stats;
  const running = status?.running ?? false;
  const connected = pushTarget?.configured ?? false;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        color: TEXT_COLOR,
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
          {s && (
            <span style={{ color: DIM_COLOR, marginLeft: "16px" }}>
              scanned={s.totalScanned} enhanced={s.totalEnhanced} pinned={s.testsWritten} reverted={s.totalReverted} pushed={s.totalPushed}
              {queue ? ` tasks=${queue.pending}` : ""}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
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
              toggleLoop();
            }}
            disabled={loopBusy}
            aria-label={running ? "Stop the self-enhancement loop" : "Start the self-enhancement loop"}
            style={{
              ...cfgBtnStyle,
              opacity: loopBusy ? 0.5 : 1,
              cursor: loopBusy ? "wait" : "pointer",
              color: running ? ERROR_COLOR : PROMPT_COLOR,
            }}
          >
            [{running ? "STOP" : "START"}]
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              clearConsole();
            }}
            aria-label="Clear the terminal"
            style={cfgBtnStyle}
          >
            [CLEAR]
          </button>
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

      {/* Unified console — boot, commands, output, and live server logs all
          in one chronological stream. New activity always appears at the
          bottom near the prompt — no more "logs in the middle". */}
      <div
        ref={logRef}
        style={{
          flex: 1,
          overflowY: "auto",
          paddingRight: "4px",
        }}
      >
        {consoleLines.map((line) => {
          const color =
            line.type === "command"
              ? USER_INPUT_COLOR
              : line.type === "log"
              ? COLOR_MAP[line.logType ?? "info"]
              : TEXT_COLOR;

          return (
            <div key={line.id} style={{ color, whiteSpace: "pre-wrap" }}>
              {line.type === "command" && "> "}
              {line.type === "log" && line.ts && (
                <span style={{ color: DIM_COLOR }}>[{line.ts}] </span>
              )}
              {line.text || "\u00a0"}
            </div>
          );
        })}
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
