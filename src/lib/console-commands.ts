/**
 * Console command dispatcher (audit H1 refactor: the ~650-line switch
 * lived inside page.tsx's Home component; it is now an async function
 * over a CommandContext, testable in isolation. The Home component
 * keeps only the echo/masking and the status re-poll.
 *
 * Contract: returns the lines to print (or void for none).
 * Types moved here from page.tsx: SelfEnhanceStatus / QueueCounts /
 * ChatTaskPlan (page re-imports them — they were page-local before).
 */

"use client";

export interface LogEntry {
  timestamp: string;
  message: string;
  type: "info" | "success" | "warn" | "error";
}

export interface LlmGate {
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
export interface FileSaturation {
  consecutiveNoGrowth: number;
  lockedOut: boolean;
  lockedAt: string | null;
  lastNoGrowthReason: string | null;
  enhancementsThisPass: number;
}
export type SaturationMap = Record<string, FileSaturation>;

export interface PushTargetInfo {
  configured: boolean;
  repo?: string;
  branch?: string;
  createdRepo?: boolean;
  lastPushAt?: string | null;
  lastPushSha?: string | null;
  lastPushError?: string | null;
  lastBranchNumber?: number;
}

export interface SelfTask {
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

export interface ChatTaskApplyResult {
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

export function renderPlan(p: ChatTaskPlan): string[] {
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

export interface SelfEnhanceStatus {
  running: boolean;
  /** Cripple-check F8: false = the loop worker process is unreachable
   *  (dead/respawning). Without it, "stopped" and "worker down" were
   *  indistinguishable in the UI. Optional for backward compat with
   *  older payloads. */
  workerReachable?: boolean;
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

export interface QueueCounts {
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  skipped: number;
  lastScanAt: string | null;
}

export interface ChatTaskPlan {
  ok: boolean;
  userGoal: string;
  understanding: string;
  files: Array<{ path: string; action: "modify" | "create"; reason: string }>;
  summary: string;
  error?: string;
}

/** Everything the dispatcher needs from the Home component. */
export interface CommandContext {
  status: SelfEnhanceStatus | null;
  queue: QueueCounts | null;
  pendingPlan: ChatTaskPlan | null;
  setStatus: (s: SelfEnhanceStatus) => void;
  setQueue: (q: QueueCounts) => void;
  setPendingPlan: (p: ChatTaskPlan | null) => void;
  setHistory: (fn: (prev: string[]) => string[]) => void;
  setHistoryIdx: (n: number) => void;
  pushTarget: PushTargetInfo | null;
  emitOutput: (lines: string[]) => void;
  clearConsole: () => void;
  openConfig: () => void | Promise<void>;
}

export async function executeCommand(
  cmd: string,
  ctx: CommandContext
): Promise<string[] | void> {
  // Destructure so the (moved verbatim) body below resolves reads and
  // setter calls exactly as it did inside the component closure.
  const {
    status,
    queue,
    pendingPlan,
    setStatus,
    setQueue,
    setPendingPlan,
    setHistory,
    setHistoryIdx,
    pushTarget,
    emitOutput,
    clearConsole,
    openConfig,
  } = ctx;
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
          "  push force  — (removed) force-push disabled (audit 3); runs a normal push",
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
            `  Rejected by gate: ${stats?.totalReverted ?? 0} (proposals the gate chain stopped pre-push)`,
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
          `Rejected by gate: ${s.stats.totalReverted}`,
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

        // push force — force-push REMOVED (audit 3: history rewrites are
        // no longer possible). The route ignores body.force entirely, so
        // this subcommand now performs a normal push.
        if (sub && sub.toLowerCase() === "force") {
          try {
            const res = await fetch("/api/self-enhance/push", { method: "POST" });
            const data = await res.json();
            if (data.pushed) return [`Pushed to GitHub: commit ${data.commitSha} (${data.repo})`];
            return [`Push failed: ${data.error ?? "unknown error"}`];
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
              lines.push("Initial push failed — the remote may have diverged (force-push is disabled)");
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
            let dirList = byDir.get(dir);
            if (!dirList) {
              dirList = [];
              byDir.set(dir, dirList);
            }
            dirList.push(label);
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
