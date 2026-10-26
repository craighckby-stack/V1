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
