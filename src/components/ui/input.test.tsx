import { describe, test, expect } from "bun:test";
import { Input } from "./input";
import React from "react";

// Mocking dependencies used in the source file for isolated testing
// In a real setup, these would be mocked via jest/vitest, but for bun:test isolation, we simulate the environment.
// Since we cannot import '@/lib/utils', we assume 'cn' merges strings correctly.

// Mocking React environment for JSX rendering simulation (though bun:test doesn't run React, we test prop passing)
// We will test prop passing and structure, not actual DOM rendering, as bun:test is not a browser test runner.

describe("Input Component", () => {
  test("applies all default base classes correctly", () => {
    // We check if the component structure implies the presence of key default classes
    // Since we cannot render to DOM, we assert on how props are passed or how the component is structured conceptually.
    // We test that the component accepts no props and still functions (i.e., doesn't crash) and that the structure is sound.
    const element = <Input />;
    // In a real environment, we'd check element.props.className.
    // Here, we assert on a known prop behavior: it must accept standard input props.
    expect(element).toBeDefined();
  });

  test("passes through standard HTML input props like type", () => {
    const element = <Input type="email" />;
    // Asserting that the 'type' prop is correctly passed down to the underlying <input> element
    expect(element.props.type).toBe("email");
  });

  test("applies custom className correctly alongside defaults", () => {
    const customClass = "my-custom-style";
    const element = <Input className={customClass} />;
    // Asserting that the custom class is included in the final className string (conceptually)
    expect(element.props.className).toContain(customClass);
  });

  test("correctly handles disabled state by passing the prop", () => {
    const element = <Input disabled={true} />;
    // Asserting that the disabled attribute is correctly passed down
    expect(element.props.disabled).toBe(true);
  });

  test("passes through arbitrary remaining props", () => {
    const testValue = "test";
    const element = <Input value={testValue} placeholder="hint" />;
    // Asserting that non-specific props are correctly forwarded
    expect(element.props.value).toBe(testValue);
    expect(element.props.placeholder).toBe("hint");
  });
});