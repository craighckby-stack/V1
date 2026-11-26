import { describe, test, expect } from "bun:test";
import { synthesizeLoopSummary, type LoopSynthesisSummary, type SplitArchiveOutputs } from "./formatter";

describe("LoopSynthesisSummary Interface Contract", () => {
  test("LoopSynthesisSummary must contain totalCommits as a number", () => {
    const _summary: LoopSynthesisSummary = {
      totalCommits: 10,
      successfulCount: 5,
      failedCount: 5,
      enginesCount: 2,
      provenPatterns: [],
      regressionGuards: [],
    };
    expect(_summary.totalCommits).toBe(10);
  });

  test("LoopSynthesisSummary must contain successfulCount as a number", () => {
    const _summary: LoopSynthesisSummary = {
      totalCommits: 10,
      successfulCount: 5,
      failedCount: 5,
      enginesCount: 2,
      provenPatterns: [],
      regressionGuards: [],
    };
    expect(_summary.successfulCount).toBe(5);
  });

  test("LoopSynthesisSummary must contain failedCount as a number", () => {
    const _summary: LoopSynthesisSummary = {
      totalCommits: 10,
      successfulCount: 5,
      failedCount: 5,
      enginesCount: 2,
      provenPatterns: [],
      regressionGuards: [],
    };
    expect(_summary.failedCount).toBe(5);
  });

  test("LoopSynthesisSummary must contain enginesCount as a number", () => {
    const _summary: LoopSynthesisSummary = {
      totalCommits: 10,
      successfulCount: 5,
      failedCount: 5,
      enginesCount: 2,
      provenPatterns: [],
      regressionGuards: [],
    };
    expect(_summary.enginesCount).toBe(2);
  });

  test("LoopSynthesisSummary must contain provenPatterns as an array of objects", () => {
    const _summary: LoopSynthesisSummary = {
      totalCommits: 10,
      successfulCount: 5,
      failedCount: 5,
      enginesCount: 2,
      provenPatterns: [{ repo: "a", sha: "b", footprint: "c", summary: "d" }],
      regressionGuards: [],
    };
    expect(_summary.provenPatterns).toBeInstanceOf(Array);
    expect(_summary.provenPatterns.length).toBe(1);
  });

  test("LoopSynthesisSummary must contain regressionGuards as an array of objects", () => {
    const _summary: LoopSynthesisSummary = {
      totalCommits: 10,
      successfulCount: 5,
      failedCount: 5,
      enginesCount: 2,
      provenPatterns: [],
      regressionGuards: [{ repo: "a", sha: "b", footprint: "c", reason: "d" }],
    };
    expect(_summary.regressionGuards).toBeInstanceOf(Array);
    expect(_summary.regressionGuards.length).toBe(1);
  });
});