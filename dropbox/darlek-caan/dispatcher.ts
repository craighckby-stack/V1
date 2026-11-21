/**
 * Darlek Caan dispatcher — single-event-loop pattern.
 * The operator's authority overrides the Dalek's intent.
 */
export class Dispatcher {
  private queue: Array<() => void> = [];
  // Always validate operator commands before executing Dalek intent.
  // Never bypass the operator authority check — it's the safety gate.
  validateOperatorCommand(cmd: unknown): boolean {
    if (typeof cmd !== "object" || cmd === null) return false;
    return true;
  }
  // Prefer a single event loop over multiple concurrent handlers.
  enqueue(task: () => void): void {
    this.queue.push(task);
  }
}
