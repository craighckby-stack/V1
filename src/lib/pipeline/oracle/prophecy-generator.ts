/**
 * Prophecy Generator — produces a falsifiable prediction about the
 * system's own future, grounded in its own history.
 *
 * The generator is the "prediction" half of the oracle subsystem. It:
 *   1. Gathers the system's recent primary sources (git log, worklog,
 *      active postmortems, recent autonomous cycles).
 *   2. Builds a context prompt that lets the LLM reason from the SAME
 *      evidence a human reviewer would look at.
 *   3. Asks the LLM for a single prophecy in strict JSON format, with a
 *      falsifiability criterion. Without a criterion, the prophecy is
 *      rejected at parse time — vague predictions can never be judged
 *      and would inflate the pending count forever.
 *   4. Validates the parsed shape (confidence in [0,1], evaluateBy in
 *      the future, all required fields non-empty).
 *   5. Persists via the store.
 *
 * The generator is DELIBERATELY lazy: one prophecy per call. A caller
 * that wants many prophecies calls it repeatedly. This keeps the LLM
 * call cost per prophecy transparent (no batched prompt that produces
 * five prophecies for the price of one — that would also collapse the
 * calibration metric, since they'd be correlated by being generated
 * together).
 *
 * No fabrication: if the LLM returns unparseable JSON, the prophecy is
 * rejected. We never "fill in" missing fields or fix a malformed
 * criterion. Same honesty principle as the debate tribunal.
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { llmComplete } from "../llm/agent-llm";
import { createProphecy, type ProphecyRow } from "./prophecy-store";
import { emitOracleEvent } from "./oracle-events";
import { db } from "@/lib/db";

import { PROJECT_ROOT } from "../core/paths";
const WORKLOG_PATH = `${PROJECT_ROOT}/worklog.md`;

// How much history to give the LLM. Too little → predictions are
// ungrounded. Too much → context window bloat + cost. 20 commits + 60
// worklog lines + 10 postmortems + 10 cycles is a balance point: enough
// to see real patterns, not so much that signal gets diluted.
const GIT_LOG_COUNT = 20;
const WORKLOG_TAIL_LINES = 60;
const POSTMORTEM_LIMIT = 10;
const CYCLE_LIMIT = 10;

// The LLM system prompt: tells the model what it is, what it's doing,
// and the strict JSON shape it must return. The "you are not an
// optimist" framing matters — without it, LLMs default to predicting
// positive outcomes ("the system will improve") because that's the
// helpful-assistant prior. Predictions of failure are just as useful
// for the calibration metric and more diagnostic about the system.
const PROPHECY_SYSTEM = `You are the Oracle subsystem of LOOP, an autonomous self-improvement system. LOOP scans its own source code, proposes enhancements through an LLM, gates them (AST diff, typecheck, build, ratchet tests, debate tribunal), pushes survivors to GitHub, and writes postmortems for failures.

Your job: produce ONE falsifiable prediction about LOOP's own near-term future. The prediction must be grounded in the history you're given. It must be specific enough that someone can later check whether it came true.

You are NOT an optimist. You are NOT a cheerleader. Predict failures as readily as successes — the system's calibration metric depends on honest prediction, not flattery. A confident prediction of failure that comes true is just as valuable as a confident prediction of success that comes true.

The prediction MUST have:
- A specific, time-bounded claim (e.g. "the next mutation", "within 5 cycles", "before the next push").
- A confidence between 0.0 and 1.0 reflecting your honest probability estimate.
- A falsifiability criterion: a precise description of what evidence would confirm or refute the claim. If you cannot state one, do not make the prophecy.

Avoid:
- Vague claims ("the system will continue to evolve") — never evaluable.
- Tautological claims ("the next cycle will run") — too easy to fulfill.
- Claims about the world outside LOOP (only predictions about LOOP itself are checkable).

Respond in STRICT JSON only, no prose:
{
  "claim": "<one-sentence future-tense prediction>",
  "confidence": <number 0.0-1.0>,
  "rationale": "<2-4 sentences: what historical patterns you're reasoning from>",
  "falsifiabilityCriterion": "<one sentence: what evidence would confirm or refute>",
  "domain": "<one of: llm | gates | push | postmortem | ui | system | other>",
  "horizonCycles": <integer 1-20: how many LOOP cycles until this can be judged>
}`;

/** Gather the system's recent primary sources into a single context
 *  string for the LLM prompt. Each source is labeled so the LLM knows
 *  what it's looking at. Failures (file missing, command fails) are
 *  silently skipped — the LLM gets whatever we have. */
