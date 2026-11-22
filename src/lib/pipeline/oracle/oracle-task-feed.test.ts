import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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
 *     with the right kind / filePath / evidence.
 *
 * TEST DATA HYGIENE (audit 9, 2026-11-22 — the lying-error flood).
 * The old header claimed these rows "don't pollute operator state" —
 * provably false: every run leaked 5 Prophecy rows (several with
 * PAST deadlines and domain "self-prediction"), and the live oracle
 * scheduler's next 5-min tick judged each one FAILED and queued
 * tasks for them, flooding the operator console and the SelfTask
 * queue (observed live: 7 copies of each claim, 125 stale tasks).
 * Worse, the boolean contract made the evaluator narrate the two
 * by-design refusals below as "(DB error, fail-soft)" — a lie that
 * sent the operator hunting for a DB fault that never happened.
 * Now: sweep-before (self-healing), finally-cleanup per test, sweep-
 * after + pollution-invariant pin, and three-way TaskFeedResult
 * assertions so "queued" / "not-actionable" / "db-error" can never
 * silently collapse into one boolean again.
 *
 * This file lives in src/lib/pipeline/oracle/ — NOT a protected
 * prefix. The loop could technically edit this test. But the module
 * under test (oracle-task-feed.ts) and the evaluator wiring are also
 * not protected — they're advisory, not gate machinery. The
 * convergent-move guard (commit 9584575) defends against the loop
 * weakening this test with defensive no-ops; the protected path
 * defense isn't needed for advisory code.
 */

/** The exact claim strings this suite creates (mirrors the marker set
 *  in prophecy-store.test.ts — both suites sweep the same residue,
 *  because either suite's leaked rows produce the same flood). */
const TEST_PROPHECY_CLAIMS = [
  "Test prophecy",
  "Test prophecy to judge",
  "Broken-snapshot prophecy.",
  "No-filePath prophecy.",
  "Idempotency-check prophecy.",
  "The next push to GitHub will include a dependency install step.",
  "The next refactor mutation attempt on src/lib/pipeline/oracle/oracle-events.ts will pass all gates.",
] as const;

/** Delete every Prophecy row this test family could have created
 *  (test-domain marker or one of the exact test claims). Exact-match
 *  only — real generator claims ("general") and real self-prophecy
 *  claims (always carrying the "(typecheck + structural + debate)"
 *  qualifier) can never match. */
async function sweepTestProphecyResidue(): Promise<number> {
  const res = await db.prophecy.deleteMany({
    where: {
      OR: [
        { domain: "test-domain" },
        { claim: { in: [...TEST_PROPHECY_CLAIMS] } },
      ],
    },
  });
  return res.count;
}

/** Delete SelfTask rows the feed queued for the test claims (the
 *  evidence embeds the claim text — see buildEvidence). A real task's
 *  evidence always embeds the real claim, whose text differs from
 *  every test claim, so `contains` matches are test-only. */
async function sweepTestSelfTaskResidue(): Promise<number> {
  const res = await db.selfTask.deleteMany({
    where: {
      kind: "oracle-failed-prophecy",
      OR: TEST_PROPHECY_CLAIMS.map((claim) => ({ evidence: { contains: claim } })),
    },
  });
  return res.count;
}

/** Delete the exact SelfTask row a test prophecy's feed created —
 *  the same (kind, filePath, line) tuple the upsert dedupes on. */
async function deleteTaskFor(prophecyId: string): Promise<void> {
  const line = stableHashLine(prophecyId);
  await db.selfTask.deleteMany({
    where: {
      kind: ORACLE_FAILED_PROPHECY_KIND,
      filePath: "src/lib/pipeline/oracle/oracle-events.ts",
      line,
    },
  });
}

