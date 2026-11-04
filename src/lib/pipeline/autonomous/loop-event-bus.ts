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
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  public emit(evt: LoopEvent): boolean {
    return this.emitter.emit("event", evt);
  }

  public on(listener: LoopEventListener): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}

export const loopEventBus = new LoopEventBus();
