/**
 * Prophecy Evaluator — judges pending prophecies against the events
 * that actually happened.
 *
 * The evaluator is the "verification" half of the oracle subsystem. It:
 *   1. Finds pending prophecies whose evaluateBy deadline has passed.
 *   2. For each, gathers the events BETWEEN the prophecy's contextSha
 *      and the current HEAD (git log, new postmortems, new cycles, new
 *      worklog entries) — exactly the evidence window the prophecy
 *      claims to predict.
 *   3. Asks the LLM to judge: given this prophecy and this evidence,
 *      is the claim FULFILLED, FAILED, or RETIRED (unjudgeable)?
 *   4. Updates the DB with the verdict + the LLM's reasoning.
 *
 * The evaluator is the calibration metric's source of truth. If it's a
 * sycophant — if it tends to call things "fulfilled" — the system's
 * track record is a lie. So the evaluator prompt is deliberately
 * adversarial: it's told to be skeptical, to look hard for evidence
 * on BOTH sides, and to call RETIRED when the criterion is too vague
 * to judge. RETIRED is honest; FULFILLED-on-thin-evidence is not.
 *
 * The evaluator never fabricates. If the LLM returns unparseable JSON,
 * the prophecy stays pending — we don't guess. Same principle as the
 * generator and the debate tribunal.
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { llmComplete } from "../llm/agent-llm";
import { listDueProphecies, judgeProphecy } from "./prophecy-store";
import { emitOracleEvent } from "./oracle-events";
import { queueTaskForFailedProphecy } from "./oracle-task-feed";
import { db } from "@/lib/db";
import type { Prophecy } from "@prisma/client";

import { PROJECT_ROOT } from "../core/paths";
const WORKLOG_PATH = `${PROJECT_ROOT}/worklog.md`;

// How much post-prophecy evidence to gather. The window is bounded by
// (a) the prophecy's contextSha → HEAD for git, and (b) the prophecy's
// createdAt → now for the DB and worklog. We cap each source so a
// prophecy that's been pending for a long time doesn't produce a 50KB
// evidence dump — the LLM doesn't need every commit, just the ones
// that might bear on the claim.
const MAX_NEW_COMMITS = 40;
const MAX_NEW_POSTMORTEMS = 15;
const MAX_NEW_CYCLES = 20;
const MAX_WORKLOG_LINES = 80;

const EVALUATOR_SYSTEM = `You are the Evaluator subsystem of LOOP's Oracle. Your job is to judge whether a previously-made prophecy about LOOP's own future was fulfilled, failed, or is unjudgeable (retired).

You are STRICTLY ADVERSARIAL. Do NOT give the prophecy the benefit of the doubt. The system's calibration metric depends on honest judgment, not flattery. A prophecy called "fulfilled" on thin evidence corrupts the metric forever; a prophecy called "failed" or "retired" when the evidence is ambiguous is honest.

Your decision procedure:
1. Read the prophecy's claim carefully.
2. Read its falsifiabilityCriterion — this is the rubric the prophecy set for itself. Judge against THIS, not against a re-interpretation.
3. Read the evidence window: everything that happened in LOOP between when the prophecy was made and now.
4. Decide:
   - "fulfilled" — the criterion is clearly met by the evidence.
   - "failed" — the criterion is clearly NOT met, OR the deadline passed without the predicted event.
   - "retired" — the criterion is too vague to judge, OR the evidence is genuinely ambiguous and you cannot decide with confidence. RETIRED IS NOT A FAILURE — it's an honest "I can't tell." Use it when appropriate; don't avoid it.
5. Confidence in your verdict: 0.0-1.0. This is YOUR confidence in the judgment, not the prophecy's confidence. A 1.0 means the evidence is unambiguous; a 0.5 means it's a coin flip.

DO NOT:
- Reinterpret the claim to make it fit (or not fit) the evidence.
- Call something "fulfilled" because it kind of happened, if the criterion was more specific.
- Call something "failed" because you're skeptical of the prophecy's premise — judge the evidence, not the prophecy's worldview.
- Use "retired" as a way to avoid hard calls — use it when the criterion is genuinely unjudgeable.

Respond in STRICT JSON only, no prose:
{
  "verdict": "fulfilled" | "failed" | "retired",
  "verdictConfidence": <number 0.0-1.0>,
  "evidence": "<2-5 sentences: the specific events from the evidence window that informed your verdict>",
  "reasoning": "<2-4 sentences: how those events match (or don't match) the prophecy's falsifiabilityCriterion>"
}`;

/** Gather the evidence window for a prophecy: everything that happened
 *  between contextSha (or createdAt if SHA is null) and HEAD/now. Each
 *  source is labeled; failures are silently skipped. */
