import { describe, test, expect } from "bun:test";
import { cn } from "./utils"; // Assuming utils.ts is in the same directory or accessible via relative path

describe("cn", () => {
  test("correctly merges two simple class strings", () => {
    // clsx(['class1', 'class2']) -> 'class1 class2'
    // twMerge('class1 class2') -> 'class1 class2'
    expect(cn("class1", "class2")).toBe("class1 class2");
  });

  test("handles a single class string input", () => {
    expect(cn("only-class")).toBe("only-class");
  });

  test("handles no arguments resulting in an empty string", () => {
    // clsx() -> ''
    // twMerge('') -> ''
    expect(cn()).toBe("");
  });

  test("correctly resolves Tailwind merge conflicts (e.g., 'text-red-500' vs 'text-blue-500')", () => {
    // twMerge prioritizes the later class if they conflict (e.g., text-red-500 followed by text-blue-500 results in text-blue-500)
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  test("handles mixed string and object inputs from clsx", () => {
    // clsx(['a', { b: true }, 'c']) -> 'a b c'
    expect(cn("a", { b: true }, "c")).toBe("a b c");
  });
});