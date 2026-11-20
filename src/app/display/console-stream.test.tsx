import { describe, test, expect } from "bun:test";
import { orderLogRuns, type ConsoleLine } from "./console-stream";

/**
 * Tests for the pure ordering logic in ConsoleStream.
 *
 * The component itself (ConsoleStream) now uses useMemo + static styles
 * and requires a React render context — those integration concerns are
 * verified via Agent Browser end-to-end. These tests cover the pure
 * `orderLogRuns` transform: anchor preservation, log-run sorting,
 * malformed-entry filtering, and stability.
 */

describe("orderLogRuns", () => {
  test("returns empty array for empty input", () => {
    expect(orderLogRuns([])).toEqual([]);
  });

  test("preserves anchor (non-log) line positions exactly", () => {
    const lines: ConsoleLine[] = [
      { id: "1", type: "command", text: "cmd" },
      { id: "2", type: "output", text: "out" },
      { id: "3", type: "system", text: "sys" },
    ];
    const result = orderLogRuns(lines);
    expect(result.map((l) => l.id)).toEqual(["1", "2", "3"]);
  });

  test("sorts a run of log lines oldest→newest by timestamp", () => {
    // loop-status convention: newest first (unshift), so a batch arrives
    // in reverse chronological order. The orderer should flip them.
    const lines: ConsoleLine[] = [
      { id: "1", type: "log", text: "newest", ts: "12:35:00", logType: "info" },
      { id: "2", type: "log", text: "mid", ts: "12:34:30", logType: "info" },
      { id: "3", type: "log", text: "oldest", ts: "12:34:00", logType: "info" },
    ];
    const result = orderLogRuns(lines);
    // After sort: oldest (3), mid (2), newest (1)
    expect(result.map((l) => l.id)).toEqual(["3", "2", "1"]);
  });

  test("keeps log runs separated by anchors — each run sorts independently", () => {
    const lines: ConsoleLine[] = [
      { id: "1", type: "log", text: "b", ts: "12:34:30", logType: "info" },
      { id: "2", type: "log", text: "a", ts: "12:34:00", logType: "info" },
      { id: "3", type: "command", text: "cmd" }, // anchor
      { id: "4", type: "log", text: "d", ts: "12:35:30", logType: "info" },
      { id: "5", type: "log", text: "c", ts: "12:35:00", logType: "info" },
    ];
    const result = orderLogRuns(lines);
    // Run 1 (ids 1,2) sorts to 2,1. Anchor 3 stays. Run 2 (ids 4,5) sorts to 5,4.
    expect(result.map((l) => l.id)).toEqual(["2", "1", "3", "5", "4"]);
  });

  test("filters out malformed entries (missing id/type/text, null, non-object)", () => {
    const lines: unknown[] = [
      null,
      undefined,
      "not an object",
      { id: "1" }, // missing type
      { type: "command" }, // missing id
      { id: "2", type: "command", text: "valid" },
      { id: "3", type: "log", text: "valid log", logType: "info" },
    ];
    const result = orderLogRuns(lines as ConsoleLine[]);
    expect(result.map((l) => l.id)).toEqual(["2", "3"]);
  });

  test("handles log lines without a timestamp (NaN sort key sinks to bottom of run)", () => {
    const lines: ConsoleLine[] = [
      { id: "1", type: "log", text: "no ts", logType: "warn" },
      { id: "2", type: "log", text: "has ts", ts: "12:34:00", logType: "info" },
    ];
    const result = orderLogRuns(lines);
    // The one with a parseable ts sorts above the one without (NaN sinks).
    expect(result.map((l) => l.id)).toEqual(["2", "1"]);
  });

  test("does not mutate the input array (React state immutability)", () => {
    const lines: ConsoleLine[] = [
      { id: "1", type: "log", text: "b", ts: "12:35:00", logType: "info" },
      { id: "2", type: "log", text: "a", ts: "12:34:00", logType: "info" },
    ];
    const originalOrder = lines.map((l) => l.id);
    orderLogRuns(lines);
    // The input array's order must be untouched (the sort copies first).
    expect(lines.map((l) => l.id)).toEqual(originalOrder);
  });

  test("handles unknown logType without throwing (falls back to default style at render)", () => {
    const lines: ConsoleLine[] = [
      { id: "1", type: "log", text: "unknown log type", logType: "unknown" as unknown as ConsoleLine["logType"] },
    ];
    expect(() => orderLogRuns(lines)).not.toThrow();
    expect(orderLogRuns(lines).map((l) => l.id)).toEqual(["1"]);
  });
});