function gatherHistoryContext(): { context: string; sha: string | null; snapshot: string } {
  const parts: string[] = [];
  let sha: string | null = null;

  // ── 1. Recent git log ──────────────────────────────────────────────
  try {
    const log = execSync(
      `git -C ${PROJECT_ROOT} log --oneline -n ${GIT_LOG_COUNT} 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (log) {
      parts.push("=== RECENT COMMITS (newest first) ===\n" + log);
      // Capture the current HEAD SHA for the prophecy's contextSha
      sha = execSync(`git -C ${PROJECT_ROOT} rev-parse HEAD 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    }
  } catch {
    /* git unavailable or no repo — skip */
  }

  // ── 2. Worklog tail ────────────────────────────────────────────────
  try {
    if (existsSync(WORKLOG_PATH)) {
      const worklog = readFileSync(WORKLOG_PATH, "utf-8");
      const lines = worklog.split("\n").slice(-WORKLOG_TAIL_LINES).join("\n");
      if (lines.trim()) {
        parts.push("=== WORKLOG (tail) ===\n" + lines);
      }
    }
  } catch {
    /* unreadable — skip */
  }

  // ── 3. Active postmortems (awaited by the caller) ─────────────────
  // Done separately because it's async — see gatherHistoryContextAsync
  // below. gatherHistoryContext is the sync portion.

  // Build the snapshot summary: a one-line-per-source digest that we
  // store alongside the prophecy, so the evaluator sees what the LLM
  // saw without having to reconstruct it.
  const snapshot = parts
    .map((p) => {
      const firstLine = p.split("\n")[0];
      const lineCount = p.split("\n").length;
      return `${firstLine} (${lineCount} lines)`;
    })
    .join("\n");

  return { context: parts.join("\n\n"), sha, snapshot };
}

/** Async history gathering: postmortems + recent cycles from the DB,
 *  merged with the sync git/worklog context. */
async function gatherHistoryContextAsync(): Promise<{
  context: string;
  sha: string | null;
  snapshot: string;
}> {
  const { context: syncContext, sha, snapshot } = gatherHistoryContext();
  const parts: string[] = [syncContext];

  // ── 3. Active postmortems ──────────────────────────────────────────
  try {
    const postmortems = await db.postmortem.findMany({
      where: { status: "active" },
      orderBy: { lastAttemptAt: "desc" },
      take: POSTMORTEM_LIMIT,
    });
    if (postmortems.length > 0) {
      const lines = postmortems.map(
        (p) => `- ${p.filePath}: ${p.failureType} — ${p.symptom} (attempts: ${p.attempts})`,
      );
      parts.push("=== ACTIVE POSTMORTEMS (constraints on future mutations) ===\n" + lines.join("\n"));
    }
  } catch {
    /* DB unavailable — skip */
  }

  // ── 4. Recent autonomous cycles ────────────────────────────────────
  try {
    const cycles = await db.autonomousCycle.findMany({
      orderBy: { startedAt: "desc" },
      take: CYCLE_LIMIT,
    });
    if (cycles.length > 0) {
      const lines = cycles.map(
        (c) => `- cycle #${c.cycleNumber} (${c.mode}, ${c.status}): scanned ${c.filesScanned}, committed ${c.filesCommitted}`,
      );
      parts.push("=== RECENT AUTONOMOUS CYCLES ===\n" + lines.join("\n"));
    }
  } catch {
    /* DB unavailable — skip */
  }

  return { context: parts.join("\n\n"), sha, snapshot };
}

/** Parsed prophecy shape from the LLM. */
interface RawProphecy {
  claim?: unknown;
  confidence?: unknown;
  rationale?: unknown;
  falsifiabilityCriterion?: unknown;
  domain?: unknown;
  horizonCycles?: unknown;
}

/** Strict validation of the parsed shape. Returns the validated prophecy
 *  or null. We don't fix up bad input — the LLM has to produce a usable
 *  prophecy, or we reject it. This is the same honesty principle as the
 *  debate tribunal: never fabricate. */
