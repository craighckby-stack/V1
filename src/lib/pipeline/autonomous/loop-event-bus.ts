/**
 * Loop Event Bus — in-process pub/sub for streaming autonomous loop events
 * to the WebSocket mini-service. Lives in the Next.js server process so the
 * API routes can publish here and subscribers (WS bridge, status pollers)
 * can subscribe directly.
 *
 * Note: deliberately does NOT extend EventEmitter — the overloaded
 * emit/on signatures conflicted with EventEmitter's typed API.
 */

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

class LoopEventBus {
  private listeners = new Set<(evt: LoopEvent) => void>();

  /** Publish an event to all subscribers. */
  public emit(evt: LoopEvent): boolean {
    if (this.listeners.size === 0) return false;
    for (const listener of this.listeners) {
      try {
        listener(evt);
      } catch {
        // A broken subscriber must not break the publisher — remove it.
        this.listeners.delete(listener);
      }
    }
    return true;
  }

  /** Subscribe to events. Returns an unsubscribe function. */
  public on(listener: (evt: LoopEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const loopEventBus = new LoopEventBus();
