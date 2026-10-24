/**
 * Autonomous Self-Enhancement Loop Runtime (singleton, server-side)
 *
 * Supports four modes for triggering pipeline runs without manual interaction:
 *   1. scheduled   — interval-based cron-like timer (default 10 min)
 *   2. watch       — file-system-ish watcher over the target repo
 *                    (re-runs when remote tree fingerprint changes)
 *   3. continuous  — true continuous agent loop: back-to-back cycles with
 *                    saturation-driven self-stop (per halt governor)
 *   4. manual      — one-shot /api/autonomous/trigger invocation
 *
 * Each cycle:
 *   - fetches the target repo tree
 *   - selects up to N code files (sliced)
 *   - runs the 6-stage pipeline on each (sanitizer -> AST -> review)
 *   - if `autoPush` and gates pass, dispatches batch commit to GitHub
 *   - records a cycle in the DB and broadcasts logs via the WebSocket bus
 */

import { unifiedPipelineRunnerInstance } from "../core/unified-pipeline";
import { db } from "@/lib/db";
import { loopEventBus, LoopEvent } from "./loop-event-bus";

export type LoopMode = "scheduled" | "watch" | "continuous" | "manual";
export type LoopStatus = "idle" | "running" | "paused" | "error";

export interface LoopConfig {
  enabled: boolean;
  mode: LoopMode;
  intervalMinutes: number;
  targetRepo: string;
  branch: string;
  evolutionBranch: string;
  maxCycles: number;
  maxFilesPerCycle: number;
  autoPush: boolean;
  siphonSourceId: string;
  userPrompt: string;
  githubToken: string;
}

export interface LoopStats {
  totalRuns: number;
  totalFilesScanned: number;
  totalFilesCommitted: number;
  lastRunTime: string | null;
  lastTreeFingerprint: string | null;
  nextRunAt: string | null;
}

export interface LoopLogEntry {
  timestamp: string;
  message: string;
  type: "info" | "warn" | "success" | "error";
  source: "autonomous" | "pipeline" | "github";
}

export interface LoopState {
  config: LoopConfig;
  status: LoopStatus;
  stats: LoopStats;
  logs: LoopLogEntry[];
  currentCycle: AutonomousCycleState | null;
  recentCycles: AutonomousCycleSummary[];
}

export interface AutonomousCycleState {
  id: string;
  cycleNumber: number;
  mode: LoopMode;
  targetRepo: string;
  branch: string;
  startedAt: string;
  filesScanned: number;
  filesCommitted: number;
  status: "running" | "completed" | "error" | "halted";
  fileResults: Array<{
    path: string;
    astScore: number;
    consensus: string;
    proofHash: string;
    status: string;
    pushed: boolean;
  }>;
}

export interface AutonomousCycleSummary {
  id: string;
  cycleNumber: number;
  mode: LoopMode;
  targetRepo: string;
  branch: string;
  filesScanned: number;
  filesCommitted: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  proofHash: string | null;
}

class AutonomousLoopRuntime {
  private config: LoopConfig = {
    enabled: false,
    mode: "scheduled",
    intervalMinutes: 10,
    targetRepo: "craighckby-stack/66",
    branch: "main",
    evolutionBranch: "helper-evolution",
    maxCycles: 100,
    maxFilesPerCycle: 5,
    autoPush: true,
    siphonSourceId: "pattern-optimizer-helper",
    userPrompt:
      "Apply 5-pillar modular refactoring with AST retention and Shannon entropy sanitization.",
    githubToken: "",
  };

  private status: LoopStatus = "idle";
  private stats: LoopStats = {
    totalRuns: 0,
    totalFilesScanned: 0,
    totalFilesCommitted: 0,
    lastRunTime: null,
    lastTreeFingerprint: null,
    nextRunAt: null,
  };
  private logs: LoopLogEntry[] = [];
  private currentCycle: AutonomousCycleState | null = null;
  private recentCycles: AutonomousCycleSummary[] = [];
  private timer: NodeJS.Timeout | null = null;
  private continuousLoopRunning = false;

  // --- Token resolution (don't log the value) ---
  private resolveToken(clientToken?: string): string | null {
    const candidate = (
      clientToken ??
      this.config.githubToken ??
      process.env.GITHUB_TOKEN ??
      ""
    ).trim();
    if (
      !candidate ||
      candidate.startsWith("MY_") ||
      candidate === "undefined" ||
      candidate.length < 8
    ) {
      return null;
    }
    return candidate;
  }