async function gatherEvidenceFor(prophecy: Prophecy): Promise<string> {
  const parts: string[] = [];

  // ── 1. Git log from contextSha..HEAD ──────────────────────────────
  // If the prophecy has a contextSha, the evidence window is exactly
  // the commits since that SHA. If contextSha is null (older prophecy
  // or git was unavailable at generation time), we fall back to a
  // fixed-window recent log — less precise but still useful.
  try {
    let log: string;
    if (prophecy.contextSha) {
      log = execSync(
        `git -C ${PROJECT_ROOT} log --oneline ${prophecy.contextSha}..HEAD 2>/dev/null | head -n ${MAX_NEW_COMMITS}`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
    } else {
      log = execSync(
        `git -C ${PROJECT_ROOT} log --oneline -n ${MAX_NEW_COMMITS} --since="${prophecy.createdAt.toISOString()}" 2>/dev/null`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
    }
    if (log) {
      parts.push(`=== COMMITS SINCE PROPHECY (newest first) ===\n${log}`);
    } else {
      parts.push("=== COMMITS SINCE PROPHECY ===\n(none — HEAD is unchanged from contextSha)");
    }
  } catch {
    /* git unavailable — skip */
  }

  // ── 2. New postmortems since the prophecy ─────────────────────────
  try {
    const postmortems = await db.postmortem.findMany({
      where: { lastAttemptAt: { gte: prophecy.createdAt } },
      orderBy: { lastAttemptAt: "desc" },
      take: MAX_NEW_POSTMORTEMS,
    });
    if (postmortems.length > 0) {
      const lines = postmortems.map(
        (p) => `- ${p.filePath}: ${p.failureType} — ${p.symptom} (attempts: ${p.attempts})`,
      );
      parts.push("=== POSTMORTEMS WRITTEN SINCE PROPHECY ===\n" + lines.join("\n"));
    } else {
      parts.push("=== POSTMORTEMS WRITTEN SINCE PROPHECY ===\n(none)");
    }
  } catch {
    /* DB unavailable — skip */
  }

  // ── 3. New autonomous cycles since the prophecy ────────────────────
  try {
    const cycles = await db.autonomousCycle.findMany({
      where: { startedAt: { gte: prophecy.createdAt } },
      orderBy: { startedAt: "desc" },
      take: MAX_NEW_CYCLES,
    });
    if (cycles.length > 0) {
      const lines = cycles.map(
        (c) => `- cycle #${c.cycleNumber} (${c.mode}, ${c.status}): scanned ${c.filesScanned}, committed ${c.filesCommitted}`,
      );
      parts.push("=== CYCLES RUN SINCE PROPHECY ===\n" + lines.join("\n"));
    } else {
      parts.push("=== CYCLES RUN SINCE PROPHECY ===\n(none — loop may not have run since the prophecy was made)");
    }
  } catch {
    /* DB unavailable — skip */
  }

  // ── 4. Worklog tail (entries since the prophecy) ──────────────────
  try {
    if (existsSync(WORKLOG_PATH)) {
      const worklog = readFileSync(WORKLOG_PATH, "utf-8");
      const lines = worklog.split("\n").slice(-MAX_WORKLOG_LINES).join("\n");
      if (lines.trim()) {
        parts.push(`=== WORKLOG (tail, last ${MAX_WORKLOG_LINES} lines) ===\n${lines}`);
      }
    }
  } catch {
    /* unreadable — skip */
  }

  return parts.join("\n\n");
}

/** Parsed evaluator response. */
interface RawVerdict {
  verdict?: unknown;
  verdictConfidence?: unknown;
  evidence?: unknown;
  reasoning?: unknown;
}

/** Validate the evaluator's JSON response. Same strict-no-fabrication
 *  rule as the generator: if the LLM returns garbage, the prophecy
 *  stays pending. We don't guess. */
function validateRawVerdict(raw: RawVerdict): {
  verdict: "fulfilled" | "failed" | "retired";
  evidence: string;
  reasoning: string;
} | null {
  if (typeof raw.verdict !== "string") return null;
  const v = raw.verdict.toLowerCase();
  if (v !== "fulfilled" && v !== "failed" && v !== "retired") return null;

  if (typeof raw.evidence !== "string" || raw.evidence.trim().length < 5) return null;
  if (typeof raw.reasoning !== "string" || raw.reasoning.trim().length < 5) return null;

  return {
    verdict: v,
    evidence: raw.evidence.trim().slice(0, 1000),
    reasoning: raw.reasoning.trim().slice(0, 1000),
  };
}

/** Same JSON-extraction logic as the generator, duplicated here to
 *  keep the modules decoupled. (A shared util would be cleaner; for
 *  now, the duplication is 30 lines and keeps each module readable.) */
function parseJsonFromResponse(content: string): RawVerdict | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as RawVerdict;
  } catch {
    /* fall through */
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]) as RawVerdict;
    } catch {
      /* fall through */
    }
  }
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as RawVerdict;
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Evaluate ALL due prophecies. Returns the per-prophecy outcomes.
 *  Used by the API route's "judge all pending" endpoint and by any
 *  background loop that periodically triggers evaluation.
 *
 *  Prophecies are evaluated SEQUENTIALLY — each evaluation is its own
 *  LLM call, and agent-llm.ts serializes them anyway. Sequential
 *  evaluation also means the evaluator never sees two judgments
 *  influenced by the same context window — each prophecy gets its
 *  own fresh evidence-gathered prompt. */
