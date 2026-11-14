import { describe, test, expect } from "bun:test";
import { usePipelineStore, type LoopConfig, type LoopStats, type LoopLogEntry, type FileResult, type AutonomousCycleState, type AutonomousCycleSummary, type LoopState, type PipelineStageState, type PipelineReport, type MemoryEntry, type LoopMode, type LoopStatus } from "./pipeline-store";

describe("usePipelineStore initial state and setters", () => {
  test("should initialize with default values", () => {
    // Accessing the store state directly for initial check (simulating a read)
    const state = usePipelineStore.getState();
    expect(state.wsConnected).toBe(false);
    expect(state.loopState).toBeNull();
    expect(state.pipelineReport).toBeNull();
    expect(state.pipelineRunning).toBe(false);
    expect(state.memoryEntries).toEqual([]);
    expect(state.repoFiles).toEqual([]);
    expect(state.githubUser).toBeNull();
    expect(state.inspectorFile).toBeNull();
  });

  test("should correctly set wsConnected state", () => {
    const setState = usePipelineStore.getState().setWsConnected;
    setState(true);
    expect(usePipelineStore.getState().wsConnected).toBe(true);
  });

  test("should correctly set loopState", () => {
    const mockLoopState: LoopState = {
      config: {} as LoopConfig,
      status: "idle" as LoopStatus,
      stats: {} as LoopStats,
      logs: [] as LoopLogEntry[],
      currentCycle: null as AutonomousCycleState | null,
      recentCycles: [] as AutonomousCycleSummary[],
    };
    const setState = usePipelineStore.getState().setLoopState;
    setState(mockLoopState);
    expect(usePipelineStore.getState().loopState).toBe(mockLoopState);
  });

  test("should correctly set pipelineReport", () => {
    const mockReport: PipelineReport = {
      id: "r1" as const,
      timestamp: 1678886400,
      status: "COMPLETED" as const,
      proofCommitHash: "hash1" as const,
      astScore: 0,
      consensus: "A" as const,
      stages: {} as Record<string, PipelineStageState>,
      sanitizerResult: { clean: true, violations: [], errorClass: "", highEntropyTokensFound: 0 } as any,
      reviewVerdict: { consensus: "A", consensusCoefficient: 1, cognitiveFriction: 0, securityPoints: [], architecturePoints: [], leadSummary: "", arguments: [] } as any,
      astDiffResult: { passed: true, astScore: 0, structuralDriftRatio: 0, brandingInjections: [], violations: [] as any, symbolMap: { originalCount: 1, proposedCount: 1, retainedCount: 1 } } as any,
      originalCode: "code" as const,
      evolvedCode: "code" as const,
      logs: [] as LoopLogEntry[],
      config: { targetRepo: "repo" as const, filePath: "file" as const, targetBranch: "branch" as const, userPrompt: "prompt" as const } as any,
    };
    const setState = usePipelineStore.getState().setPipelineReport;
    setState(mockReport);
    expect(usePipelineStore.getState().pipelineReport).toBe(mockReport);
  });

  test("should correctly set pipelineRunning state", () => {
    const setState = usePipelineStore.getState().setPipelineRunning;
    setState(true);
    expect(usePipelineStore.getState().pipelineRunning).toBe(true);
  });

  test("should correctly set memoryEntries", () => {
    const mockEntries: MemoryEntry[] = [{ id: "m1" as const, provenance: "p1" as const, trust: "t1" as const, content: "c1" as const }];
    const setState = usePipelineStore.getState().setMemoryEntries;
    setState(mockEntries);
    expect(usePipelineStore.getState().memoryEntries).toEqual(mockEntries);
  });
});