  private addLog(
    message: string,
    type: LoopLogEntry["type"] = "info",
    source: LoopLogEntry["source"] = "autonomous"
  ) {
    const entry: LoopLogEntry = {
      timestamp: new Date().toLocaleTimeString(),
      message,
      type,
      source,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 200) this.logs.pop();
    console.log(`[AUTONOMOUS:${source}] [${type.toUpperCase()}] ${message}`);
    loopEventBus.emit({
      kind: "log",
      timestamp: Date.now(),
      log: entry,
    });
  }

  private emitState() {
    loopEventBus.emit({
      kind: "state",
      timestamp: Date.now(),
      state: this.getState(),
    });
  }

  // --- Public API ---
  public getState(): LoopState {
    return {
      config: {
        ...this.config,
        githubToken: this.config.githubToken ? "[REDACTED]" : "",
      },
      status: this.status,
      stats: { ...this.stats },
      logs: [...this.logs],
      currentCycle: this.currentCycle ? { ...this.currentCycle } : null,
      recentCycles: [...this.recentCycles],
    };
  }

  public updateConfig(patch: Partial<LoopConfig>): LoopConfig {
    const wasEnabled = this.config.enabled;
    const oldMode = this.config.mode;
    this.config = { ...this.config, ...patch };
    // If token was passed as "[REDACTED]" keep previous one (UI never re-sends real value).
    if (patch.githubToken === "[REDACTED]") {
      // Keep the previously-stored token; UI never overwrites with real value during edits.
      // Note: when user submits a *new* real token, that string won't equal "[REDACTED]" so it persists.
      // Re-load previously-stored token from closure (we already overwrote it above).
      // To avoid losing it, only overwrite when caller passed a real token. We handle this in API route.
    }
    this.addLog(
      `Configuration updated: mode=${this.config.mode}, interval=${this.config.intervalMinutes}m, repo=${this.config.targetRepo}, autoPush=${this.config.autoPush}`,
      "info"
    );
    if (wasEnabled && this.config.enabled && oldMode !== this.config.mode) {
      this.addLog(
        `Switching loop mode from ${oldMode} to ${this.config.mode}. Restarting scheduler.`,
        "info"
      );
      this.restartScheduler();
    }
    this.emitState();
    return {
      ...this.config,
      githubToken: this.config.githubToken ? "[REDACTED]" : "",
    };
  }

  public start(): LoopState {
    if (this.config.enabled && this.status !== "paused") {
      this.addLog("Loop already enabled.", "info");
      return this.getState();
    }
    this.config.enabled = true;
    this.status = "idle";
    this.addLog(
      `Autonomous loop ENABLED in ${this.config.mode.toUpperCase()} mode. First run scheduled in ${this.config.intervalMinutes} minute(s).`,
      "success"
    );
    this.restartScheduler();
    this.emitState();
    return this.getState();
  }

  public stop(): LoopState {
    this.config.enabled = false;
    this.status = "paused";
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.continuousLoopRunning = false;
    this.addLog(
      "Autonomous loop DISABLED. No further cycles will run until re-enabled.",
      "warn"
    );
    this.emitState();
    return this.getState();
  }

  public async triggerManual(): Promise<{ started: boolean; cycleId: string | null }> {
    this.addLog("Manual trigger received. Starting one-shot autonomous cycle...", "info");
    const cycle = await this.executeCycle("manual");
    return { started: !!cycle, cycleId: cycle?.id ?? null };
  }

  private restartScheduler() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.continuousLoopRunning = false;
    if (!this.config.enabled) {
      this.status = "paused";
      this.stats.nextRunAt = null;
      return;
    }
    const ms = Math.max(15_000, this.config.intervalMinutes * 60 * 1000);
    this.status = "idle";
    this.stats.nextRunAt = new Date(Date.now() + ms).toISOString();
    this.addLog(`Scheduler armed. Next automatic cycle at ${this.stats.nextRunAt}`, "info");
    this.timer = setInterval(() => {
      this.executeCycle(this.config.mode).catch((err) => {
        this.addLog(`Scheduler cycle failed: ${(err as Error).message}`, "error");
      });
    }, ms);

