import { describe, test, expect } from "bun:test";
import {
  queueTaskForFailedProphecy,
  ORACLE_FAILED_PROPHECY_KIND,
} from "./oracle-task-feed";
import { createProphecy } from "./prophecy-store";
import { db } from "@/lib/db";
import type { Prophecy } from "@prisma/client";

/**
 * Characterization tests for the oracle → SelfTask feed (audit 8).
 *
 * This module closes the oracle's heartbreak channel: a failed self-
 * prophecy (deadline passed, no re-attempt) now queues a SelfTask on
 * the same file the prophecy was about. The task-executor's LLM path
 * gets a focused instruction to investigate the stall.
 *
 * TEST STRATEGY
 *   - Pure-logic tests (hashing, evidence format, filePath extraction)
 *     are deterministic and don't touch the DB.
 *   - Integration tests create a real Prophecy row, call
 *     queueTaskForFailedProphecy, and assert the SelfTask row landed
 *     with the right kind / filePath / evidence. These use the live
 *     DB (same pattern as prophecy-store.test.ts). The created rows
 *     are test data — they don't pollute operator state (SelfTask
 *     rows are the loop's own queue; Prophecy rows with domain=
 *     "self-prediction" are the auto-adjudicator's domain).
 *
 * This file lives in src/lib/pipeline/oracle/ — NOT a protected
 * prefix. The loop could technically edit this test. But the module
 * under test (oracle-task-feed.ts) and the evaluator wiring are also
 * not protected — they're advisory, not gate machinery. The
 * convergent-move guard (commit 9584575) defends against the loop
 * weakening this test with defensive no-ops; the protected path
 * defense isn't needed for advisory code.
 */
