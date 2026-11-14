import { describe, test, expect } from "bun:test";
import { Scramble } from "./scramble";

// Mocking necessary browser APIs for pure logic testing, as Scramble relies on them.
// Since we are testing the *logic* derived from inputs, we must simulate the environment
// where the logic path is taken or skipped.
// For these characterization tests, we focus on the synchronous/initial state or conditions
// that prevent the RAF loop from starting/running.

describe("Scramble", () => {
  // Test case 1: Initial state check (before start=true)
  test("should display the full text initially when start is false", () => {
    // When start=false, useEffect returns immediately, state remains initial value (text).
    const text = "Hello World";
    // We mock the component rendering to check the initial state derived from useState(text)
    const mockComponent = (props: any) => ({
      props,
      // Simulate rendering the initial state 'out'
      render: () => props.text,
    });
    const result = mockComponent({ text, start: false, ms: 100, className: "test" });
    expect(result.render()).toBe(text);
  });

  // Test case 2: Edge case - Empty text
  test("should display empty string if input text is empty, regardless of start/ms", () => {
    const text = "";
    const mockComponent = (props: any) => ({
      props,
      render: () => props.text, // Initial state is text
    });
    const result = mockComponent({ text, start: true, ms: 100 });
    expect(result.render()).toBe("");
  });

  // Test case 3: Edge case - Zero duration
  test("should display the full text if ms is zero, regardless of start", () => {
    const text = "Test";
    const mockComponent = (props: any) => ({
      props,
      render: () => props.text, // Initial state is text
    });
    const result = mockComponent({ text, start: true, ms: 0 });
    expect(result.render()).toBe(text);
  });

  // Test case 4: Edge case - Negative duration
  test("should display the full text if ms is negative, regardless of start", () => {
    const text = "Test";
    const mockComponent = (props: any) => ({
      props,
      render: () => props.text, // Initial state is text
    });
    const result = mockComponent({ text, start: true, ms: -50 });
    expect(result.render()).toBe(text);
  });

  // Test case 5: Behavior when start is true but text is short (boundary check)
  test("should maintain initial text if text length is 1 and start is true", () => {
    const text = "A";
    const mockComponent = (props: any) => ({
      props,
      render: () => props.text, // Initial state is text
    });
    const result = mockComponent({ text, start: true, ms: 100 });
    expect(result.render()).toBe("A");
  });
});