function validateRawProphecy(raw: RawProphecy): {
  claim: string;
  confidence: number;
  rationale: string;
  falsifiabilityCriterion: string;
  domain: string | null;
  horizonCycles: number;
} | null {
  // claim: non-empty string, max 500 chars (don't store essays)
  if (typeof raw.claim !== "string" || raw.claim.trim().length < 10) return null;
  const claim = raw.claim.trim().slice(0, 500);

  // confidence: number in [0, 1]
  if (typeof raw.confidence !== "number" || raw.confidence < 0 || raw.confidence > 1) return null;
  const confidence = raw.confidence;

  // rationale: non-empty string, max 1000 chars
  if (typeof raw.rationale !== "string" || raw.rationale.trim().length < 10) return null;
  const rationale = raw.rationale.trim().slice(0, 1000);

  // falsifiabilityCriterion: non-empty, max 500 chars. THIS IS THE GATE.
  // Without a criterion, the prophecy is rejected — it would never be
  // evaluable and would inflate the pending count forever.
  if (typeof raw.falsifiabilityCriterion !== "string" || raw.falsifiabilityCriterion.trim().length < 10) {
    return null;
  }
  const falsifiabilityCriterion = raw.falsifiabilityCriterion.trim().slice(0, 500);

  // domain: optional, normalize to lowercase, validate against the
  // enumerated set. If the LLM returns something weird, default to "other"
  // rather than rejecting — domain is a UI filter, not a correctness gate.
  let domain: string | null = null;
  if (typeof raw.domain === "string") {
    const normalized = raw.domain.trim().toLowerCase();
    const allowed = ["llm", "gates", "push", "postmortem", "ui", "system", "other"];
    domain = allowed.includes(normalized) ? normalized : "other";
  }

  // horizonCycles: integer 1-20. Lower bound = 1 (no zero-horizon
  // prophecies; they'd be evaluable immediately and become tautological).
  // Upper bound = 20 (about 3 hours of loop runtime at 10min intervals;
  // beyond that, predictions get too speculative to be useful).
  if (typeof raw.horizonCycles !== "number" || !Number.isFinite(raw.horizonCycles)) return null;
  const horizonCycles = Math.max(1, Math.min(20, Math.round(raw.horizonCycles)));

  return { claim, confidence, rationale, falsifiabilityCriterion, domain, horizonCycles };
}

/** Extract a JSON object from the LLM's response, handling the common
 *  cases: pure JSON, JSON in a code fence, JSON embedded in prose.
 *  Returns the parsed object or null. We try strict JSON first (the
 *  system prompt asks for strict JSON), then fall back to fence-stripped,
 *  then to a regex for the first {...} block. */
function parseJsonFromResponse(content: string): RawProphecy | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  // 1. Direct parse (strict JSON as requested)
  try {
    return JSON.parse(trimmed) as RawProphecy;
  } catch {
    /* fall through */
  }

  // 2. Strip a ```json ... ``` fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]) as RawProphecy;
    } catch {
      /* fall through */
    }
  }

  // 3. Extract the first {...} block (LLM sometimes wraps JSON in prose)
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as RawProphecy;
    } catch {
      /* fall through */
    }
  }

  return null;
}

// Estimated cycle interval for converting horizonCycles → evaluateBy
// deadline. LOOP's default scheduled mode is 10 minutes; continuous mode
// is faster but bounded by LLM cooldowns. We use 10 min as the
// conservative estimate — a prophecy with horizonCycles=3 gets
// evaluateBy = now + 30 min, which is "after the next 3 cycles would
// have run." If the system runs faster, the prophecy is judged earlier
// (which is fine). If slower, the evaluator will still pick it up once
// the deadline passes.
const ESTIMATED_CYCLE_MS = 10 * 60 * 1000; // 10 minutes

/** Generate ONE prophecy. Returns the saved row, or null if the LLM
 *  was unavailable, returned unparseable JSON, or produced a prophecy
 *  that failed validation. Errors are surfaced honestly — the caller
 *  never sees a fabricated prophecy. */