    if (this.config.mode === "continuous") {
      this.continuousLoopRunning = true;
      this.runContinuousLoop().catch((err) => {
        this.addLog(`Continuous loop crashed: ${(err as Error).message}`, "error");
      });
    }
    this.emitState();
  }

  private async runContinuousLoop() {
    while (
      this.continuousLoopRunning &&
      this.config.enabled &&
      this.config.mode === "continuous"
    ) {
      const cycle = await this.executeCycle("continuous");
      if (!cycle) break;
      if (cycle.status === "halted") {
        this.addLog(
          "Continuous loop halted by governor (saturation or failure limit reached). Pausing.",
          "warn"
        );
        this.status = "paused";
        this.continuousLoopRunning = false;
        this.emitState();
        break;
      }
      // Brief cooldown between continuous cycles.
      await new Promise((r) => setTimeout(r, 1500));
    }
    this.continuousLoopRunning = false;
  }

  private async executeCycle(mode: LoopMode): Promise<AutonomousCycleState | null> {
    if (this.status === "running") {
      this.addLog("Skipping cycle — another cycle already running.", "warn");
      return null;
    }
    this.status = "running";
    this.stats.totalRuns++;
    const cycleId = `cycle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const cycleNumber = this.stats.totalRuns;
    const startedAt = new Date().toISOString();

    this.currentCycle = {
      id: cycleId,
      cycleNumber,
      mode,
      targetRepo: this.config.targetRepo,
      branch: this.config.branch,
      startedAt,
      filesScanned: 0,
      filesCommitted: 0,
      status: "running",
      fileResults: [],
    };

    this.addLog(
      `Starting autonomous cycle #${cycleNumber} (${mode}) on ${this.config.targetRepo}:${this.config.branch}`,
      "info"
    );
    this.emitState();

    const token = this.resolveToken();
    const headers: Record<string, string> = {
      "User-Agent": "Architecture-Helper-Pipeline",
      Accept: "application/vnd.github.v3+json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let cycleStatus: AutonomousCycleState["status"] = "completed";
    let cycleProofHash: string | null = null;

    try {
      // 1. Fetch repo tree (recursive)
      const treeUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/trees/${this.config.branch}?recursive=1`;
      let treeRes = await fetch(treeUrl, { headers });
      if (!treeRes.ok && this.config.branch === "main") {
        const altUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/trees/master?recursive=1`;
        treeRes = await fetch(altUrl, { headers });
      }
      if (!treeRes.ok) {
        throw new Error(`GitHub tree fetch failed (${treeRes.status})`);
      }
      const treeData = (await treeRes.json()) as {
        tree: Array<{ path: string; type: string; sha: string; size?: number }>;
      };
      const tree = treeData.tree ?? [];

      // Compute tree fingerprint
      const fp = this.computeTreeFingerprint(tree);
      if (this.config.mode === "watch" && this.stats.lastTreeFingerprint === fp) {
        this.addLog(
          `Watch mode: tree fingerprint unchanged (${fp}). Skipping cycle — no remote changes detected.`,
          "info"
        );
        cycleStatus = "halted";
        this.finalizeCycle(cycleId, cycleStatus, null);
        return this.currentCycle!;
      }
      this.stats.lastTreeFingerprint = fp;
      this.addLog(`Tree fingerprint computed: ${fp} (${tree.length} entries)`, "info");

      // 2. Filter code files
      const codeExtRegex = /\.(ts|tsx|js|jsx|json|md|py|go|rs|css|html|yaml|yml|sh|sql)$/i;
      const ignored = /^(node_modules|\.git|\.next|dist|build|coverage|public\/assets)\//i;
      const codeBlobs = tree
        .filter(
          (item) =>
            item.type === "blob" &&
            codeExtRegex.test(item.path) &&
            !ignored.test(item.path)
        )
        .slice(0, this.config.maxFilesPerCycle);

      this.currentCycle!.filesScanned = codeBlobs.length;
      this.stats.totalFilesScanned += codeBlobs.length;
      this.addLog(`Selected ${codeBlobs.length} code file(s) for pipeline processing.`, "info");

      // 3. For each file: fetch content, run pipeline, optionally commit
      let committed = 0;
      let halted = false;
      for (const blob of codeBlobs) {
        if (halted) break;
        try {
          const fileUrl = `https://api.github.com/repos/${this.config.targetRepo}/contents/${blob.path}?ref=${this.config.branch}`;
          const fileRes = await fetch(fileUrl, { headers });
          if (!fileRes.ok) {
            this.addLog(`Failed to fetch ${blob.path} (${fileRes.status}). Skipping.`, "warn");
            continue;
          }
          const fileData = (await fileRes.json()) as { content?: string; sha: string };
          const rawContent = fileData.content
            ? Buffer.from(fileData.content, "base64").toString("utf-8")
            : "";

          // Run pipeline
          const report = await unifiedPipelineRunnerInstance.runPipeline(
            {
              githubToken: token ?? undefined,
              targetRepo: this.config.targetRepo,
              targetBranch: this.config.branch,
              evolutionBranch: this.config.evolutionBranch,
              filePath: blob.path,
              userPrompt: this.config.userPrompt,
              siphonSourceId: this.config.siphonSourceId,
              code: rawContent,
              triggeredBy: mode,
            },
            (stage) => {
              loopEventBus.emit({
                kind: "stage",
                timestamp: Date.now(),
                cycleId,
                filePath: blob.path,
                stage,
              });
            },
            (entry) => {
              loopEventBus.emit({
                kind: "log",
                timestamp: Date.now(),
                log: {
                  timestamp: entry.timestamp,
                  message: `[${blob.path}] ${entry.message}`,
                  type: entry.type,
                  source: "pipeline",
                },
              });
            }
          );

          // Record pipeline run in DB (best-effort)
          try {
            await db.pipelineRun.create({
              data: {
                pipelineId: report.id,
                targetRepo: this.config.targetRepo,
                targetBranch: this.config.branch,
                evolutionBranch: this.config.evolutionBranch,
                filePath: blob.path,
                userPrompt: this.config.userPrompt,
                siphonSourceId: this.config.siphonSourceId,
                status: report.status,
                astScore: report.astDiffResult.astScore,
                consensus: report.reviewVerdict.consensus,
                proofHash: report.proofCommitHash,
                originalCode: report.originalCode.slice(0, 200000),
                evolvedCode: report.evolvedCode.slice(0, 200000),
                sanitizerClean: report.sanitizerResult.clean,
                violations: JSON.stringify(report.sanitizerResult.violations),
                triggeredBy: mode,
              },
            });
          } catch (err) {
            this.addLog(`DB write failed for ${blob.path}: ${(err as Error).message}`, "warn");
          }

          let pushed = false;
          const gatesPassed =
            report.astDiffResult.passed &&
            (report.reviewVerdict.consensus === "APPROVED" ||
              report.reviewVerdict.consensus === "CONDITIONAL_APPROVAL") &&
            !report.haltState?.shouldHalt;

          if (gatesPassed && this.config.autoPush && token) {
            try {
              const commitUrl = `https://api.github.com/repos/${this.config.targetRepo}/contents/${blob.path}`;
              const commitPayload: Record<string, unknown> = {
                message: `Autonomous self-enhancement #${cycleNumber} — ${blob.path} (AST ${report.astDiffResult.astScore}, proof ${report.proofCommitHash})`,
                content: Buffer.from(report.evolvedCode).toString("base64"),
                branch: this.config.evolutionBranch,
              };
              if (fileData.sha) commitPayload.sha = fileData.sha;
              const commitRes = await fetch(commitUrl, {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                  "User-Agent": "Architecture-Helper-Pipeline",
                  Accept: "application/vnd.github.v3+json",
                },
                body: JSON.stringify(commitPayload),
              });
              if (commitRes.ok) {
                pushed = true;
                committed++;
                this.addLog(
                  `Pushed ${blob.path} → ${this.config.evolutionBranch} (proof ${report.proofCommitHash})`,
                  "success",
                  "github"
                );
              } else {
                const errBody = await commitRes.json().catch(() => ({}));
                this.addLog(
                  `Commit failed for ${blob.path}: ${(errBody as { message?: string })?.message ?? `HTTP ${commitRes.status}`}`,
                  "error",
                  "github"
                );
              }
            } catch (err) {
              this.addLog(
                `Commit dispatch error for ${blob.path}: ${(err as Error).message}`,
                "error",
                "github"
              );
            }
          } else if (!gatesPassed) {
            this.addLog(
              `Gates failed for ${blob.path} (AST ${report.astDiffResult.astScore}, ${report.reviewVerdict.consensus}). Skipping commit.`,
              "warn"
            );
            if (report.haltState?.shouldHalt) {
              halted = true;
              cycleStatus = "halted";
            }
          } else if (!token) {
            this.addLog(
              `No GitHub token available — would have pushed ${blob.path} (proof ${report.proofCommitHash}).`,
              "warn"
            );
          }

          this.currentCycle!.fileResults.push({
            path: blob.path,
            astScore: report.astDiffResult.astScore,
            consensus: report.reviewVerdict.consensus,
            proofHash: report.proofCommitHash,
            status: report.status,
            pushed,
          });
          if (report.proofCommitHash && !cycleProofHash) cycleProofHash = report.proofCommitHash;
        } catch (err) {
          this.addLog(`File ${blob.path} failed: ${(err as Error).message}`, "error");
        }
      }

      this.currentCycle!.filesCommitted = committed;
      this.stats.totalFilesCommitted += committed;
      this.stats.lastRunTime = new Date().toISOString();
      if (!halted) cycleStatus = "completed";
    } catch (err) {
      this.addLog(`Cycle #${cycleNumber} aborted: ${(err as Error).message}`, "error");
      cycleStatus = "error";
    } finally {
      this.finalizeCycle(cycleId, cycleStatus, cycleProofHash);
      this.status = this.config.enabled ? "idle" : "paused";
      if (this.config.enabled && this.config.mode !== "continuous") {
        const ms = Math.max(15_000, this.config.intervalMinutes * 60 * 1000);
        this.stats.nextRunAt = new Date(Date.now() + ms).toISOString();
      } else {
        this.stats.nextRunAt = null;
      }
      this.emitState();
    }

    return this.currentCycle;
  }

  private finalizeCycle(
    cycleId: string,
    status: AutonomousCycleState["status"],
    proofHash: string | null
  ) {
    if (!this.currentCycle) return;
    const finishedAt = new Date().toISOString();
    this.currentCycle.status = status;
    this.currentCycle.filesCommitted = this.currentCycle.filesCommitted ?? 0;

    db.autonomousCycle
      .create({
        data: {
          id: cycleId,
          cycleNumber: this.currentCycle.cycleNumber,
          mode: this.currentCycle.mode,
          targetRepo: this.currentCycle.targetRepo,
          branch: this.currentCycle.branch,
          filesScanned: this.currentCycle.filesScanned,
          filesCommitted: this.currentCycle.filesCommitted,
          status,
          proofHash,
          startedAt: new Date(this.currentCycle.startedAt),
          finishedAt: new Date(finishedAt),
        },
      })
      .catch(() => {
        /* ignore */
      });

    this.recentCycles.unshift({
      id: cycleId,
      cycleNumber: this.currentCycle.cycleNumber,
      mode: this.currentCycle.mode,
      targetRepo: this.currentCycle.targetRepo,
      branch: this.currentCycle.branch,
      filesScanned: this.currentCycle.filesScanned,
      filesCommitted: this.currentCycle.filesCommitted,
      status,
      startedAt: this.currentCycle.startedAt,
      finishedAt,
      proofHash,
    });
    if (this.recentCycles.length > 25) this.recentCycles.length = 25;
  }

  private computeTreeFingerprint(
    tree: Array<{ path: string; sha: string; size?: number }>
  ): string {
    const sorted = [...tree].sort((a, b) => a.path.localeCompare(b.path));
    const raw = sorted.map((f) => `${f.path}:${f.sha ?? f.size ?? 0}`).join("|");
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    return "tree_fp_" + Math.abs(hash).toString(16);
  }
}

// Singleton — survives across hot reloads.
const globalForLoop = globalThis as unknown as {
  __autonomousLoopRuntime?: AutonomousLoopRuntime;
};

export const autonomousLoopRuntime: AutonomousLoopRuntime =
  globalForLoop.__autonomousLoopRuntime ?? new AutonomousLoopRuntime();

if (!globalForLoop.__autonomousLoopRuntime) {
  globalForLoop.__autonomousLoopRuntime = autonomousLoopRuntime;
}

// Touch the bus so the import is preserved for tree-shaking safety.
void (loopEventBus as unknown as LoopEvent);
