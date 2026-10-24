/**
 * Loop Event Bus — in-process pub/sub for streaming autonomous loop events
 * to the WebSocket mini-service. Lives in the Next.js server process so the
 * API routes can publish here and the WS mini-service (running on port 3003)
 * can poll via HTTP if needed, or — when running in the same process —
 * subscribe directly.
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

class LoopEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  public emit(evt: LoopEvent): boolean {
    return super.emit("event", evt);
  }

  public on(listener: (evt: LoopEvent) => void): () => void {
    super.on("event", listener);
    return () => {
      super.off("event", listener);
    };
  }
}

export const loopEventBus = new LoopEventBus();