export async function generateProphecy(): Promise<{
  ok: boolean;
  prophecy?: ProphecyRow;
  error?: string;
  reason?: "llm-unavailable" | "unparseable" | "invalid-shape" | "store-failed";
}> {
  // 1. Gather the system's recent history.
  const { context, sha, snapshot } = await gatherHistoryContextAsync();
  if (!context.trim()) {
    // Nothing to predict from — don't fabricate. (Shouldn't happen in
    // practice; even a fresh repo has git log.)
    return { ok: false, reason: "llm-unavailable", error: "No system history available to predict from" };
  }

  // 2. Call the LLM with the prophecy system prompt + the history as
  //    the user prompt. Low temperature (0.4) — we want measured
  //    prediction, not creative writing.
  const result = await llmComplete({
    systemPrompt: PROPHECY_SYSTEM,
    userPrompt: `Here is LOOP's recent history. Use it to make ONE falsifiable prophecy about LOOP's near-term future.\n\n${context}`,
    temperature: 0.4,
    maxTokens: 800,
  });

  if (!result.ok || !result.content.trim()) {
    return {
      ok: false,
      reason: "llm-unavailable",
      error: result.error ?? "LLM returned empty response",
    };
  }

  // 3. Parse the LLM's JSON response (handle fence-wrapping and prose
  //    embedding as fallbacks; the system prompt asks for strict JSON).
  const raw = parseJsonFromResponse(result.content);
  if (!raw) {
    return {
      ok: false,
      reason: "unparseable",
      error: "LLM response was not valid JSON",
    };
  }

  // 4. Validate the parsed shape. Any missing/malformed field → reject.
  const validated = validateRawProphecy(raw);
  if (!validated) {
    return {
      ok: false,
      reason: "invalid-shape",
      error: "LLM response was JSON but failed validation (missing fields, confidence out of range, no falsifiability criterion, or horizonCycles not a number)",
    };
  }

  // 5. Compute the evaluateBy deadline from horizonCycles. Stored as
  //    a real DateTime, not "in N cycles" — the evaluator doesn't need
  //    to know what the cycle count was at prophecy time; it just needs
  //    to know "is this past its judgment deadline yet?"
  const evaluateBy = new Date(Date.now() + validated.horizonCycles * ESTIMATED_CYCLE_MS);

  // 6. Persist via the store.
  const saved = await createProphecy({
    claim: validated.claim,
    confidence: validated.confidence,
    rationale: validated.rationale,
    falsifiabilityCriterion: validated.falsifiabilityCriterion,
    evaluateBy,
    contextSha: sha,
    historySnapshot: snapshot,
    domain: validated.domain,
  });

  if (!saved) {
    emitOracleEvent(
      `Oracle: prophecy store-failed (DB write error) — claim discarded: "${validated.claim.slice(0, 80)}"`,
      "error",
      "generator",
    );
    return { ok: false, reason: "store-failed", error: "DB write failed" };
  }

  // Surface the new prophecy in the console stream — the system
  // narrates its own predictions as they're made.
  emitOracleEvent(
    `Oracle prophecy (confidence ${Math.round(validated.confidence * 100)}%, domain ${validated.domain ?? "?"}, judged in ${validated.horizonCycles} cycles): ${validated.claim}`,
    "success",
    "generator",
  );

  return { ok: true, prophecy: saved };
}

/** Generate N prophecies sequentially. Used by the API route when the
 *  user wants to "make several predictions at once." Sequential (not
 *  parallel) because:
 *   - LLM calls are serialized by agent-llm.ts's queue anyway.
 *   - Sequential prophecies are uncorrelated (each is its own prompt
 *     → response), preserving the calibration metric's independence
 *     assumption. A single batched prompt would produce correlated
 *     prophecies, all sharing the LLM's single sample of "what
 *     comes next."
 *
 *  Returns the saved prophecies plus per-attempt errors, so the UI
 *  can show "made 3/5 prophecies; 2 rejected for X, Y reasons." */
export async function generateProphecies(count: number): Promise<{
  generated: ProphecyRow[];
  failures: Array<{ reason: string; error: string }>;
}> {
  const generated: ProphecyRow[] = [];
  const failures: Array<{ reason: string; error: string }> = [];
  const n = Math.max(1, Math.min(10, count)); // cap at 10 — cost guard
  for (let i = 0; i < n; i++) {
    const result = await generateProphecy();
    if (result.ok && result.prophecy) {
      generated.push(result.prophecy);
    } else {
      failures.push({
        reason: result.reason ?? "unknown",
        error: result.error ?? "unknown error",
      });
    }
  }
  return { generated, failures };
}
