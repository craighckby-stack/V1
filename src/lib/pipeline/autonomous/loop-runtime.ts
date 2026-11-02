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
import { postmortemStore, generatePostmortemFromReport } from "../postmortem/postmortem-store";
import { autoProphecyAfterCycle } from "../oracle/oracle-auto";

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
  /**
   * Set of file paths already committed to the evolution branch in prior
   * cycles — skipped so each cycle processes NEW files instead of re-doing
   * the same first-N-alphabetical files every time.
   */
  private previouslyCommittedPaths: Set<string> = new Set();

  // --- Token resolution (don't log the value) ---
  private resolveToken(clientToken?: string): string | null {
    // Fall through EVERY candidate in priority order, skipping empty/invalid
    // values. This used to be a `??` chain, which treats "" as a value — so
    // with the default config token of "", process.env.GITHUB_TOKEN was
    // NEVER reached and resolution always failed (audit 2, item 2).
    const candidates = [clientToken, this.config.githubToken, process.env.GITHUB_TOKEN];
    for (const candidate of candidates) {
      const value = (candidate ?? "").trim();
      if (!value || value.startsWith("MY_") || value === "undefined" || value.length < 8) {
        continue;
      }
      return value;
    }
    return null;
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
    const oldRepo = this.config.targetRepo;
    const oldBranch = this.config.evolutionBranch;
    const oldToken = this.config.githubToken;
    this.config = { ...this.config, ...patch };
    // If the target repo or evolution branch changed, clear the committed-
    // paths cache — those commits don't apply to the new target.
    if (
      (patch.targetRepo && patch.targetRepo !== oldRepo) ||
      (patch.evolutionBranch && patch.evolutionBranch !== oldBranch)
    ) {
      this.previouslyCommittedPaths.clear();
      this.addLog(
        `Cleared committed-paths cache (repo or branch changed from ${oldRepo}:${oldBranch}).`,
        "info"
      );
    }
    // If token was passed as "[REDACTED]" keep the previous one (the UI
    // re-sends the placeholder when the user didn't edit the field). The
    // API route normally strips it before calling here; this guard is
    // defense-in-depth so a future caller that bypasses the route can't
    // silently destroy the stored token with the placeholder.
    if (this.config.githubToken && patch.githubToken === "[REDACTED]") {
      this.config.githubToken = oldToken;
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
        // NOTE: no finalizeCycle() call here — the try/finally below is
        // the SINGLE finalize point. The old code called finalizeCycle()
        // explicitly on this path, so the finally block ran it a second
        // time: the same cycle was double-inserted into recentCycles
        // (the second DB insert failed on the duplicate id, but the
        // in-memory list kept both copies).
        return this.currentCycle!;
      }
      this.stats.lastTreeFingerprint = fp;
      this.addLog(`Tree fingerprint computed: ${fp} (${tree.length} entries)`, "info");

      // 2. Filter to REAL code files only. The LLM cannot meaningfully
      //    refactor markdown, JSON, YAML, shell, SQL, HTML, or CSS — running
      //    it on those files produces cosmetic comment injection that the
      //    0-diff saturation check then halts on, wasting LLM API calls.
      //    Only include languages where the LLM can extract constants,
      //    add type annotations, modularize, etc.
      const codeExtRegex = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|c|cpp|cc|cs)$/i;
      const ignored = /^(node_modules|\.git|\.next|dist|build|coverage|public\/assets|vendor|third_party|\.agents|docs?|examples?)\//i;
      // Hard cap on files per cycle — prevents runaway LLM API costs.
      const effectiveMaxFiles = Math.min(this.config.maxFilesPerCycle, 500);
      // Skip files already committed in prior cycles so each cycle makes
      // forward progress through large repos.
      const alreadyCommitted = this.previouslyCommittedPaths;
      const codeBlobs = tree
        .filter(
          (item) =>
            item.type === "blob" &&
            codeExtRegex.test(item.path) &&
            !ignored.test(item.path) &&
            !alreadyCommitted.has(item.path)
        )
        .slice(0, effectiveMaxFiles);

      this.currentCycle!.filesScanned = codeBlobs.length;
      this.stats.totalFilesScanned += codeBlobs.length;
      this.addLog(
        `Selected ${codeBlobs.length} code file(s) for pipeline processing (${alreadyCommitted.size} already committed in prior cycles, skipped).`,
        "info"
      );

      // 2.5. Ensure the evolution branch exists before we try to commit to it.
      //     If the branch doesn't exist, create it from the source branch's HEAD.
      //     This prevents 404 "branch not found" errors on the commit PUT.
      if (token && this.config.autoPush && this.config.evolutionBranch !== this.config.branch) {
        try {
          const branchCheckUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/ref/heads/${this.config.evolutionBranch}`;
          const branchCheckRes = await fetch(branchCheckUrl, { headers });
          if (!branchCheckRes.ok && branchCheckRes.status === 404) {
            // Branch doesn't exist — create it from source branch HEAD
            const sourceRefUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/ref/heads/${this.config.branch}`;
            const sourceRefRes = await fetch(sourceRefUrl, { headers });
            if (sourceRefRes.ok) {
              const sourceRefData = (await sourceRefRes.json()) as { object?: { sha?: string } };
              const sourceSha = sourceRefData.object?.sha;
              if (sourceSha) {
                const createBranchRes = await fetch(
                  `https://api.github.com/repos/${this.config.targetRepo}/git/refs`,
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${token}`,
                      "Content-Type": "application/json",
                      "User-Agent": "Architecture-Helper-Pipeline",
                      Accept: "application/vnd.github.v3+json",
                    },
                    body: JSON.stringify({
                      ref: `refs/heads/${this.config.evolutionBranch}`,
                      sha: sourceSha,
                    }),
                  }
                );
                if (createBranchRes.ok) {
                  this.addLog(
                    `Created evolution branch '${this.config.evolutionBranch}' from ${this.config.branch} (${sourceSha.slice(0, 7)}).`,
                    "success",
                    "github"
                  );
                } else {
                  const errBody = await createBranchRes.json().catch(() => ({}));
                  this.addLog(
                    `Failed to create evolution branch: ${(errBody as { message?: string })?.message ?? `HTTP ${createBranchRes.status}`}`,
                    "warn",
                    "github"
                  );
                }
              }
            } else {
              this.addLog(
                `Could not resolve source branch '${this.config.branch}' to create evolution branch (HTTP ${sourceRefRes.status}).`,
                "warn",
                "github"
              );
            }
          } else if (branchCheckRes.ok) {
            this.addLog(
              `Evolution branch '${this.config.evolutionBranch}' already exists.`,
              "info",
              "github"
            );
          }
        } catch (err) {
          this.addLog(
            `Branch creation check failed: ${(err as Error).message}`,
            "warn",
            "github"
          );
        }
      }

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
          // Decompose the gate decision into its constituent parts so we can
          // log the ACTUAL reason a commit was skipped, instead of lumping
          // everything under "Gates failed".
          const astPassed = report.astDiffResult.passed;
          const reviewApproved =
            report.reviewVerdict.consensus === "APPROVED" ||
            report.reviewVerdict.consensus === "CONDITIONAL_APPROVAL";
          const haltReason = report.haltState?.reason;
          const haltShouldHalt = !!report.haltState?.shouldHalt;
          // 0-diff saturation means the LLM produced no semantic change —
          // there is literally nothing to commit, so this is NOT a failure.
          const isZeroDiffSaturation = haltReason === "ZERO_DIFF_SATURATION";
          // Real gates passed = AST + review both green AND not halted by
          // a non-saturation reason (max cycles, consecutive failures).
          const gatesPassed = astPassed && reviewApproved && !haltShouldHalt;
          // We only commit when there IS a real change to push.
          const hasRealChange = !isZeroDiffSaturation;

          if (gatesPassed && hasRealChange && this.config.autoPush && token) {
            const pushResult = await this.putFileWithToctouRetry({
              token,
              filePath: blob.path,
              rawContent,
              evolvedCode: report.evolvedCode,
              baseSha: fileData.sha,
              cycleId,
              cycleNumber,
              proofHash: report.proofCommitHash,
              astScore: report.astDiffResult.astScore,
            });
            if (pushResult.pushed) {
              pushed = true;
              committed++;
              // Track this path so future cycles skip it.
              this.previouslyCommittedPaths.add(blob.path);
              this.addLog(
                `Pushed ${blob.path} → ${this.config.evolutionBranch} (proof ${report.proofCommitHash})${pushResult.toctouHealed ? " [TOCTOU-healed]" : ""}`,
                "success",
                "github"
              );
            } else if (pushResult.skippedDueToRemoteChange) {
              // Already logged inside the helper — the next cycle will
              // fetch the fresh remote content and refactor it anew.
            } else {
              this.addLog(
                `Commit failed for ${blob.path}: ${pushResult.error ?? "unknown"}`,
                "error",
                "github"
              );
            }
          } else if (!astPassed) {
            this.addLog(
              `Skipping ${blob.path}: AST gate failed (score ${report.astDiffResult.astScore}/100, violations: ${report.astDiffResult.violations.map(v => v.code).join(",") || "none"}).`,
              "warn"
            );
          } else if (!reviewApproved) {
            this.addLog(
              `Skipping ${blob.path}: Review tribunal rejected (${report.reviewVerdict.consensus}, coefficient ${(report.reviewVerdict.consensusCoefficient * 100).toFixed(0)}%).`,
              "warn"
            );
          } else if (isZeroDiffSaturation) {
            this.addLog(
              `No change for ${blob.path}: LLM produced no semantic diff (0-diff saturation). Nothing to commit.`,
              "info"
            );
          } else if (haltShouldHalt) {
            this.addLog(
              `Skipping ${blob.path}: Halt governor engaged (${haltReason}: ${report.haltState?.detail ?? ""}).`,
              "warn"
            );
            // Only halt the cycle for non-saturation reasons.
            halted = true;
            cycleStatus = "halted";
          } else if (!token) {
            this.addLog(
              `No GitHub token available — would have pushed ${blob.path} (proof ${report.proofCommitHash}).`,
              "warn"
            );
          }

          // Postmortem integration: record failures, resolve on success.
          const repo = this.config.targetRepo;
          const branch = this.config.branch;
          if (pushed) {
            // Commit succeeded — resolve any active postmortem for this file.
            postmortemStore
              .markResolved(repo, branch, blob.path)
              .then(() => {
                this.addLog(
                  `Postmortem resolved for ${blob.path} (file successfully committed).`,
                  "info"
                );
              })
              .catch(() => {
                /* ignore */
              });
          } else if (!astPassed || !reviewApproved || isZeroDiffSaturation) {
            // A real failure — record/update the postmortem so the next
            // attempt gets the constraints.
            const pm = generatePostmortemFromReport({
              filePath: blob.path,
              astDiffResult: report.astDiffResult,
              sanitizerResult: report.sanitizerResult,
              reviewVerdict: report.reviewVerdict,
              haltReason: report.haltState?.reason,
            });
            postmortemStore
              .recordFailure({
                repo,
                branch,
                filePath: blob.path,
                failureType: pm.failureType,
                symptom: pm.symptom,
                evidence: pm.evidence,
                constraints: pm.constraints,
              })
              .then((record) => {
                this.addLog(
                  `Postmortem recorded for ${blob.path} (attempt #${record.attempts}, ${pm.failureType}). Next attempt will use these constraints.`,
                  "warn"
                );
              })
              .catch(() => {
                /* ignore */
              });
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

  /**
   * TOCTOU-safe Contents-API PUT (concept: Aether_Forge Ω repo's
   * force:false ref retry, adapted for the Contents API).
   *
   * The GitHub Contents API is optimistic-concurrency on `sha`: the PUT
   * must include the sha of the file as it was when we READ it, and if
   * the file changed in between, GitHub returns 409. The old code logged
   * "Commit failed" and dropped the enhancement — even though the
   * pipeline (LLM + AST + debate) had already validated it.
   *
   * This helper retries the 409 with a critical correctness guard:
   *
   *   1. On 409, REFETCH the file's current content + sha from the
   *      evolution branch.
   *   2. If the refetched content is BYTE-IDENTICAL to the `rawContent`
   *      we based the refactor on, the sha drift is metadata-only (a
   *      bot touched the sha, or someone committed-then-reverted). The
   *      refactor is still valid → retry the PUT with the fresh sha.
   *   3. If the refetched content DIFFERS, a real concurrent change
   *      landed. Our refactor was based on STALE input — committing it
   *      would CLOBBER the remote change. Skip HONESTLY: log it, mark
   *      skippedDueToRemoteChange, and let the next cycle refactor the
   *      fresh content from scratch.
   *
   * This is stricter than Aether_Forge's blind retry (their push is of
   * GENERATED content not derived from the remote file's previous
   * content, so clobbering isn't a concern there). For LOOP, the LLM
   * refactor IS derived from the remote file — so a content-changed
   * 409 must NOT retry.
   *
   * Emits `push` events on the loop event bus at each lifecycle point
   * (committed / toctou_conflict / toctou_healed / skipped_remote_changed
   * / failed) so the console stream can narrate the heal path.
   */
  private async putFileWithToctouRetry(params: {
    token: string;
    filePath: string;
    rawContent: string; // original content the refactor was based on
    evolvedCode: string; // the LLM-refactored code to commit
    baseSha: string; // sha of rawContent as fetched at pipeline start
    cycleId: string;
    cycleNumber: number;
    proofHash: string;
    astScore: number;
  }): Promise<{
    pushed: boolean;
    toctouHealed: boolean;
    skippedDueToRemoteChange: boolean;
    error?: string;
  }> {
    const {
      token,
      filePath,
      rawContent,
      evolvedCode,
      baseSha,
      cycleId,
      cycleNumber,
      proofHash,
      astScore,
    } = params;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Architecture-Helper-Pipeline",
      Accept: "application/vnd.github.v3+json",
    };
    const commitUrl = `https://api.github.com/repos/${this.config.targetRepo}/contents/${filePath}`;
    const fileUrl = `https://api.github.com/repos/${this.config.targetRepo}/contents/${filePath}?ref=${this.config.evolutionBranch}`;
    const message = `Autonomous self-enhancement #${cycleNumber} — ${filePath} (AST ${astScore}, proof ${proofHash})`;
    const contentB64 = Buffer.from(evolvedCode).toString("base64");
    let currentSha = baseSha;
    const MAX_TOCTOU_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_TOCTOU_RETRIES; attempt++) {
      const commitPayload: Record<string, unknown> = {
        message,
        content: contentB64,
        branch: this.config.evolutionBranch,
      };
      if (currentSha) commitPayload.sha = currentSha;

      let commitRes: Response;
      try {
        commitRes = await fetch(commitUrl, {
          method: "PUT",
          headers,
          body: JSON.stringify(commitPayload),
        });
      } catch (err) {
        loopEventBus.emit({
          kind: "push",
          timestamp: Date.now(),
          cycleId,
          filePath,
          outcome: "failed",
          attempt,
        });
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: false,
          error: `dispatch error: ${(err as Error).message}`,
        };
      }

      if (commitRes.ok) {
        const body = (await commitRes.json().catch(() => ({}))) as {
          commit?: { sha?: string };
        };
        const sha = body.commit?.sha?.slice(0, 7);
        loopEventBus.emit({
          kind: "push",
          timestamp: Date.now(),
          cycleId,
          filePath,
          outcome: attempt === 0 ? "committed" : "toctou_healed",
          sha,
          attempt,
        });
        return {
          pushed: true,
          toctouHealed: attempt > 0,
          skippedDueToRemoteChange: false,
        };
      }

      // Non-409 errors don't retry — they're real failures (auth, 404,
      // 422, validation). Surface them and bail.
      if (commitRes.status !== 409) {
        const errBody = (await commitRes.json().catch(() => ({}))) as {
          message?: string;
        };
        loopEventBus.emit({
          kind: "push",
          timestamp: Date.now(),
          cycleId,
          filePath,
          outcome: "failed",
          attempt,
        });
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: false,
          error: `${errBody.message ?? `HTTP ${commitRes.status}`}`,
        };
      }

      // 409 — TOCTOU conflict. Emit the conflict event, then refetch to
      // decide whether the remote content actually changed.
      loopEventBus.emit({
        kind: "push",
        timestamp: Date.now(),
        cycleId,
        filePath,
        outcome: "toctou_conflict",
        attempt,
      });

      if (attempt === MAX_TOCTOU_RETRIES) {
        loopEventBus.emit({
          kind: "push",
          timestamp: Date.now(),
          cycleId,
          filePath,
          outcome: "failed",
          attempt,
        });
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: false,
          error: `409 persisted across ${MAX_TOCTOU_RETRIES + 1} attempts`,
        };
      }

      // Exponential backoff before the refetch (1s, 2s, 4s) — gives a
      // concurrent committer time to settle so we don't refetch mid-flux.
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));

      let refetchRes: Response;
      try {
        refetchRes = await fetch(fileUrl, { headers });
      } catch (err) {
        loopEventBus.emit({
          kind: "push",
          timestamp: Date.now(),
          cycleId,
          filePath,
          outcome: "failed",
          attempt,
        });
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: false,
          error: `refetch dispatch error: ${(err as Error).message}`,
        };
      }
      if (!refetchRes.ok) {
        loopEventBus.emit({
          kind: "push",
          timestamp: Date.now(),
          cycleId,
          filePath,
          outcome: "failed",
          attempt,
        });
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: false,
          error: `refetch failed (HTTP ${refetchRes.status})`,
        };
      }
      const refetchData = (await refetchRes.json().catch(() => ({}))) as {
        content?: string;
        sha: string;
      };
      const refetchedContent = refetchData.content
        ? Buffer.from(refetchData.content, "base64").toString("utf-8")
        : "";

      if (refetchedContent !== rawContent) {
        // Remote content CHANGED since we fetched — our refactor is
        // based on stale input. Committing would clobber the remote
        // change. Skip honestly; the next cycle fetches fresh content
        // and refactors anew. This is the key correctness guard that
        // makes the TOCTOU retry safe for derived-from-remote commits.
        loopEventBus.emit({
          kind: "push",
          timestamp: Date.now(),
          cycleId,
          filePath,
          outcome: "skipped_remote_changed",
          sha: refetchData.sha,
          attempt,
        });
        this.addLog(
          `Skipping ${filePath}: remote content changed mid-cycle (TOCTOU). Refactor based on stale input — would clobber remote change. Next cycle will refactor the fresh content.`,
          "warn",
          "github"
        );
        return {
          pushed: false,
          toctouHealed: false,
          skippedDueToRemoteChange: true,
          error: "remote content changed mid-cycle (skipped to avoid clobber)",
        };
      }

      // Remote content byte-identical — the sha drift is metadata-only
      // (someone committed-then-reverted, or a bot touched the sha
      // without changing content). Retry the PUT with the fresh sha;
      // the refactor is still valid against this content.
      currentSha = refetchData.sha;
      this.addLog(
        `TOCTOU heal: remote content unchanged, sha drifted. Retrying ${filePath} with fresh sha ${(refetchData.sha ?? "").slice(0, 7)} (attempt ${attempt + 2}/${MAX_TOCTOU_RETRIES + 1}).`,
        "info",
        "github"
      );
    }

    // Unreachable (the loop returns on every path), but TS needs a return.
    return {
      pushed: false,
      toctouHealed: false,
      skippedDueToRemoteChange: false,
      error: "exhausted",
    };
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

    // Oracle background integration: after every completed/halted cycle,
    // give the system the chance to predict its OWN next turn. This is what
    // makes the Oracle a participant in the loop's rhythm instead of a
    // manual toy — every cycle ends with "what happens next?" committed to
    // a falsifiable answer BEFORE the next cycle runs. autoProphecyAfterCycle
    // is fire-and-forget, LLM-gate-aware, bounded (≤5 pending prophecies),
    // and never throws — it can't take down the loop. (Previously this was
    // wired into self-enhance-loop.ts but NOT loop-runtime.ts — the
    // autonomous loop ran cycles without ever generating prophecies.)
    if (status === "completed" || status === "halted") {
      try {
        autoProphecyAfterCycle();
      } catch {
        // Defensive: autoProphecyAfterCycle already swallows internally,
        // but a defensive try here guarantees a future refactor can't
        // accidentally make the oracle take down the autonomous loop.
      }
    }
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
