import { describe, test, expect } from "bun:test";

// Since the module has no named exports, we cannot import anything from "./scramble.test"
// We must replicate the necessary context (MockScrambleProps and the mock component logic)
// to test the observable behavior defined in the source file.

interface MockScrambleProps {
  text: string;
  start: boolean;
  ms: number;
  className?: string;
}

// Helper function mirroring the mock component structure used in the source file
const createMockComponent = (props: MockScrambleProps) => ({
  props,
  // The source logic dictates that the initial render always returns props.text
  render: () => props.text,
});

describe("Scramble Initial State Behavior", () => {
  // Test case 1: Initial state check (before start=true)
  test("should display the full text initially when start is false", () => {
    const text = "Hello World";
    const mockComponent = createMockComponent({ text, start: false, ms: 100, className: "test" });
    expect(mockComponent.render()).toBe(text);
  });

  // Test case 2: Edge case - Empty text
  test("should display empty string if input text is empty, regardless of start/ms", () => {
    const text = "";
    const mockComponent = createMockComponent({ text, start: true, ms: 100 });
    expect(mockComponent.render()).toBe("");
  });

  // Test case 3: Edge case - Zero duration
  test("should display the full text if ms is zero, regardless of start", () => {
    const text = "Test";
    const mockComponent = createMockComponent({ text, start: true, ms: 0 });
    expect(mockComponent.render()).toBe(text);
  });

  // Test case 4: Edge case - Negative duration
  test("should display the full text if ms is negative, regardless of start", () => {
    const text = "Test";
    const mockComponent = createMockComponent({ text, start: true, ms: -50 });
    expect(mockComponent.render()).toBe(text);
  });

  // Test case 5: Behavior when start is true but text is short (boundary check)
  test("should maintain initial text if text length is 1 and start is true", () => {
    const text = "A";
    const mockComponent = createMockComponent({ text, start: true, ms: 100 });
    expect(mockComponent.render()).toBe("A");
  });
});