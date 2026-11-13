/**
 * Oracle → SelfTask feed — the closure for failed prophecies.
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * Before this module, the oracle was a 5-min heartbreak channel: the
 * auto-adjudicator judged self-prophecies FAILED by deadline, emitted a
 * `warn` event ("Oracle self-prophecy FAILED (deadline passed, no re-
 * attempt)"), and stopped there. The failure was recorded in the
 * Prophecy table and narrated to the console stream — but it triggered
 * NOTHING. The loop kept producing new prophecies, kept failing them,
 * kept narrating the same warn, forever. The oracle was an instrument
 * panel with no actuators.
 *
 * This module is the actuator. A failed prophecy is a SIGNAL: the
 * system predicted its next attempt on file X would pass all gates,
 * and that attempt never happened (the file wasn't re-attempted within
 * the 10-min horizon). That signal is now fed back into the loop as a
 * SelfTask with kind `oracle-failed-prophecy`, pointing at the same
 * file the prophecy was about, carrying the claim + the failed
 * criterion as evidence. The task-executor's LLM path then gets a
 * focused instruction: investigate why the file stalled and either
 * fix the blocker or honestly no-op.
 *
 * The feedback loop is now closed:
 *   prophecy (predicted pass) → deadline passes → FAILED verdict
 *     → oracle-task-feed queues a SelfTask on the same file
 *       → task-executor runs the LLM with the prophecy as context
 *         → either a real fix lands, or an honest no-op is recorded
 *           (and the next prophecy on that file has fresh evidence)
 *
 * DEDUP: the SelfTask unique constraint is [kind, filePath, line]. The
 * line is a stable hash of the prophecy ID (positive 32-bit int), so
 * repeated failures on the SAME prophecy don't create duplicate tasks
 * — but a NEW prophecy on the same file (different prediction) gets a
 * different hash and a fresh task. This matches the task queue's
 * existing dedup semantics (one task per finding per line).
 *
 * BOUNDED: only self-prophecies (domain="self-prediction") feed tasks.
 * LLM-generated prophecies (domain="general") are about the system's
 * environment, not its own code — a failed "the next push will include
 * a dependency install step" prophecy is not a file-level actionable
 * signal. The auto-adjudicator in oracle-auto.ts already owns self-
 * prophecies; this module extends that ownership with the actuator.
 *
 * Pure leaf w.r.t. the oracle: imports only the db + the ProphecyRow
 * type + the TASK_KINDS registry. No pipeline-internal imports, no
 * LLM, no event emission (the prophecy-evaluator already emits the
 * warn event; this module just queues the task). Fail-soft: a DB
 * error loses the task, never fails the evaluator.
 */
import { db } from "@/lib/db";
import type { Prophecy } from "@prisma/client";
import { TASK_KINDS } from "../autonomous/self-task-generator";

/** The new task kind. Registered in TASK_KINDS at the bottom of this
 *  file's import chain — priority 7 (lowest, advisory). The loop
 *  consumes oracle-failed-prophecy tasks only after every higher-
 *  priority task kind is exhausted. This is deliberate: a failed
 *  prophecy is a soft signal, not an emergency. The file wasn't
 *  enhanced; the system's self-model was wrong. Investigating that
 *  matters. */
export const ORACLE_FAILED_PROPHECY_KIND = "oracle-failed-prophecy";

/** Hash a prophecy ID (cuid string) to a stable positive 32-bit
 *  integer for use as the SelfTask `line` field. The SelfTask unique
 *  constraint is [kind, filePath, line], so the same prophecy always
 *  maps to the same (kind, filePath, line) tuple → upsert dedupes.
 *  A different prophecy on the same file hashes differently → a new
 *  task is created (the old one's verdict may still be pending). */
