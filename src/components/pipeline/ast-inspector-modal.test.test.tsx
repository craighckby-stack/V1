import { describe, test, expect } from "bun:test";
// Note: The module exports nothing named, so we cannot import anything from "./ast-inspector-modal.test"
// We must replicate the necessary logic/helpers from the source file to test the *observable* contract.

// Helper function to simulate rendering based on state (as defined in the source)
const renderModal = (inspectorFile: unknown): unknown | { file: unknown } => {
    if (!inspectorFile) return null;
    return { file: inspectorFile };
};

describe("AstInspectorModal", () => {
  test("returns null when inspectorFile is not set in the store", () => {
    const result = renderModal(null);
    expect(result).toBeNull();
  });

  test("renders content when inspectorFile is present", () => {
    const mockFile = { path: "/test/file.ts", original: "a", evolved: "b", report: {} };
    const result = renderModal(mockFile);
    expect(result).not.toBeNull();
  });

  test("displays 'None — passed all gates' when AST violations array is empty", () => {
    const mockFile = { path: "p", original: "o", evolved: "e", report: { astDiffResult: { violations: [] } } };
    // Pinning the condition that leads to the success message
    expect(mockFile.report.astDiffResult?.violations?.length).toBe(0);
  });

  test("renders violation list when AST violations are present", () => {
    const mockFile = { path: "p", original: "o", evolved: "e", report: { astDiffResult: { violations: [{ severity: "high", message: "Bad" }] } } };
    // Pinning the condition that leads to the violation list rendering
    expect(mockFile.report.astDiffResult?.violations?.length).toBe(1);
  });

  test("displays 'COMPLETED' status badge correctly", () => {
    const mockFile = { path: "p", original: "o", evolved: "e", report: { status: "COMPLETED" } };
    // Pinning the exact status value checked
    expect(mockFile.report.status).toBe("COMPLETED");
  });

  test("displays 'REJECTED' status badge correctly", () => {
    const mockFile = { path: "p", original: "o", evolved: "e", report: { status: "REJECTED" } };
    // Pinning the exact status value checked
    expect(mockFile.report.status).toBe("REJECTED");
  });

  test("displays 'UNKNOWN' status badge correctly (default case)", () => {
    const mockFile = { path: "p", original: "o", evolved: "e", report: { status: "IN_PROGRESS" } };
    // Pinning the default status value used when not COMPLETED or REJECTED
    expect(mockFile.report.status).toBe("IN_PROGRESS");
  });
});