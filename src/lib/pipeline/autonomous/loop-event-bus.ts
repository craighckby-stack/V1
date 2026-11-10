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
  private emitter: EventEmitter | null = null;
  private readonly listeners = new Set<LoopEventListener>();

  constructor() {
    try {
      this.emitter = new EventEmitter();
      this.emitter.setMaxListeners(50);
    } catch (error) {
      // Ensure constructor throws if initialization fails, preventing partial state.
      throw new Error(`Failed to initialize LoopEventBus EventEmitter: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public emit(evt: LoopEvent): boolean {
    if (!this.emitter) {
      // This should ideally never happen if constructor succeeded, but kept for robustness.
      throw new Error("LoopEventBus.emit() called on uninitialized EventEmitter");
    }
    if (typeof evt !== 'object' || evt === null) {
      throw new Error("LoopEventBus.emit() called with null or non-object event");
    }
    if (typeof evt.timestamp !== "number" || evt.timestamp <= 0) {
      throw new Error(`LoopEventBus.emit() called with invalid timestamp (must be a positive number, got: ${evt.timestamp})`);
    }
    if (!evt.kind || typeof evt.kind !== "string") {
      throw new Error("LoopEventBus.emit() called with missing or invalid kind");
    }

    // Input validation for kinds requiring cycleId and filePath
    if ((evt.kind === "stage" || evt.kind === "push") && (!evt.cycleId || typeof evt.cycleId !== "string" || !evt.filePath || typeof evt.filePath !== "string")) {
      throw new Error(`LoopEventBus.emit() for kind '${evt.kind}' requires non-empty string cycleId and filePath.`);
    }

    return this.emitter.emit("event", evt);
  }

  public on(listener: LoopEventListener): () => void {
    if (!this.emitter) {
      throw new Error("LoopEventBus.on() called on uninitialized EventEmitter");
    }
    if (typeof listener !== "function") {
      throw new Error("LoopEventBus.on() called with non-function listener");
    }
    this.emitter.on("event", listener);
    this.listeners.add(listener);
    return () => {
      if (this.emitter) {
        this.emitter.off("event", listener);
      }
      this.listeners.delete(listener);
    };
  }
}

export const loopEventBus = new LoopEventBus();