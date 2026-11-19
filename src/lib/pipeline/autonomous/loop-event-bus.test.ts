import { describe, test, expect } from "bun:test";
import { loopEventBus, type LoopEvent } from "./loop-event-bus";
import type { LoopLogEntry, LoopState } from "./loop-runtime";
import type { PipelineStageState } from "../core/unified-pipeline";

// Mock state objects for constructing events. The bus validates only the
// event envelope (presence/kind/timestamp), not the internals of these
// payloads, so empty objects cast to the real payload types suffice.
const mockLoopState = {} as LoopState;
const _mockLoopLogEntry = {} as LoopLogEntry;
const mockPipelineStageState = {} as PipelineStageState;

describe("loopEventBus", () => {
  test("should successfully emit a 'state' event with a valid positive timestamp", () => {
    const validEvent: LoopEvent = { kind: "state", timestamp: 1678886400000, state: mockLoopState };
    // The implementation returns true if EventEmitter.emit does not return null
    expect(loopEventBus.emit(validEvent)).toBe(true);
  });

  test("should throw an error if 'state' event is emitted without a state object", () => {
    const invalidEvent: LoopEvent = { kind: "state", timestamp: 1, state: undefined as unknown as LoopState };
    expect(() => loopEventBus.emit(invalidEvent)).toThrow("LoopEventBus.emit() for kind 'state' requires a defined state object.");
  });

  test("should throw an error if 'stage' event is emitted with an empty cycleId", () => {
    const invalidEvent: LoopEvent = { kind: "stage", timestamp: 1, cycleId: "", filePath: "path", stage: mockPipelineStageState };
    expect(() => loopEventBus.emit(invalidEvent)).toThrow("LoopEventBus.emit() for kind 'stage' requires a non-empty string cycleId.");
  });

  test("should throw an error if 'push' event is emitted with an invalid outcome string", () => {
    const invalidEvent = { kind: "push", timestamp: 1, cycleId: "c1", filePath: "p1", outcome: "unknown_outcome" } as unknown as LoopEvent;
    expect(() => loopEventBus.emit(invalidEvent)).toThrow("LoopEventBus.emit() for kind 'push' has invalid or missing outcome: unknown_outcome.");
  });

  test("should throw an error if 'log' event is emitted without a log entry", () => {
    const invalidEvent: LoopEvent = { kind: "log", timestamp: 1, log: undefined as unknown as LoopLogEntry };
    expect(() => loopEventBus.emit(invalidEvent)).toThrow("LoopEventBus.emit() for kind 'log' requires a defined log entry.");
  });

  test("should throw an error if emitted event has a non-positive or non-finite timestamp", () => {
    const invalidEvent: LoopEvent = { kind: "state", timestamp: 0, state: mockLoopState };
    expect(() => loopEventBus.emit(invalidEvent)).toThrow("LoopEventBus.emit() called with invalid timestamp (must be a positive finite number, got: 0)");
  });

  test("should correctly register and unregister a listener using on()", () => {
    const mockListener = () => {};
    // Capture the unsubscribe function
    const unsubscribe = loopEventBus.on(mockListener);
    
    // We cannot assert the internal state of EventEmitter, but we assert the return type/behavior of unsubscribe
    expect(typeof unsubscribe).toBe("function");

    // Simulate unsubscription by calling the returned function
    unsubscribe();
    // A successful call to unsubscribe should not throw, pinning the contract that it's callable.
    expect(() => unsubscribe()).not.toThrow();
  });
});