function hashProphecyIdToLine(prophecyId: string): number {
  if (!prophecyId || typeof prophecyId !== 'string') {
    throw new Error("Prophecy ID must be a non-empty string for hashing.");
  }
  // FNV-1a 32-bit, then mask to positive int. Stable across runs and
  // platforms (no BigInt, no platform-dependent hash).
  let h = 0x811c9dc5;
  for (let i = 0; i < prophecyId.length; i++) {
    h ^= prophecyId.charCodeAt(i);
    // FNV prime multiply, keep in 32-bit range
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Mask to 2^31 - 1 (positive int32) — Prisma Int field is 32-bit signed,
  // and SelfTask.line is a 1-based line number, so positive only.
  return h & 0x7fffffff;
}

/** Extract the file path a self-prophecy was about, from its stashed
 *  historySnapshot JSON. Returns null for non-self-prophecies or
 *  unparseable snapshots — those don't feed tasks (see BOUNDED above). */
function filePathFromSelfProphecy(prophecy: Prophecy): string | null {
  if (prophecy.domain !== "self-prediction") return null;
  if (!prophecy.historySnapshot) return null;
  try {
    const meta = JSON.parse(prophecy.historySnapshot) as {
      selfProphecy?: boolean;
      filePath?: string;
    };
    if (meta.selfProphecy && typeof meta.filePath === "string") {
      return meta.filePath;
    }
  } catch {
    /* unparseable — skip */
  }
  return null;
}

/** Build the evidence string for the queued task. Carries the
 *  prophecy claim, the confidence, the deadline, and the failed
 *  criterion — everything the LLM executor needs to understand WHY
 *  this task exists without re-querying the Prophecy table. */
function buildEvidence(prophecy: Prophecy): string {
  const confidenceStr = prophecy.confidence !== undefined && prophecy.confidence !== null
    ? prophecy.confidence.toFixed(2)
    : "N/A";
  const createdAtStr = prophecy.createdAt?.toISOString() ?? "N/A";
  const evaluateByStr = prophecy.evaluateBy?.toISOString() ?? "N/A";

  return (
    `Oracle self-prophecy FAILED by deadline. ` +
    `Claim: "${prophecy.claim ?? "N/A"}". ` +
    `Confidence when made: ${confidenceStr}. ` +
    `Made at ${createdAtStr}, deadline ${evaluateByStr}. ` +
    `Criterion: ${prophecy.falsifiabilityCriterion ?? "N/A"}`
  );
}

/** Queue a SelfTask for a failed self-prophecy. Idempotent: the
 *  unique constraint [kind, filePath, line] means a second call for
 *  the same prophecy is an upsert that just refreshes the evidence.
 *  Returns true on success, false on DB error (fail-soft — the
 *  evaluator's verdict still stands; we just lose the task feed).
 *
 *  Called from prophecy-evaluator.ts at the FAILED-by-deadline branch.
 *  Never throws. */
export async function queueTaskForFailedProphecy(prophecy: Prophecy | undefined | null): Promise<boolean> {
  if (!prophecy) {
    // Input validation: Prophecy must exist to proceed.
    console.error("queueTaskForFailedProphecy called with null or undefined prophecy.");
    return false;
  }

  if (!prophecy.id) {
    console.error(`Prophecy ID is missing for prophecy ${JSON.stringify(prophecy)}`);
    return false;
  }

  const filePath = filePathFromSelfProphecy(prophecy);
  if (!filePath) return false; // not a self-prophecy — not actionable
  
  let line: number;
  try {
    line = hashProphecyIdToLine(prophecy.id);
  } catch (e) {
    console.error(`Failed to hash prophecy ID ${prophecy.id} for task creation:`, e);
    return false;
  }
  
  const evidence = buildEvidence(prophecy);
  const taskKind = TASK_KINDS[ORACLE_FAILED_PROPHECY_KIND];
  if (!taskKind) {
    console.error(`Task kind ${ORACLE_FAILED_PROPHECY_KIND} is not registered in TASK_KINDS.`);
    return false;
  }
  const priority = taskKind.priority ?? 7;

  try {
    await db.selfTask.upsert({
      where: {
        kind_filePath_line: {
          kind: ORACLE_FAILED_PROPHECY_KIND,
          filePath,
          line,
        },
      },
      update: {
        status: "pending",
        evidence,
        // Reset attempts only if the task had permanently failed — a
        // pending/in-progress task keeps its attempts count (the loop
        // may already be working on it).
      },
      create: {
        kind: ORACLE_FAILED_PROPHECY_KIND,
        filePath,
        line,
        evidence,
        priority,
      },
    });
    return true;
  } catch (error) {
    // Fail-soft: the evaluator's verdict still landed in the Prophecy
    // table. Losing the task feed is a lost opportunity, not a fault.
    // Log the error context for debugging, but return false as required by fail-soft contract.
    console.error(`Database error while queuing oracle-failed-prophecy task for file ${filePath} (ID: ${prophecy.id}, Line: ${line}):`, error);
    return false;
  }
}