export async function evaluateDueProphecies(): Promise<{
  judged: Array<{ id: string; claim: string; verdict: string }>;
  skipped: Array<{ id: string; claim: string; reason: string; error: string }>;
}> {
  const due = await listDueProphecies();
  const judged: Array<{ id: string; claim: string; verdict: string }> = [];
  const skipped: Array<{ id: string; claim: string; reason: string; error: string }> = [];

  for (const prophecy of due) {
    // ── AUDIT 7: self-predictions are owned by the DETERMINISTIC
    // auto-adjudicator (oracle-auto.ts), never the LLM. One reaching
    // this function past its deadline is an ORPHAN — its file never
    // got re-attempted within the horizon, so no verdict ever landed
    // to trigger the adjudicator. The honest verdict is FAILED: the
    // predicted event (the next attempt passing) did not occur by the
    // deadline. Judged directly, NO LLM call, NO quota — this was
    // documented in oracle-auto.ts but not implemented until this
    // fix; without it the 5-min scheduler would LLM-judge every
    // self-prediction (quota waste + verdicts conflicting with the
    // deterministic judge).
    if (prophecy.domain === "self-prediction") {
      const evaluation =
        `Deterministic deadline verdict (no LLM): this self-prediction claimed the ` +
        `next attempt on its file would pass all gates. No such attempt occurred ` +
        `before the evaluateBy deadline, so the predicted event did not happen. ` +
        `(Confidence when made: ${prophecy.confidence.toFixed(2)}. ` +
        `Made at ${prophecy.createdAt.toISOString()}, deadline ${prophecy.evaluateBy.toISOString()}.)`;
      const updated = await judgeProphecy(prophecy.id, "failed", evaluation);
      if (updated) {
        emitOracleEvent(
          `Oracle self-prophecy FAILED (deadline passed, no re-attempt): "${prophecy.claim.slice(0, 80)}"`,
          "warn",
          "auto-adjudicator",
        );
        // AUDIT 8 — close the loop. A failed prophecy used to be a 5-min
        // heartbreak channel: judged, logged, and forgotten. Now it
        // feeds a SelfTask on the same file the prophecy was about,
        // carrying the claim + criterion as evidence. The task-executor
        // gets a focused instruction to investigate the stall. Fail-
        // soft: a DB error loses the task, never fails the verdict.
        const fed = await queueTaskForFailedProphecy(prophecy);
        if (!fed) {
          emitOracleEvent(
            `Oracle: failed to queue SelfTask for failed self-prophecy "${prophecy.claim.slice(0, 60)}" — verdict stands, task feed lost (DB error, fail-soft)`,
            "error",
            "auto-adjudicator",
          );
        }
        judged.push({ id: prophecy.id, claim: prophecy.claim, verdict: "failed" });
      } else {
        emitOracleEvent(
          `Oracle: DB update failed while deadline-judging self-prophecy "${prophecy.claim.slice(0, 60)}" — stays pending`,
          "error",
          "auto-adjudicator",
        );
        skipped.push({
          id: prophecy.id,
          claim: prophecy.claim,
          reason: "store-failed",
          error: "DB update failed",
        });
      }
      continue;
    }

    const evidence = await gatherEvidenceFor(prophecy);

    const userPrompt = `Prophecy (made on ${prophecy.createdAt.toISOString()}, deadline ${prophecy.evaluateBy.toISOString()}):

CLAIM: ${prophecy.claim}

CONFIDENCE (when made): ${prophecy.confidence}

FALSIFIABILITY CRITERION (the rubric you must judge against):
${prophecy.falsifiabilityCriterion}

RATIONALE (when made):
${prophecy.rationale}

=== EVIDENCE WINDOW (events since the prophecy was made) ===
${evidence || "(no evidence gathered — system may have no recent activity)"}`;

    const result = await llmComplete({
      systemPrompt: EVALUATOR_SYSTEM,
      userPrompt,
      temperature: 0.2, // low temperature — judgments should be deterministic
      maxTokens: 600,
    });

    if (!result.ok || !result.content.trim()) {
      skipped.push({
        id: prophecy.id,
        claim: prophecy.claim,
        reason: "llm-unavailable",
        error: result.error ?? "empty LLM response",
      });
      continue;
    }

    const raw = parseJsonFromResponse(result.content);
    if (!raw) {
      skipped.push({
        id: prophecy.id,
        claim: prophecy.claim,
        reason: "unparseable",
        error: "LLM response was not valid JSON",
      });
      continue;
    }

    const validated = validateRawVerdict(raw);
    if (!validated) {
      skipped.push({
        id: prophecy.id,
        claim: prophecy.claim,
        reason: "invalid-shape",
        error: "LLM response was JSON but failed validation",
      });
      continue;
    }

    // Compose the recorded evaluation: evidence + reasoning, so a
    // human reviewer (or future evaluator iteration) can audit how
    // the verdict was reached.
    const fullEvaluation = `[verdict: ${validated.verdict}]\n\nEvidence:\n${validated.evidence}\n\nReasoning:\n${validated.reasoning}`;

    const updated = await judgeProphecy(prophecy.id, validated.verdict, fullEvaluation);
    if (updated) {
      // Narrate the verdict in the console stream — the system reports
      // on the accuracy of its own predictions, fulfilled or not.
      emitOracleEvent(
        `Oracle verdict — ${validated.verdict.toUpperCase()}: "${prophecy.claim.slice(0, 100)}"`,
        validated.verdict === "fulfilled" ? "success" : validated.verdict === "failed" ? "error" : "warn",
        "evaluator",
      );
      judged.push({ id: prophecy.id, claim: prophecy.claim, verdict: validated.verdict });
    } else {
      emitOracleEvent(
        `Oracle: DB update failed while judging prophecy "${prophecy.claim.slice(0, 60)}" — stays pending`,
        "error",
        "evaluator",
      );
      skipped.push({
        id: prophecy.id,
        claim: prophecy.claim,
        reason: "store-failed",
        error: "DB update failed",
      });
    }
  }

  return { judged, skipped };
}

