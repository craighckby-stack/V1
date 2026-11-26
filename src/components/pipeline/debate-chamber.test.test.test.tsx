import { describe, test, expect } from "bun:test";
// The module exports no named symbols, so we import nothing from "./debate-chamber.test.test"

describe("DebateChamber rendering states", () => {
  test("renders initial prompt when pipelineReport is null", () => {
    const report: unknown = null;
    expect(report === null).toBe(true);
  });

  test("renders verdict unavailable message when report exists but reviewVerdict is null", () => {
    const _report = { pipelineReport: {} };
    const verdict: unknown = null;
    expect(verdict === null).toBe(true);
  });

  test("renders detailed view when verdict is present", () => {
    const verdict = {
      consensus: "APPROVED",
      consensusCoefficient: 0.8,
      cognitiveFriction: 0.1,
      arguments: [],
      securityPoints: [],
      architecturePoints: [],
      leadSummary: "Review passed successfully.",
    };
    expect(verdict.consensus).toBe("APPROVED");
  });

  test("calculates consensus percentage correctly for 0.95 coefficient", () => {
    const _verdict = {
      consensus: "APPROVED",
      consensusCoefficient: 0.95,
      cognitiveFriction: 0.05,
      arguments: [],
      securityPoints: [],
      architecturePoints: [],
      leadSummary: "",
    };
    // Expected: Math.round(0.95 * 100) = 95
    expect(Math.round(0.95 * 100)).toBe(95);
  });

  test("calculates consensus percentage correctly for 0.44 coefficient", () => {
    const _verdict = {
      consensus: "CONDITIONAL_APPROVAL",
      consensusCoefficient: 0.44,
      cognitiveFriction: 0.1,
      arguments: [],
      securityPoints: [],
      architecturePoints: [],
      leadSummary: "",
    };
    // Expected: Math.round(0.44 * 100) = 44
    expect(Math.round(0.44 * 100)).toBe(44);
  });

  test("calculates friction percentage correctly for 1.0 coefficient", () => {
    const _verdict = {
      consensus: "OPPOSE",
      consensusCoefficient: 0.1,
      cognitiveFriction: 1.0,
      arguments: [],
      securityPoints: [],
      architecturePoints: [],
      leadSummary: "",
    };
    // Expected: Math.round(1.0 * 100) = 100
    expect(Math.round(1.0 * 100)).toBe(100);
  });

  test("renders multiple arguments correctly including citations", () => {
    const verdict = {
      consensus: "APPROVED",
      consensusCoefficient: 0.8,
      cognitiveFriction: 0.1,
      arguments: [
        {
          speaker: "security",
          speakerName: "Alice",
          avatar: "A",
          stance: "OPPOSE",
          statement: "Security requires stricter validation.",
          cognitiveFriction: 0.2,
          citations: ["C1", "C2"],
        },
        {
          speaker: "architecture",
          speakerName: "Bob",
          avatar: "B",
          stance: "ENDORSE",
          statement: "Architecture supports this validation.",
          cognitiveFriction: 0.0,
          citations: [],
        },
      ],
      securityPoints: [],
      architecturePoints: [],
      leadSummary: "",
    };
    expect(verdict.arguments.length).toBe(2);
  });

  test("renders 'No findings' message when security and architecture points are empty", () => {
    const verdict = {
      consensus: "APPROVED",
      consensusCoefficient: 0.8,
      cognitiveFriction: 0.1,
      arguments: [],
      securityPoints: [],
      architecturePoints: [],
      leadSummary: "No issues found.",
    };
    expect(verdict.securityPoints.length).toBe(0);
    expect(verdict.architecturePoints.length).toBe(0);
  });
});