/**
 * Client-side Zustand store for the Architecture Helper Pipeline dashboard.
 * Holds loop state (synced via Socket.IO from the WS mini-service), the
 * latest pipeline execution report (from /api/pipeline/run), the list of
 * recent autonomous cycles, and the memory bank.
 */

"use client";

import { create } from "zustand";

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

export interface FileResult {
  path: string;
  astScore: number;
  consensus: string;
  proofHash: string;
  status: string;
  pushed: boolean;
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
  fileResults: FileResult[];
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

export interface LoopState {
  config: LoopConfig;
  status: LoopStatus;
  stats: LoopStats;
  logs: LoopLogEntry[];
  currentCycle: AutonomousCycleState | null;
  recentCycles: AutonomousCycleSummary[];
}

export interface PipelineStageState {
  id: string;
  name: string;
  status: "pending" | "running" | "succeeded" | "blocked" | "skipped";
  summary: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

export interface PipelineReport {
  id: string;
  timestamp: number;
  status: "COMPLETED" | "REJECTED" | "HALTED" | "SANITIZED_APPLIED";
  proofCommitHash: string;
  astScore: number;
  consensus: string;
  stages: Record<string, PipelineStageState>;
  sanitizerResult: {
    clean: boolean;
    violations: string[];
    errorClass: string;
    highEntropyTokensFound: number;
  };
  reviewVerdict: {
    consensus: string;
    consensusCoefficient: number;
    cognitiveFriction: number;
    securityPoints: string[];
    architecturePoints: string[];
    leadSummary: string;
    arguments: Array<{
      speaker: string;
      speakerName: string;
      avatar: string;
      stance: string;
      statement: string;
      citations: string[];
      cognitiveFriction: number;
    }>;
  };
  astDiffResult: {
    passed: boolean;
    astScore: number;
    structuralDriftRatio: number;
    brandingInjections: string[];
    violations: Array<{ code: string; message: string; severity: string }>;
    symbolMap: {
      originalCount: number;
      proposedCount: number;
      retainedCount: number;
    };
  };
  originalCode: string;
  evolvedCode: string;
  logs: LoopLogEntry[];
  config: {
    targetRepo: string;
    filePath: string;
    targetBranch: string;
    userPrompt: string;
  };
}

export interface MemoryEntry {
  id: string;
  provenance: string;
  trust: string;
  filePath?: string;
  ruleToAvoid?: string;
  diagnosis?: string;
  cleanSnippet?: string;
  content: string;
  timestamp?: number;
}

interface PipelineStore {
  // WebSocket connection state
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;

  // Loop state (from WS service / API)
  loopState: LoopState | null;
  setLoopState: (s: LoopState | null) => void;

  // Latest pipeline run report
  pipelineReport: PipelineReport | null;
  setPipelineReport: (r: PipelineReport | null) => void;

  // Whether a single-file pipeline is running
  pipelineRunning: boolean;
  setPipelineRunning: (v: boolean) => void;

  // Memory bank entries
  memoryEntries: MemoryEntry[];
  setMemoryEntries: (e: MemoryEntry[]) => void;

  // Repo tree (files fetched from GitHub)
  repoFiles: Array<{ path: string; size: number; sha: string; isCodeFile: boolean }>;
  setRepoFiles: (f: Array<{ path: string; size: number; sha: string; isCodeFile: boolean }>) => void;

  // GitHub user info (after token validation)
  githubUser: { username: string; avatarUrl: string; name: string } | null;
  setGithubUser: (u: { username: string; avatarUrl: string; name: string } | null) => void;

  // Manual control: which file is being inspected in the AST inspector modal
  inspectorFile: { path: string; original: string; evolved: string; report: PipelineReport } | null;
  setInspectorFile: (f: { path: string; original: string; evolved: string; report: PipelineReport } | null) => void;
}

export const usePipelineStore = create<PipelineStore>((set) => ({
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),
  loopState: null,
  setLoopState: (s) => set({ loopState: s }),
  pipelineReport: null,
  setPipelineReport: (r) => set({ pipelineReport: r }),
  pipelineRunning: false,
  setPipelineRunning: (v) => set({ pipelineRunning: v }),
  memoryEntries: [],
  setMemoryEntries: (e) => set({ memoryEntries: e }),
  repoFiles: [],
  setRepoFiles: (f) => set({ repoFiles: f }),
  githubUser: null,
  setGithubUser: (u) => set({ githubUser: u }),
  inspectorFile: null,
  setInspectorFile: (f) => set({ inspectorFile: f }),
}));