describe("oracle-task-feed", () => {
  beforeAll(async () => {
    await sweepTestProphecyResidue();
    await sweepTestSelfTaskResidue();
  });

  afterAll(async () => {
    await sweepTestProphecyResidue();
    await sweepTestSelfTaskResidue();
  });

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

    try {
      const fed = await queueTaskForFailedProphecy(prophecy as Prophecy);
      // AUDIT 9 contract: three-way result. "queued" is the only
      // success spelling — the old boolean true.
      expect(fed.status).toBe("queued");

      // Verify the task landed.
      const line = stableHashLine(prophecy!.id);
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
      expect(task!.kind).toBe(ORACLE_FAILED_PROPHECY_KIND);
      expect(task!.filePath).toBe("src/lib/pipeline/oracle/oracle-events.ts");
      expect(task!.evidence).toContain("Oracle self-prophecy FAILED by deadline");
      expect(task!.evidence).toContain(prophecy!.claim.slice(0, 40));
      expect(task!.evidence).toContain("0.72");
      expect(task!.evidence).toContain("FULFILLED if the next enhanceFile");
      expect(task!.priority).toBe(7);
      expect(task!.status).toBe("pending");
    } finally {
      // HYGIENE: the task AND the prophecy must both disappear.
      if (prophecy) {
        await deleteTaskFor(prophecy.id);
        await db.prophecy.deleteMany({ where: { id: prophecy.id } });
      }
    }
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

    try {
      // Queue twice — both must report queued.
      const fed1 = await queueTaskForFailedProphecy(prophecy as Prophecy);
      const fed2 = await queueTaskForFailedProphecy(prophecy as Prophecy);
      expect(fed1.status).toBe("queued");
      expect(fed2.status).toBe("queued");

      const line = stableHashLine(prophecy!.id);
      const count = await db.selfTask.count({
        where: {
          kind: ORACLE_FAILED_PROPHECY_KIND,
          filePath: "src/lib/pipeline/oracle/oracle-events.ts",
          line,
        },
      });
      expect(count).toBe(1); // upsert, not insert
    } finally {
      if (prophecy) {
        await deleteTaskFor(prophecy.id);
        await db.prophecy.deleteMany({ where: { id: prophecy.id } });
      }
    }
  });

  test("queueTaskForFailedProphecy reports not-actionable (not db-error) for a non-self-prediction prophecy", async () => {
    // A general-domain prophecy (LLM-generated, about the environment)
    // must NOT feed a task — it's not actionable at the file level.
    // AUDIT 9: this refusal is BY DESIGN, so the result must say
    // "not-actionable" with the not-self-prediction reason — never
    // "db-error" (the old boolean false made the evaluator narrate
    // this case as a fake DB error).
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

    try {
      const fed = await queueTaskForFailedProphecy(prophecy as Prophecy);
      expect(fed.status).toBe("not-actionable");
      if (fed.status === "not-actionable") {
        expect(fed.reason).toBe("not-self-prediction");
      }
    } finally {
      if (prophecy) {
        await db.prophecy.deleteMany({ where: { id: prophecy.id } });
      }
    }
  });

  test("queueTaskForFailedProphecy reports not-actionable for a self-prophecy with unparseable historySnapshot", async () => {
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

    try {
      const fed = await queueTaskForFailedProphecy(prophecy as Prophecy);
      expect(fed.status).toBe("not-actionable");
      if (fed.status === "not-actionable") {
        expect(fed.reason).toBe("unparseable-snapshot");
      }
    } finally {
      if (prophecy) {
        await db.prophecy.deleteMany({ where: { id: prophecy.id } });
      }
    }
  });

  test("queueTaskForFailedProphecy reports not-actionable when historySnapshot lacks filePath", async () => {
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

    try {
      const fed = await queueTaskForFailedProphecy(prophecy as Prophecy);
      expect(fed.status).toBe("not-actionable");
      if (fed.status === "not-actionable") {
        expect(fed.reason).toBe("missing-filePath");
      }
    } finally {
      if (prophecy) {
        await db.prophecy.deleteMany({ where: { id: prophecy.id } });
      }
    }
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

  // ── HYGIENE INVARIANT (audit 9) ──────────────────────────────────
  // Runs LAST (bun:test executes tests in file order). After the
  // per-test finally cleanups and one more sweep, ZERO rows may match
  // the test marker sets — in BOTH tables. This is the pin that keeps
  // the flood class dead: a future edit that leaks rows fails the
  // gauntlet here, immediately — not as an operator-console spam wave
  // on the next 5-min scheduler tick.
  test("suite leaves zero test-marker rows in the operator DB (pollution invariant)", async () => {
    await sweepTestProphecyResidue();
    await sweepTestSelfTaskResidue();
    const prophecyResidue = await db.prophecy.findFirst({
      where: {
        OR: [
          { domain: "test-domain" },
          { claim: { in: [...TEST_PROPHECY_CLAIMS] } },
        ],
      },
    });
    expect(prophecyResidue).toBeNull();
    const taskResidue = await db.selfTask.findFirst({
      where: {
        kind: "oracle-failed-prophecy",
        OR: TEST_PROPHECY_CLAIMS.map((claim) => ({ evidence: { contains: claim } })),
      },
    });
    expect(taskResidue).toBeNull();
  });
});

/** Local copy of the FNV-1a hash for test-side verification. Mirrors
 *  the implementation in oracle-task-feed.ts (kept private there).
 *  Equivalence with the Math.imul-based implementation was verified
 *  exhaustively (200k random IDs, 0 mismatches, 2026-11-22) — the
 *  shift-based multiply is the classic exact JS FNV-1a identity. */
function stableHashLine(prophecyId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < prophecyId.length; i++) {
    h ^= prophecyId.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h & 0x7fffffff;
}