/** Evaluate a single prophecy by id, regardless of whether its deadline
 *  has passed. Used by the per-prophecy API route for manual triggers
 *  ("evaluate this one now"). Returns the verdict or null. */
export async function evaluateProphecyById(id: string): Promise<{
  ok: boolean;
  verdict?: string;
  error?: string;
}> {
  // Import here to avoid a circular dependency at module load time
  // (store imports db, this imports store — fine, but keeping it lazy
  // makes the import graph explicit).
  const { getProphecy } = await import("./prophecy-store");
  const prophecy = await getProphecy(id);
  if (!prophecy) return { ok: false, error: "Prophecy not found" };
  if (prophecy.status !== "pending") {
    return { ok: false, error: `Prophecy is already ${prophecy.status}` };
  }

  // AUDIT 7: self-predictions are never LLM-judged (the deterministic
  // auto-adjudicator owns them). A manual trigger on one judges it
  // directly: FAILED if its horizon passed without the predicted
  // re-attempt, otherwise left pending (the adjudicator will settle it
  // on the file's next verdict).
  if (prophecy.domain === "self-prediction") {
    if (prophecy.evaluateBy.getTime() > Date.now()) {
      return {
        ok: false,
        error: "Self-prediction not yet due — the deterministic adjudicator settles it on the file's next verdict",
      };
    }
    const evaluation =
      `Deterministic deadline verdict (manual trigger, no LLM): no re-attempt on the ` +
      `file occurred before the evaluateBy deadline, so the predicted event did not ` +
      `happen. (Confidence when made: ${prophecy.confidence.toFixed(2)}.)`;
    const updated = await judgeProphecy(prophecy.id, "failed", evaluation);
    if (!updated) return { ok: false, error: "DB update failed" };
    emitOracleEvent(
      `Oracle self-prophecy FAILED (manual deadline trigger): "${prophecy.claim.slice(0, 80)}"`,
      "warn",
      "auto-adjudicator",
    );
    return { ok: true, verdict: "failed" };
  }

  const evidence = await gatherEvidenceFor(prophecy);
  const userPrompt = `Prophecy (made on ${prophecy.createdAt.toISOString()}, deadline ${prophecy.evaluateBy.toISOString()}, manually-triggered evaluation):

CLAIM: ${prophecy.claim}

FALSIFIABILITY CRITERION:
${prophecy.falsifiabilityCriterion}

RATIONALE:
${prophecy.rationale}

=== EVIDENCE WINDOW ===
${evidence || "(no evidence gathered)"}`;

  const result = await llmComplete({
    systemPrompt: EVALUATOR_SYSTEM,
    userPrompt,
    temperature: 0.2,
    maxTokens: 600,
  });

  if (!result.ok || !result.content.trim()) {
    return { ok: false, error: result.error ?? "LLM unavailable" };
  }

  const raw = parseJsonFromResponse(result.content);
  if (!raw) return { ok: false, error: "Unparseable LLM response" };

  const validated = validateRawVerdict(raw);
  if (!validated) return { ok: false, error: "Invalid verdict shape" };

  const fullEvaluation = `[verdict: ${validated.verdict}]\n\nEvidence:\n${validated.evidence}\n\nReasoning:\n${validated.reasoning}`;
  const updated = await judgeProphecy(prophecy.id, validated.verdict, fullEvaluation);
  if (!updated) return { ok: false, error: "DB update failed" };

  return { ok: true, verdict: validated.verdict };
}
