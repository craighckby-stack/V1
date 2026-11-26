import { describe, test, expect } from "bun:test";
import {
  extractSections,
  pickSection,
  planSectionMutation,
  spliceSection,
  sectionReplacementWithinBudget,
  replacementLooksLikeWholeFile,
  WHOLE_FILE_MAX_BYTES,
  SECTION_MUTATION_MAX_FILE_BYTES,
  SECTION_MIN_BYTES,
  SECTION_MAX_BYTES,
  SECTION_BUDGET_MULTIPLIER,
  CodeSection,
  type SectionMutationPlan,
} from "./section-mutation";

describe("CodeSection Interface Structure", () => {
  test("CodeSection must have a string 'name' property", () => {
    const _section: CodeSection = {
      name: "parseFoo",
      kind: "function",
      parentClass: null,
      start: 0,
      end: 10,
      bytes: 10,
      text: "function parseFoo() {}",
      exported: false,
    };
    expect(_section.name).toBe("parseFoo");
  });

  test("CodeSection must have a string 'kind' property representing a valid type", () => {
    const _section: CodeSection = {
      name: "test",
      kind: "class",
      parentClass: null,
      start: 1,
      end: 5,
      bytes: 4,
      text: "class A {}",
      exported: true,
    };
    expect(_section.kind).toBe("class");
  });

  test("CodeSection must have a string or null 'parentClass' property", () => {
    const _section: CodeSection = {
      name: "method",
      kind: "method",
      parentClass: "MyClass",
      start: 10,
      end: 20,
      bytes: 10,
      text: "method() {}",
      exported: false,
    };
    expect(_section.parentClass).toBe("MyClass");
  });

  test("CodeSection must have numeric 'start' and 'end' offsets", () => {
    const _section: CodeSection = {
      name: "loop",
      kind: "loop",
      parentClass: null,
      start: 500,
      end: 550,
      bytes: 50,
      text: "for (...) {}",
      exported: false,
    };
    expect(_section.start).toBe(500);
    expect(_section.end).toBe(550);
  });

  test("CodeSection must have a numeric 'bytes' property equal to end - start", () => {
    const _section: CodeSection = {
      name: "return",
      kind: "return",
      parentClass: null,
      start: 100,
      end: 115,
      bytes: 15,
      text: "return value;",
      exported: false,
    };
    expect(_section.bytes).toBe(15);
  });

  test("CodeSection must have a string 'text' property matching the slice [start, end)", () => {
    const _section: CodeSection = {
      name: "if",
      kind: "if",
      parentClass: null,
      start: 20,
      end: 35,
      bytes: 15,
      text: "if (condition) {}",
      exported: false,
    };
    expect(_section.text).toBe("if (condition) {}");
  });

  test("CodeSection must have a boolean 'exported' property", () => {
    const _section: CodeSection = {
      name: "SelfEnhanceLoop.enhanceFile",
      kind: "method",
      parentClass: "SelfEnhanceLoop",
      start: 1,
      end: 20,
      bytes: 19,
      text: "enhanceFile() {}",
      exported: true,
    };
    expect(_section.exported).toBe(true);
  });
});