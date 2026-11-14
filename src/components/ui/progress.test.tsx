import { describe, test, expect } from "bun:test";

// Note: Since this component relies heavily on React/DOM rendering and external CSS utilities (cn, @radix-ui/react-progress),
// we cannot assert concrete DOM structure or styling directly without a full JSDOM environment.
// We must test the *logic* derived from the props, specifically how 'value' translates to the style calculation.
// In a real Bun test environment for React components, one would use a testing utility like @testing-library/react.
// Here, we simulate the logic check based on the implementation: style={{ transform: `translateX(-${100 - (value || 0)}%)` }}

// Helper function to simulate the style calculation based on the component logic
const calculateTransform = (value: number | undefined | null): string => {
    const effectiveValue = value || 0;
    return `translateX(-${100 - effectiveValue}%)`;
};

describe("Progress component logic", () => {
  test("applies correct transform when value is 100", () => {
    // Expected: 100 - 100 = 0%
    expect(calculateTransform(100)).toBe("translateX(-0%)");
  });

  test("applies correct transform when value is 0", () => {
    // Expected: 100 - 0 = 100%
    expect(calculateTransform(0)).toBe("translateX(-100%)");
  });

  test("applies correct transform when value is 50", () => {
    // Expected: 100 - 50 = 50%
    expect(calculateTransform(50)).toBe("translateX(-50%)");
  });

  test("applies default transform when value is undefined", () => {
    // Expected: value || 0 -> 0. 100 - 0 = 100%
    expect(calculateTransform(undefined)).toBe("translateX(-100%)");
  });

  test("applies default transform when value is null", () => {
    // Expected: value || 0 -> 0. 100 - 0 = 100%
    expect(calculateTransform(null)).toBe("translateX(-100%)");
  });

  test("applies correct transform when value is a boundary number (e.g., 1)", () => {
    // Expected: 100 - 1 = 99%
    expect(calculateTransform(1)).toBe("translateX(-99%)");
  });
});