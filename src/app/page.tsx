"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ConsoleStream, type ConsoleLine } from "./display/console-stream";
import { OraclePanel } from "@/components/pipeline/oracle-panel";
import { DefensePanel } from "@/components/pipeline/defense-panel";

interface LogEntry {
  timestamp: string;
  message: string;
  type: "info" | "success" | "warn" | "error";
}

interface LlmGate {
  active: boolean;
  remainingMs: number;
  endsAtMs: number;
  level: number; // 1=2min, 2=5min, 3=15min, 4=30min escalation
}

/** Per-file saturation state (phase 1: lockout-on-stable). Keyed by
 *  repo-relative file path. A file is `lockedOut` after
 *  SATURATION_THRESHOLD (3) consecutive no-growth cycles. The UI shows
 *  a [unlock] button for locked files and "PASS COMPLETE" when all
 *  eligible files are locked. */
interface FileSaturation {
  consecutiveNoGrowth: number;
  lockedOut: boolean;
  lockedAt: string | null;
  lastNoGrowthReason: string | null;
  enhancementsThisPass: number;
}
type SaturationMap = Record<string, FileSaturation>;

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
  saturation?: SaturationMap;
  llmGate?: LlmGate;
}

interface PushTargetInfo {
  configured: boolean;
  repo?: string;
  branch?: string;
  createdRepo?: boolean;
  lastPushAt?: string | null;
  lastPushSha?: string | null;
  lastPushError?: string | null;
  lastBranchNumber?: number;
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

// Color system — simplified to the extreme:
//   red   = errors only
//   white = everything else (all logs, boot, commands, output, header, buttons)
// No green, no yellow. Red is the single alarm color.
const COLOR_MAP: Record<LogEntry["type"], string> = {
  info: "#e0e0e0",
  success: "#e0e0e0",
  warn: "#e0e0e0",
  error: "#ff4444",
};

const PROMPT_COLOR = "#e0e0e0";
const TEXT_COLOR = "#e0e0e0";
const DIM_COLOR = "#777777";
const USER_INPUT_COLOR = "#ffffff";
const ERROR_COLOR = "#ff4444";
const WARN_COLOR = "#ffaa33"; // LLM cooldown countdown + other warn-state chips
const OK_COLOR = "#44dd88"; // hot-swap indicator when swaps have happened

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
  // NOTE: ConsoleLine type is imported from ./display/console-stream (the
  // mutable display layer). page.tsx owns the STATE (consoleLines) but the
  // RENDERING is delegated to the display component, which the loop can
  // refactor freely. The boundary: page.tsx = control surface (protected),
  // display/ = presentation (mutable).
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([
    { id: "boot-0", type: "system", text: "(c) 2026 craighckby-stack" },
    { id: "boot-1", type: "system", text: "" },
    { id: "boot-2", type: "system", text: "Type 'help' for commands." },
    { id: "boot-3", type: "system", text: "" },
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

  // Oracle panel state — the system's prophecy/evaluation subsystem.
  // open/close is the only state page.tsx owns; the panel manages its
  // own polling, fetch, and rendering internally (see OraclePanel).
  const [oracleOpen, setOracleOpen] = useState(false);
  // Defense panel: duress/safe-mode + red-team + secret-scan. The panel
  // owns its own polling like OraclePanel. See docs/CONCEPTS-GRAFTED.md.
  const [defenseOpen, setDefenseOpen] = useState(false);
  // Hot-swap indicator — shows the running pipeline fingerprint + swap
  // count next to [START], so the operator can see the system is live-
  //   swapping its own code. Polled alongside the self-enhance status.
  const [hotSwapStatus, setHotSwapStatus] = useState<{
    swapCount: number;
    runningFingerprint: string;
  } | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cfgTokenRef = useRef<HTMLInputElement>(null);
  const cfgRepoRef = useRef<HTMLInputElement>(null);
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
        const [statusRes, targetRes, hotSwapRes] = await Promise.all([
          fetch("/api/self-enhance/status"),
          fetch("/api/self-enhance/push-target"),
          fetch("/api/hot-swap/status"),
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
        if (mounted && hotSwapRes.ok) {
          const hs = await hotSwapRes.json();
          setHotSwapStatus({
            swapCount: hs.swapCount ?? 0,
            runningFingerprint: hs.runningFingerprint ?? "?",
          });
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

  // LLM cooldown countdown: tick every second WHILE the gate is active so
  // the header chip counts down smoothly between the 2s status polls. The
  // countdown anchors on `llmGate.endsAtMs` (server epoch), so clock skew
  // between polls self-corrects — each poll re-anchors, the tick just fills
  // the gap. When the gate is inactive the interval is cleared (no idle
  // re-renders).
  const gateActive = status?.llmGate?.active ?? false;
  const gateEndsAt = status?.llmGate?.endsAtMs ?? 0;
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!gateActive) return;
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [gateActive]);
  const gateRemainingMs = gateActive ? Math.max(0, gateEndsAt - nowTick) : 0;
  /** MM:SS (or H:MM:SS past an hour — the max escalation is 30min, but be
   *  robust if the provider ever sends a huge Retry-After). */
  const gateCountdown = useMemo(() => {
    const totalSec = Math.ceil(gateRemainingMs / 1000);
    if (totalSec <= 0) return "00:00";
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }, [gateRemainingMs]);

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

  // Poll oracle events every 5s — background oracle activity (auto
  // prophecies after each cycle, scheduler verdicts every 5 min)
  // surfaces in the unified console stream, the same way loop logs do.
  // Uses the same timestamp|message dedup as loop logs so a re-sent
  // event never double-renders. The cursor (`since`) starts undefined;
  // the first response sets it, and subsequent polls fetch only fresh
  // appends (plus client-side dedup as a belt-and-braces guard).
  useEffect(() => {
    let mounted = true;
    let cursor: number | undefined;

    async function pollOracleEvents() {
      try {
        const url = cursor === undefined ? "/api/oracle/events" : `/api/oracle/events?since=${cursor}`;
        const res = await fetch(url);
        if (!mounted || !res.ok) return;
        const data = (await res.json()) as {
          events: Array<{ timestamp: string; message: string; type: string; source: string }>;
          seq: number;
        };
        cursor = data.seq;
        if ((data.events ?? []).length === 0) return;
        // Dedup against what the unified stream already holds.
        const fresh = data.events.filter(
          (e) => !seenLogKeys.current.has(`oracle|${e.timestamp}|${e.message}`)
        );
        if (fresh.length === 0) return;
        for (const e of fresh) seenLogKeys.current.add(`oracle|${e.timestamp}|${e.message}`);
        setConsoleLines((prev) => [
          ...prev,
          ...fresh.map((e) => ({
            id: nextId(),
            type: "log" as const,
            text: `[${e.source}] ${e.message}`,
            ts: e.timestamp,
            logType: (e.type === "success" ? "success" : e.type === "error" ? "error" : e.type === "warn" ? "warn" : "info") as LogEntry["type"],
          })),
        ]);
      } catch {
        // ignore — next poll will retry
      }
    }

    pollOracleEvents();
    const interval = setInterval(pollOracleEvents, 5000);

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
    // Focus the most useful field after the modal renders: token when
    // configuring fresh, repo when reconfiguring an existing connection
    // (the old code had an empty branch here — a comment promising focus
    // that never happened).
    setTimeout(() => {
      if (cfgTarget?.configured) {
        cfgRepoRef.current?.focus();
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

  /** Unlock a saturated file so the loop re-evaluates it next cycle.
   *  Resets its no-growth counter — a fresh start. The user clicks this
   *  in the saturation panel when they've reviewed a locked file and
   *  want the loop to take another pass at it. */
  async function unlockFile(filePath: string) {
    try {
      const res = await fetch("/api/self-enhance/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
      });
      const data = await res.json();
      if (data.ok) {
        // Refresh status so the panel updates immediately
        const sres = await fetch("/api/self-enhance/status");
        if (sres.ok) setStatus(await sres.json());
      }
    } catch {
      /* best-effort — the next poll will catch up */
    }
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
          "  oracle      — Oracle subsystem: the system's own predictions",
          "  oracle prophecy — Make one prophecy (LLM, grounded in history)",
          "  oracle judge    — Evaluate all due prophecies now",
          "  oracle list     — List recent prophecies + verdicts",
          "  oracle status   — Track record: counts, calibration, Brier score",
          "  clear       — Clear the terminal",
          "  help        — Show this help",
          "",
        ];

      case "start": {
        try {
          const res = await fetch("/api/self-enhance/start", { method: "POST" });
          const data = await res.json();
          // Immediately fetch fresh status + queue so the user sees the
          // system's live state the moment it starts — not just "Started".
          const [sres, qres] = await Promise.all([
            fetch("/api/self-enhance/status"),
            fetch("/api/self-enhance/tasks?limit=1"),
          ]);
          const st = sres.ok ? ((await sres.json()) as SelfEnhanceStatus) : null;
          const q = qres.ok ? ((await qres.json()) as { queue: QueueCounts }).queue : null;
          if (st) setStatus(st);
          if (q) setQueue(q);

          const stats = st?.stats;
          const alreadyRunning = data.alreadyRunning === true;
          const lines = [
            alreadyRunning ? "LOOP IS ALREADY RUNNING — live activity:" : "LOOP STARTED — watch it work:",
            "",
            `  Running:          YES`,
            `  Cycles completed: ${stats?.cyclesCompleted ?? 0}`,
            `  Files scanned:    ${stats?.totalScanned ?? 0} (cumulative across cycles)`,
            `  Files enhanced:   ${stats?.totalEnhanced ?? 0}`,
            `  Tests pinned:     ${stats?.testsWritten ?? 0} (ratchet)`,
            `  Reverted by gate: ${stats?.totalReverted ?? 0}`,
            `  Pushed to git:    ${stats?.totalPushed ?? 0}`,
            `  Current file:     ${st?.currentFile ?? "(starting first cycle...)"}`,
            `  Task queue:        ${q ? `${q.pending} pending / ${q.done} done / ${q.failed} failed / ${q.skipped} skipped` : "?"}`,
          ];
          // Show the last few meaningful gate verdicts from the log buffer
          const recentLogs = (st?.logs ?? []).slice(-6).reverse();
          if (recentLogs.length > 0) {
            lines.push("", "  Recent activity (newest first):");
            for (const l of recentLogs) {
              const msg = l.message.length > 72 ? `${l.message.slice(0, 71)}…` : l.message;
              lines.push(`    [${l.timestamp}] ${msg}`);
            }
          }
          lines.push(
            "",
            "The loop is now cycling in the background. Real-time activity streams below:",
            "  scan → ratchet (pin tests) → enhance (LLM) → structural gate → typecheck → debate → test → write → push",
            ""
          );
          return lines;
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
          const nextN = (t.lastBranchNumber ?? 0) + 1;
          const nextBranch = `loop-${String(nextN).padStart(2, "0")}`;
          lines.push(
            `Push target:    github.com/${t.repo} (seed: ${t.branch})`,
            `Mutations:      ${t.lastBranchNumber ?? 0} pushed — next will be ${nextBranch}`,
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

      case "oracle": {
        const sub = (parts[1] ?? "").toLowerCase();
        try {
          // No subcommand — summary view (same as 'oracle status' but
          // with a usage hint when the arg is unrecognized).
          if (sub === "" || sub === "status") {
            const [sres, schres] = await Promise.all([
              fetch("/api/oracle/status"),
              fetch("/api/oracle/events?since=0"),
            ]);
            const s = sres.ok ? await sres.json() : null;
            // Scheduler status comes through the events ring — find the
            // most recent scheduler-booted event for a one-line summary.
            const ev = schres.ok ? await schres.json() : null;
            const booted = (ev?.events ?? []).some(
              (e: { message?: string }) => (e.message ?? "").startsWith("Oracle scheduler booted")
            );
            if (!s?.ok) return ["Oracle status unavailable — try again in a moment."];
            const c = s.counts;
            const lines = [
              "ORACLE — the system's prophecies about its own future",
              "",
              `  Track record:  ${c.total} total · ${c.pending} pending · ${c.fulfilled} fulfilled · ${c.failed} failed · ${c.retired} retired`,
              `  Auto-eval:     ${booted ? "running (due prophecies judged every 5 min)" : "not yet booted"}`,
            ];
            // Calibration lines — only meaningful once something is judged
            if (s.judgedCount > 0) {
              lines.push(`  Calibration:`);
              for (const cal of s.calibration ?? []) {
                lines.push(
                  `    ≥ ${Math.round(cal.threshold * 100)}%: ${
                    cal.fraction === null ? "(none yet)" : `${Math.round(cal.fraction * 100)}% fulfilled (${cal.fulfilled}/${cal.total})`
                  }`
                );
              }
              lines.push(
                `  Brier score:   ${s.brierScore?.toFixed(3) ?? "?"} (0=perfect, 0.25=random, 1=always wrong)`
              );
            } else {
              lines.push("  Calibration:   (nothing judged yet — run 'oracle judge' or wait for the scheduler)");
            }
            lines.push(
              "",
              "Subcommands: oracle prophecy | oracle judge | oracle list | oracle status",
              "Or click [ORACLE] in the header for the full panel.",
              ""
            );
            return lines;
          }

          if (sub === "prophecy" || sub === "predict") {
            emitOutput(["[ORACLE] Gathering system history, asking the LLM to predict..."]);
            const res = await fetch("/api/oracle/generate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ count: 1 }),
            });
            const data = await res.json();
            if (data.ok && data.generated?.length > 0) {
              const p = data.generated[0];
              return [
                "PROPHECY MADE:",
                `  "${p.claim}"`,
                "",
                `  confidence:    ${Math.round(p.confidence * 100)}%`,
                `  domain:        ${p.domain ?? "?"}`,
                `  judged:        ${new Date(p.evaluateBy).toISOString().slice(0, 16).replace("T", " ")} (or run 'oracle judge')`,
                "",
                `  criterion:     ${p.falsifiabilityCriterion}`,
                "",
                "The claim is stored. It will be judged against what actually happens.",
                "",
              ];
            }
            const f = data.failures?.[0];
            return [
              `Prophecy failed: ${f?.reason ?? "unknown"}`,
              `  ${f?.error ?? ""}`,
              "",
              "The Oracle never fabricates a prediction. Try again when the LLM is available.",
              "",
            ];
          }

          if (sub === "judge" || sub === "evaluate") {
            emitOutput(["[ORACLE] Judging due prophecies against what actually happened..."]);
            const res = await fetch("/api/oracle/evaluate", { method: "POST" });
            const data = await res.json();
            if (!data.ok) return [`Evaluation failed: ${data.error ?? "unknown"}`];
            if (data.judgedCount === 0 && data.skippedCount === 0) {
              return ["No prophecies are due yet — nothing to judge.", ""];
            }
            const lines = ["VERDICTS:"];
            for (const j of data.judged ?? []) {
              lines.push(`  ${String(j.verdict).toUpperCase().padEnd(9)} "${String(j.claim).slice(0, 90)}"`);
            }
            for (const sk of data.skipped ?? []) {
              lines.push(`  SKIPPED   "${String(sk.claim).slice(0, 80)}" (${sk.reason} — stays pending)`);
            }
            lines.push("", `Judged: ${data.judgedCount} · Skipped: ${data.skippedCount}`, "");
            return lines;
          }

          if (sub === "list" || sub === "ls") {
            const res = await fetch("/api/oracle/prophecies?limit=15");
            const data = await res.json();
            const list = (data.prophecies ?? []) as Array<{
              claim: string;
              status: string;
              confidence: number;
              domain: string | null;
              evaluateBy: string;
            }>;
            if (list.length === 0) {
              return ["No prophecies yet. Run 'oracle prophecy' to make the first one.", ""];
            }
            const lines = [`RECENT PROPHECIES (newest first, ${list.length}):`];
            for (const p of list) {
              const conf = `${Math.round(p.confidence * 100)}%`;
              const due = new Date(p.evaluateBy);
              const dueStr = Number.isNaN(due.getTime()) ? "?" : due.toISOString().slice(0, 16).replace("T", " ");
              lines.push(
                `  [${p.status.toUpperCase().padEnd(9)}] ${conf.padStart(4)} ${(p.domain ?? "?").padEnd(9)} due ${dueStr}`
              );
              lines.push(`    "${p.claim.slice(0, 110)}"`);
            }
            lines.push("", "");
            return lines;
          }

          return [
            `Unknown oracle subcommand: '${sub}'.`,
            "Usage: oracle [status] | oracle prophecy | oracle judge | oracle list",
            "",
          ];
        } catch (e) {
          return [`Oracle error: ${(e as Error).message}`];
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
          "LOOP — autonomous self-improving system",
          "Rewrites its own code, verifies every change",
          "(typecheck + gates + tests), pushes to git.",
          "Failures become postmortems; tests only tighten.",
          "You are the feedback: 'task <goal>' / 'skip' / 'stop'.",
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

  const running = status?.running ?? false;

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
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
          <span style={{ color: PROMPT_COLOR, fontWeight: "bold" }}>LOOP</span>
          <span
            aria-label={running ? "Loop running" : "Loop stopped"}
            title={running ? "Running" : "Stopped"}
            style={{
              color: running ? PROMPT_COLOR : DIM_COLOR,
              fontSize: "16px",
              lineHeight: 1,
              animation: running ? "loopPulse 1.6s ease-in-out infinite" : "none",
            }}
          >
            {running ? "●" : "○"}
          </span>
          {/* LLM rate-limit countdown — visible whenever the shared gate is
              active. Ticks down every second (anchored on the server's
              endsAtMs); "RESUMING…" shows in the final sub-poll window after
              the local countdown hits zero but before the next poll clears
              the chip. The loop itself is PAUSED in a stoppable wait during
              this entire window — STOP breaks it within 1s. */}
          {gateActive && (
            <span
              aria-label={`LLM rate-limited — paused, resuming in ${gateCountdown}`}
              title={
                status?.llmGate?.level
                  ? `LLM rate-limited — loop paused until quota window resets (escalation level ${status.llmGate.level}/4). STOP still works during the pause.`
                  : "LLM rate-limited — loop paused until quota window resets."
              }
              style={{
                color: WARN_COLOR,
                fontSize: "12px",
                fontFamily: "inherit",
                letterSpacing: "0.5px",
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
              }}
            >
              <span aria-hidden>⏳</span>
              {gateRemainingMs > 0 ? (
                <span>
                  LLM&nbsp;COOLDOWN&nbsp;
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{gateCountdown}</span>
                </span>
              ) : (
                <span>RESUMING…</span>
              )}
            </span>
          )}
        </div>
        <style>{`
          @keyframes loopPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.35; }
          }
        `}</style>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
          {/* Hot-swap indicator — shows the running pipeline fingerprint +
              swap count. Pulled from /api/hot-swap/status. When the swap
              count ticks up, the system just replaced its own running
              code. See docs/HOT-SWAP.md. */}
          {hotSwapStatus && (
            <span
              title={`Hot-swap: ${hotSwapStatus.swapCount} swap(s) since boot. Running pipeline fingerprint: ${hotSwapStatus.runningFingerprint}. The system replaces its own pipeline code between cycles — no restart needed.`}
              style={{
                color: hotSwapStatus.swapCount > 0 ? OK_COLOR : DIM_COLOR,
                fontSize: "0.85em",
                fontFamily: "inherit",
                padding: "2px 6px",
                border: `1px solid ${DIM_COLOR}`,
                whiteSpace: "nowrap",
              }}
            >
              ⟳{hotSwapStatus.swapCount}
            </span>
          )}
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
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOracleOpen(true);
            }}
            aria-label="Open the Oracle panel — the system's prophecies and track record"
            title="Oracle — the system predicts its own future"
            style={cfgBtnStyle}
          >
            [ORACLE]
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDefenseOpen(true);
            }}
            aria-label="Open the Defense panel — duress purge, red-team adversarial suite, secret scanner"
            title="Defense — duress · red-team · secret-scan (concepts grafted from your GitHub repos)"
            style={cfgBtnStyle}
          >
            [DEFENSE]
          </button>
        </div>
      </div>

      {/* Saturation / lockout panel (phase 1). Shows per-file no-growth
          counters and [unlock] buttons for locked files. When all
          eligible files are locked, shows "PASS COMPLETE — review &
          unlock" so the user knows the system has converged. The panel
          is only visible when there's saturation data to show (at least
          one file has been evaluated). Hidden until first cycle. */}
      {(() => {
        const sat = status?.saturation ?? {};
        const entries = Object.entries(sat);
        if (entries.length === 0) return null;
        const lockedCount = entries.filter(([, s]) => s.lockedOut).length;
        const allLocked = lockedCount === entries.length && lockedCount > 0;
        return (
          <div
            aria-label={
              allLocked
                ? "Pass complete — all files locked out, review and unlock to start a new pass"
                : `Saturation: ${lockedCount}/${entries.length} files locked out`
            }
            style={{
              borderTop: `1px solid ${allLocked ? WARN_COLOR : DIM_COLOR}`,
              borderBottom: `1px solid ${DIM_COLOR}`,
              padding: "4px 8px",
              background: "#000",
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
              fontSize: "11px",
              color: DIM_COLOR,
            }}
          >
            <span style={{ color: allLocked ? WARN_COLOR : DIM_COLOR, fontWeight: "bold" }}>
              {allLocked ? "🎯 PASS COMPLETE" : "SATURATION"}
            </span>
            {entries.map(([path, s]) => {
              const short = path.split("/").pop() ?? path;
              return (
                <span
                  key={path}
                  aria-label={`${short}: ${s.lockedOut ? "locked" : `${s.consecutiveNoGrowth}/${3} no-growth`}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    color: s.lockedOut ? WARN_COLOR : s.consecutiveNoGrowth > 0 ? PROMPT_COLOR : DIM_COLOR,
                  }}
                >
                  <span aria-hidden>{s.lockedOut ? "🔒" : "▪"}</span>
                  <span style={{ fontFamily: "inherit" }}>{short}</span>
                  {!s.lockedOut && s.consecutiveNoGrowth > 0 && (
                    <span style={{ color: DIM_COLOR, fontSize: "10px" }}>
                      ({s.consecutiveNoGrowth}/3)
                    </span>
                  )}
                  {s.lockedOut && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        unlockFile(path);
                      }}
                      aria-label={`Unlock ${short} for the next cycle`}
                      style={{
                        ...cfgBtnStyle,
                        padding: "1px 6px",
                        fontSize: "10px",
                        color: PROMPT_COLOR,
                        borderColor: PROMPT_COLOR,
                      }}
                    >
                      [unlock]
                    </button>
                  )}
                </span>
              );
            })}
            {allLocked && (
              <span style={{ color: DIM_COLOR, fontSize: "10px" }}>
                review &amp; unlock to start a new pass
              </span>
            )}
          </div>
        );
      })()}

      {/* Unified console — boot, commands, output, and live server logs all
          in one chronological stream. Rendered by the mutable display layer
          (src/app/display/console-stream.tsx). The loop can refactor the
          display component freely — colors, layout, formatting, new panels.
          page.tsx owns the state (consoleLines) and the control surface; the
          display layer only renders what it's given. */}
      <ConsoleStream lines={consoleLines} logRef={logRef} />

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
              boxShadow: "0 0 24px rgba(255, 255, 255, 0.08)",
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
              GIT CONFIG
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
                ref={cfgRepoRef}
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
                  Needs a classic PAT with repo scope.
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
            <div style={{ color: DIM_COLOR, marginTop: "12px", fontSize: "12px", lineHeight: 1.4 }}>
              Token stored locally only. Each successful enhancement pushes to its
              own branch <span style={{ color: PROMPT_COLOR }}>loop-01</span>,{" "}
              <span style={{ color: PROMPT_COLOR }}>loop-02</span>, ... — the branch
              above is the seed (loop-00).
            </div>
          </div>
        </div>
      )}

      {/* Oracle panel — the system's prophecy/evaluation subsystem.
          Renders as a modal overlay when oracleOpen is true. The panel
          manages its own polling, fetch, and rendering; page.tsx just
          owns the open/close state. */}
      <OraclePanel open={oracleOpen} onClose={() => setOracleOpen(false)} />
      <DefensePanel open={defenseOpen} onClose={() => setDefenseOpen(false)} />
    </div>
  );
}