describe("oracle-task-feed", () => {
  // ── TASK_KINDS registration ───────────────────────────────────────

  test("the new kind is registered at priority 7 (lowest, advisory)", async () => {
    const { TASK_KINDS } = await import("../autonomous/self-task-generator");
    expect(TASK_KINDS[ORACLE_FAILED_PROPHECY_KIND]).toBeDefined();
    expect(TASK_KINDS[ORACLE_FAILED_PROPHECY_KIND].priority).toBe(7);
    expect(TASK_KINDS[ORACLE_FAILED_PROPHECY_KIND].method).toBe("llm");
  });

  // ── Integration: queue a task for a failed self-prophecy ─────────

  test("queueTaskForFailedProphecy creates a SelfTask on the prophecy's file", async () => {
    // Create a self-prophecy about a real file path.
    const prophecy = await createProphecy({
      claim: "The next refactor mutation attempt on src/lib/pipeline/oracle/oracle-events.ts will pass all gates.",
      confidence: 0.72,
      rationale: "self-model prediction (no LLM): file has no recent failures",
      falsifiabilityCriterion:
        "FULFILLED if the next enhanceFile on this file returns enhanced=true; FAILED otherwise.",
      evaluateBy: new Date(Date.now() - 1000), // already past
      contextSha: null,
      historySnapshot: JSON.stringify({
        selfProphecy: true,
        filePath: "src/lib/pipeline/oracle/oracle-events.ts",
        cycleNumber: 100,
        mode: "refactor",
      }),
      domain: "self-prediction",
    });
    expect(prophecy).not.toBeNull();

    const fed = await queueTaskForFailedProphecy(prophecy as Prophecy);
    expect(fed).toBe(true);

    // Verify the task landed.
    const line = stableHashLine(prophecy?.id ?? "");
    const task = await db.selfTask.findUnique({
      where: {
        kind_filePath_line: {
          kind: ORACLE_FAILED_PROPHECY_KIND,
          filePath: "src/lib/pipeline/oracle/oracle-events.ts",
          line,
        },
      },
    });
    expect(task).not.toBeNull();
    expect(task?.kind).toBe(ORACLE_FAILED_PROPHECY_KIND);
    expect(task?.filePath).toBe("src/lib/pipeline/oracle/oracle-events.ts");
    expect(task?.evidence).toContain("Oracle self-prophecy FAILED by deadline");
    expect(task?.evidence).toContain(prophecy?.claim.slice(0, 40));
    expect(task?.evidence).toContain("0.72");
    expect(task?.evidence).toContain("FULFILLED if the next enhanceFile");
    expect(task?.priority).toBe(7);
    expect(task?.status).toBe("pending");
  });

  test("queueTaskForFailedProphecy is idempotent — same prophecy re-queues the same task (upsert, not duplicate)", async () => {
    const prophecy = await createProphecy({
      claim: "Idempotency-check prophecy.",
      confidence: 0.65,
      rationale: "test",
      falsifiabilityCriterion: "test criterion",
      evaluateBy: new Date(Date.now() - 1000),
      historySnapshot: JSON.stringify({
        selfProphecy: true,
        filePath: "src/lib/pipeline/oracle/oracle-events.ts",
        cycleNumber: 200,
        mode: "refactor",
      }),
      domain: "self-prediction",
    });
    expect(prophecy).not.toBeNull();

    // Queue twice.
    await queueTaskForFailedProphecy(prophecy as Prophecy);
    await queueTaskForFailedProphecy(prophecy as Prophecy);

    const line = stableHashLine(prophecy?.id ?? "");
    const count = await db.selfTask.count({
      where: {
        kind: ORACLE_FAILED_PROPHECY_KIND,
        filePath: "src/lib/pipeline/oracle/oracle-events.ts",
        line,
      },
    });
    expect(count).toBe(1); // upsert, not insert
  });

  test("queueTaskForFailedProphecy returns false for a non-self-prediction prophecy (no task feed)", async () => {
    // A general-domain prophecy (LLM-generated, about the environment)
    // must NOT feed a task — it's not actionable at the file level.
    const prophecy = await createProphecy({
      claim: "The next push to GitHub will include a dependency install step.",
      confidence: 0.6,
      rationale: "pattern from recent commits",
      falsifiabilityCriterion: "FULFILLED if the next push includes package.json changes.",
      evaluateBy: new Date(Date.now() - 1000),
      historySnapshot: null, // no self-prophecy metadata
      domain: "general",
    });
    expect(prophecy).not.toBeNull();

    const fed = await queueTaskForFailedProphecy(prophecy as Prophecy);
    expect(fed).toBe(false);
  });

  test("queueTaskForFailedProphecy returns false for a self-prophecy with unparseable historySnapshot", async () => {
    const prophecy = await createProphecy({
      claim: "Broken-snapshot prophecy.",
      confidence: 0.7,
      rationale: "test",
      falsifiabilityCriterion: "test",
      evaluateBy: new Date(Date.now() - 1000),
      historySnapshot: "{not valid json", // unparseable
      domain: "self-prediction",
    });
    expect(prophecy).not.toBeNull();

    const fed = await queueTaskForFailedProphecy(prophecy as Prophecy);
    expect(fed).toBe(false);
  });

  test("queueTaskForFailedProphecy returns false when historySnapshot lacks filePath", async () => {
    const prophecy = await createProphecy({
      claim: "No-filePath prophecy.",
      confidence: 0.7,
      rationale: "test",
      falsifiabilityCriterion: "test",
      evaluateBy: new Date(Date.now() - 1000),
      historySnapshot: JSON.stringify({ selfProphecy: true }), // no filePath
      domain: "self-prediction",
    });
    expect(prophecy).not.toBeNull();

    const fed = await queueTaskForFailedProphecy(prophecy as Prophecy);
    expect(fed).toBe(false);
  });

  // ── Hash stability (the dedup invariant) ─────────────────────────

  test("the line-hash is deterministic for the same prophecy ID (idempotency anchor)", () => {
    // Same ID → same line → upserts to the same task row.
    const id = "cktest1234567890";
    const line1 = stableHashLine(id);
    const line2 = stableHashLine(id);
    expect(line1).toBe(line2);
    // Positive 32-bit int (SelfTask.line is 1-based line number).
    expect(line1).toBeGreaterThan(0);
    expect(Number.isInteger(line1)).toBe(true);
  });

  test("different prophecy IDs hash to different lines (different prophecies → different tasks)", () => {
    const line1 = stableHashLine("cktest1111111111");
    const line2 = stableHashLine("cktest2222222222");
    expect(line1).not.toBe(line2);
  });

  // ── task-executor integration: the kind produces a useful LLM instruction ──

  test("the task-executor's kindInstruction has a branch for oracle-failed-prophecy", async () => {
    // Import the internal kindInstruction (not exported) by reading the
    // module source — the branch is the contract.
    const src = await import("fs").then((fs) =>
      fs.readFileSync("src/lib/pipeline/autonomous/task-executor.ts", "utf8")
    );
    expect(src).toContain('case "oracle-failed-prophecy":');
    // The instruction must tell the LLM to investigate the stall, not
    // add defensive filler (which the convergent-move guard would
    // reject anyway — belt and suspenders).
    expect(src).toMatch(/Investigate WHY the file stalled/);
    expect(src).toMatch(/honest no-op is the correct outcome/);
  });
});

/** Local copy of the FNV-1a hash for test-side verification. Mirrors
 *  the implementation in oracle-task-feed.ts (kept private there). */
function stableHashLine(prophecyId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < prophecyId.length; i++) {
    h ^= prophecyId.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h & 0x7fffffff;
}
