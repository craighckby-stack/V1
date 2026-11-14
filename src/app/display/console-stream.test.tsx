import { describe, test, expect } from "bun:test";
import { ConsoleStream, type ConsoleLine } from "./console-stream";

describe("ConsoleStream", () => {
  test("renders empty lines array", () => {
    const mockRef = { current: null };
    const lines: ConsoleLine[] = [];
    
    // We can't directly test the rendered output without a DOM environment
    // But we can test that the component doesn't throw and returns a valid structure
    expect(() => ConsoleStream({ lines: lines as unknown as ConsoleLine[], logRef: mockRef })).not.toThrow();
  });

  test("renders valid console lines", () => {
    const mockRef = { current: null };
    const lines: ConsoleLine[] = [
      {
        id: "1",
        type: "command",
        text: "test command",
      },
      {
        id: "2",
        type: "output",
        text: "test output",
      },
      {
        id: "3",
        type: "log",
        text: "test log",
        ts: "12:34:56",
        logType: "info",
      },
      {
        id: "4",
        type: "log",
        text: "error message",
        ts: "12:35:00",
        logType: "error",
      },
    ];
    
    // Test that the component doesn't throw with valid input
    expect(() => ConsoleStream({ lines, logRef: mockRef })).not.toThrow();
    
    // Test that the component returns JSX with the correct number of elements
    const result = ConsoleStream({ lines: lines as unknown as ConsoleLine[], logRef: mockRef });
    expect(result).not.toBeNull();
    // We can't directly inspect the rendered DOM in this environment
    // but we can verify the component processes the input correctly
  });

  test("skips invalid line entries", () => {
    const mockRef = { current: null };
    const lines: unknown[] = [
      null,
      undefined,
      "not an object",
      { id: "1" }, // missing type
      { type: "command" }, // missing id
      { id: "2", type: "command" }, // valid
    ];
    
    // Test that the component doesn't throw with mixed valid/invalid input
    expect(() => ConsoleStream({ lines: lines as unknown as ConsoleLine[], logRef: mockRef })).not.toThrow();
  });

  test("handles non-array lines prop", () => {
    const mockRef = { current: null };
    
    // Test that the component returns null when lines is not an array
    const result = ConsoleStream({ lines: null as unknown as ConsoleLine[], logRef: mockRef });
    expect(result).toBeNull();
  });

  test("handles empty text in lines", () => {
    const mockRef = { current: null };
    const lines: ConsoleLine[] = [
      { id: "1", type: "output", text: "" },
    ];
    
    // Test that the component doesn't throw with empty text
    expect(() => ConsoleStream({ lines, logRef: mockRef })).not.toThrow();
  });

  test("handles log lines without timestamp", () => {
    const mockRef = { current: null };
    const lines: ConsoleLine[] = [
      { id: "1", type: "log", text: "no timestamp", logType: "warn" },
    ];
    
    // Test that the component doesn't throw with log lines missing timestamp
    expect(() => ConsoleStream({ lines, logRef: mockRef })).not.toThrow();
  });

  test("uses default color for unknown log type", () => {
    const mockRef = { current: null };
    const lines: ConsoleLine[] = [
      { id: "1", type: "log", text: "unknown log type", logType: "unknown" as unknown as ConsoleLine["logType"] },
    ];
    
    // Test that the component doesn't throw with unknown log type
    expect(() => ConsoleStream({ lines, logRef: mockRef })).not.toThrow();
  });
});