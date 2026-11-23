/**
 * Loop Event Bus — in-process pub/sub for streaming autonomous loop events.
 * Uses composition (a private EventEmitter) instead of extends so we don't
 * fight EventEmitter's method signatures (TS2416).
 */

import { EventEmitter } from "events";
import { PipelineStageState } from "../core/unified-pipeline";
import { LoopLogEntry, LoopState } from "./loop-runtime";

export type LoopEvent =
  | { kind: "state"; timestamp: number; state: LoopState }
  | { kind: "log"; timestamp: number; log: LoopLogEntry }
  | {
      kind: "stage";
      timestamp: number;
      cycleId: string;
      filePath: string;
      stage: PipelineStageState;
    }
  | {
      // Push-lifecycle events: surface the TOCTOU conflict + heal path so
      // the console stream can narrate "remote moved mid-cycle, refetched,
      // retried, committed" instead of a bare "409 — skipped". The UI
      // already renders `log` events; this richer kind is for future
      // per-file push-status panels. Existing listeners switch on `kind`
      // so adding this variant is non-breaking.
      kind: "push";
      timestamp: number;
      cycleId: string;
      filePath: string;
      outcome:
        | "committed" // PUT succeeded (first attempt or after a TOCTOU heal)
        | "toctou_conflict" // 409 detected — refetching to compare content
        | "toctou_healed" // 409 + remote content unchanged → retried with fresh sha → committed
        | "skipped_remote_changed" // 409 + remote content CHANGED → skipped to avoid clobbering
        | "failed"; // non-409 error or 409 persisted across retries
      sha?: string; // the committed sha (on committed/healed) or last-seen remote sha
      attempt?: number; // which retry attempt produced this outcome (0-indexed)
    };

type LoopEventListener = (evt: LoopEvent) => void;

class LoopEventBus {
  private emitter: EventEmitter;

  constructor() {
    try {
      this.emitter = new EventEmitter();
      this.emitter.setMaxListeners(50);
    } catch (error) {
      // Ensure constructor throws if initialization fails, preventing partial state.
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize LoopEventBus EventEmitter: ${errorMessage}`);
    }
  }

  public emit(evt: LoopEvent): boolean {
    
    if (typeof evt.timestamp !== "number" || !Number.isFinite(evt.timestamp) || evt.timestamp <= 0) {
      throw new Error(`LoopEventBus.emit() called with invalid timestamp (must be a positive finite number, got: ${evt.timestamp})`);
    }
    
    // Input validation for specific kinds is necessary as the union type allows partial objects
    // that satisfy the overall type but lack required fields for specific logic paths.
    if (evt.kind === "state" && !evt.state) {
      throw new Error("LoopEventBus.emit() for kind 'state' requires a defined state object.");
    }
    if (evt.kind === "log" && !evt.log) {
      throw new Error("LoopEventBus.emit() for kind 'log' requires a defined log entry.");
    }
    if (evt.kind === "stage") {
      if (!evt.cycleId || typeof evt.cycleId !== "string" || evt.cycleId.length === 0) {
        throw new Error(`LoopEventBus.emit() for kind 'stage' requires a non-empty string cycleId.`);
      }
      if (!evt.filePath || typeof evt.filePath !== "string" || evt.filePath.length === 0) {
        throw new Error(`LoopEventBus.emit() for kind 'stage' requires a non-empty string filePath.`);
      }
      if (!evt.stage) {
        throw new Error("LoopEventBus.emit() for kind 'stage' requires a defined stage object.");
      }
    }
    if (evt.kind === "push") {
      if (!evt.cycleId || typeof evt.cycleId !== "string" || evt.cycleId.length === 0) {
        throw new Error(`LoopEventBus.emit() for kind 'push' requires a non-empty string cycleId.`);
      }
      if (!evt.filePath || typeof evt.filePath !== "string" || evt.filePath.length === 0) {
        throw new Error(`LoopEventBus.emit() for kind 'push' requires a non-empty string filePath.`);
      }
      
      const validOutcomes = ["committed", "toctou_conflict", "toctou_healed", "skipped_remote_changed", "failed"];
      if (typeof evt.outcome !== 'string' || !validOutcomes.includes(evt.outcome)) {
        throw new Error(`LoopEventBus.emit() for kind 'push' has invalid or missing outcome: ${evt.outcome}. Valid outcomes are: ${validOutcomes.join(', ')}`);
      }

      if (evt.attempt !== undefined) {
        if (typeof evt.attempt !== "number" || !Number.isInteger(evt.attempt) || evt.attempt < 0) {
          throw new Error(`LoopEventBus.emit() for kind 'push' has invalid attempt: ${evt.attempt}. Must be a non-negative integer.`);
        }
      }
      if (evt.sha !== undefined && typeof evt.sha !== 'string') {
        throw new Error(`LoopEventBus.emit() for kind 'push' has invalid sha: ${evt.sha}. Must be a string if provided.`);
      }
    }

    // EventEmitter.emit returns boolean | null. We return true if it didn't return null, false otherwise.
    return this.emitter.emit("event", evt) !== null;
  }

  public on(listener: LoopEventListener): () => void {
    if (typeof listener !== "function") {
      throw new Error("LoopEventBus.on() called with non-function listener");
    }
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}

export const loopEventBus = new LoopEventBus();