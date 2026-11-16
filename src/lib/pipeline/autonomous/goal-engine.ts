/**
 * GOAL ENGINE — the loop sets its own SYSTEM DIRECTION.
 * (concepts: the goal loop closes the last operator-owned piece of loop
 * cognition — pursue → observe → judge → retire/mint)
 *
 * Before this module, higher-level goals ("reduce polling latency",
 * "improve back-pressure", "make state updates more efficient") were
 * hardcoded operator text inside the mutation prompt. The loop could
 * PURSUE goals but never SET them: no memory of what it was pursuing,
 * no judgment of whether a goal was met, no mechanism to mint a new
 * goal from observed evidence. The loop had a self-tuner (meta-tuner,
 * L4), a self-defined task queue (self-task-generator), a dreamer, an
 * oracle — but its DIRECTION was borrowed, not owned.
 *
 * This module makes goals ROWS (LoopGoal table) and closes the loop:
 *
 *   SEED     — first read seeds the three operator goals (provenance
 *              "operator-seed"). Continuity: these are the exact texts
 *              the mutation prompt carried as static text, so the hand-
 *              over changes who OWNS the goals, not what they say.
 *   RENDER   — the mutation prompt's SYSTEM DIRECTION bullets and the
 *              debate topic's goal line render from the ACTIVE rows
 *              (5-minute cache; fail-soft to the static seed bullets —
 *              the prompt must never fail because of the goal store).
 *   REVIEW   — every GOAL_REVIEW_INTERVAL cycles (and only when the
 *              LLM gate is OPEN — the quota contract: mutations own
 *              the quota first), one LLM pass over recent evidence
 *              (this cycle's outcome, recent corpus attempts, goal
 *              ages) may retire ONE goal and mint ONE goal.
 *
 * CLAMPS (the governance — why this can't become goal drift):
 *   - max 5 active goals, min 1 (never retire into an empty set)
 *   - ONE retirement and ONE mint per review — goals change slowly
 *   - operator-seeded goals retire only with disposition "met" +
 *     concrete evidence — the loop can graduate an operator goal, it
 *     can never quietly drop the operator's intent
 *   - self-set goals have a minimum lifetime (MIN_GOAL_LIFETIME_CYCLES)
 *     — a goal younger than that hasn't been tested by enough cycles
 *   - goal text is unique across ALL rows (schema-level): a retired
 *     text can never be re-minted — kills flip-flop (A → dropped →
 *     A → dropped...) at the database constraint
 *   - text 8-120 chars (ALL-CAPS imperative), rationale ≤ 300 chars,
 *     control characters stripped
 *   - the review is advisory-with-clamps: every mutation still passes
 *     the full gate chain (typecheck, structural, mutation-guard,
 *     debate, tests). A corrupt goal can at worst steer prompt
 *     emphasis — never weaken a gate.
 *
 * This file is in PROTECTED_FILES and its model in
 * SCHEMA_PROTECTED_MODELS: the loop can never rewrite its own goal
 * governance (same rule as meta-tuner.ts — "the loop can never rewrite
 * its own tuner"). The loop READS this module's output; it cannot edit
 * the rules by which it sets its own goals.
 */

import { db } from "@/lib/db";
import { llmComplete, llmCooldownMs } from "../llm/agent-llm";

// ── Clamps (governance constants — deliberately NOT meta-tunable: the
// goal loop tuning its own governance is the same infinite regress the
// meta-tuner refuses for TUNE_INTERVAL) ────────────────────────────────
export const GOAL_REVIEW_INTERVAL = 30;
export const MAX_ACTIVE_GOALS = 5;
export const MIN_ACTIVE_GOALS = 1;
export const MIN_GOAL_LIFETIME_CYCLES = 25;
export const MAX_GOAL_TEXT = 120;
export const MIN_GOAL_TEXT = 8;
export const MAX_RATIONALE = 300;

/** The operator seed — the exact texts the mutation prompt carried as
 * static SYSTEM DIRECTION text before the goal engine existed. Seeding
 * with these (rather than a blank table) is the continuity guarantee:
 * cycle N and cycle N+1 pursue the same direction; only the ownership
 * changed. Also the fail-soft fallback for every render. */
export const OPERATOR_SEED_GOALS: { text: string; rationale: string }[] = [
  {
    text: "REDUCE POLLING LATENCY",
    rationale:
      "fewer or faster round trips; batch related fetches into one request; narrow payloads to what the consumer actually reads; skip work when data has not changed; run independent awaits in parallel instead of waterfalls",
  },
  {
    text: "IMPROVE BACK-PRESSURE",
    rationale:
      "bound every unbounded queue/buffer/append; drop-oldest when a consumer falls behind; add timeouts to unbounded awaits; never let a fast producer block or starve a slow consumer",
  },
  {
    text: "MAKE STATE UPDATES MORE EFFICIENT",
    rationale:
      "avoid redundant recomputation or re-renders; memoize hot derivations; diff before writing; batch rapid successive updates into one commit; keep hot paths allocation-light",
  },
];

/** Bullet list for the static fallback + seeding. */
function seedBullets(): string {
  return OPERATOR_SEED_GOALS.map((g) => `- ${g.text}: ${g.rationale}`).join("\n");
}

// ── Seeding (idempotent, race-safe via the unique text constraint) ────

let seedPromise: Promise<void> | null = null;

export async function ensureGoalsSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      const count = await db.loopGoal.count();
      if (count > 0) return;
      for (const g of OPERATOR_SEED_GOALS) {
        try {
          await db.loopGoal.create({
            data: {
              text: g.text,
              rationale: g.rationale,
              provenance: "operator-seed",
              status: "active",
              activatedCycle: 0,
            },
          });
        } catch {
          /* unique race (another process seeded first) — fine */
        }
      }
    })().catch((err) => {
      // Reset so a transient DB outage doesn't permanently disable
      // seeding — the next call retries.
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

// ── Reads ─────────────────────────────────────────────────────────────

export interface GoalRow {
  id: string;
  text: string;
  rationale: string;
  provenance: string;
  status: string;
  activatedCycle: number;
  retiredCycle: number | null;
  retiredReason: string | null;
  createdAt: string;
  retiredAt: string | null;
}

function toRow(g: {
  id: string;
  text: string;
  rationale: string;
  provenance: string;
  status: string;
  activatedCycle: number;
  retiredCycle: number | null;
  retiredReason: string | null;
  createdAt: Date;
  retiredAt: Date | null;
}): GoalRow {
  return {
    id: g.id,
    text: g.text,
    rationale: g.rationale,
    provenance: g.provenance,
    status: g.status,
    activatedCycle: g.activatedCycle,
    retiredCycle: g.retiredCycle,
    retiredReason: g.retiredReason,
    createdAt: g.createdAt.toISOString(),
    retiredAt: g.retiredAt ? g.retiredAt.toISOString() : null,
  };
}

/** Active goals, oldest first (stable prompt ordering). */
export async function getActiveGoals(): Promise<GoalRow[]> {
  await ensureGoalsSeeded();
  const rows = await db.loopGoal.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toRow);
}

/** Full snapshot for the UI: active + the recent retirement trail. */
export async function getGoalsSnapshot(): Promise<{
  active: GoalRow[];
  retired: GoalRow[];
}> {
  await ensureGoalsSeeded();
  const [active, retired] = await Promise.all([
    db.loopGoal.findMany({ where: { status: "active" }, orderBy: { createdAt: "asc" } }),
    db.loopGoal.findMany({
      where: { status: { in: ["met", "dropped"] } },
      orderBy: { retiredAt: "desc" },
      take: 6,
    }),
  ]);
  return { active: active.map(toRow), retired: retired.map(toRow) };
}

// ── Rendering (cached, fail-soft to the static seed bullets) ──────────

const BLOCK_CACHE_TTL_MS = 5 * 60 * 1000;
let blockCache: { bullets: string; topicLine: string; at: number } | null = null;

/** Invalidate after a review mutates the active set (also used by tests). */
export function invalidateGoalCache(): void {
  blockCache = null;
}

async function buildRendered(): Promise<{ bullets: string; topicLine: string }> {
  const goals = await getActiveGoals();
  if (goals.length === 0) {
    // Never render an empty direction — the seed guarantees ≥1 active,
    // but a manual table wipe must not blank the prompt.
    return { bullets: seedBullets(), topicLine: OPERATOR_SEED_GOALS.map((g) => g.text).join("; ") };
  }
  return {
    bullets: goals.map((g) => `- ${g.text}: ${g.rationale}`).join("\n"),
    topicLine: goals.map((g) => g.text).join("; "),
  };
}

/**
 * The SYSTEM DIRECTION bullet list for the mutation prompt. Fail-soft:
 * ANY error (DB down, table missing) returns the static seed bullets —
 * the enhance prompt must never fail because of the goal store.
 */
export async function renderGoalsBullets(): Promise<string> {
  if (blockCache && Date.now() - blockCache.at < BLOCK_CACHE_TTL_MS) {
    return blockCache.bullets;
  }
  try {
    const rendered = await buildRendered();
    blockCache = { ...rendered, at: Date.now() };
    return rendered.bullets;
  } catch {
    return seedBullets();
  }
}

/**
 * Compact one-liner of active goal texts for the debate topic — lets
 * the tribunal credit goal-advancing changes ("this bounds a queue —
 * advances IMPROVE BACK-PRESSURE"). Same cache and fail-soft contract.
 */
export async function renderGoalsTopicLine(): Promise<string> {
  if (blockCache && Date.now() - blockCache.at < BLOCK_CACHE_TTL_MS) {
    return blockCache.topicLine;
  }
  try {
    const rendered = await buildRendered();
    blockCache = { ...rendered, at: Date.now() };
    return rendered.topicLine;
  } catch {
    return OPERATOR_SEED_GOALS.map((g) => g.text).join("; ");
  }
}

// ── The review (the loop judging its own direction) ────────────────────

export interface GoalReviewEvidence {
  /** cyclesCompleted of the cycle that triggered this review. */
  cycle: number;
  /** This cycle's file outcomes (from runCycle's results array). */
  enhancedThisCycle: number;
  filesThisCycle: number;
  deferredThisCycle: number;
  /** Up to 6 short outcome reasons from this cycle (defer/skip causes). */
  topReasons: string[];
  /** Cumulative totals, for scale. */
  totalEnhanced: number;
  totalReverted: number;
}

export interface GoalReviewOutcome {
  ran: boolean;
  deferred?: boolean;
  error?: string;
  commentary?: string;
  retired?: { text: string; disposition: string; reason: string };
  minted?: { text: string; rationale: string };
  skipped?: string[];
}

let lastReviewCycle = 0;
let reviewPending = false;

const REVIEW_SYSTEM = `You are the Goal Reviewer inside an autonomous self-improvement loop for a live Next.js + TypeScript codebase (a dashboard polling many APIs on timers, a background loop worker, a WebSocket state stream).

You govern the loop's SYSTEM DIRECTION: the short list of higher-level goals injected into every mutation prompt. Mutations are single-file LLM refactors gated by typecheck, structural validation, a debate tribunal, and tests — the loop can only change its own source code.

Review the evidence and the current goals, then decide AT MOST ONE retirement and AT MOST ONE mint:
- RETIRE a goal only if it is demonstrably MET (cite the evidence) or — self-set goals only — clearly unproductive (pursued long enough with no observable payoff).
- MINT a goal only if the evidence reveals a concrete recurring problem class or clear opportunity the current goals do NOT already cover: a recurring gate failure, a repeated inefficiency, an architectural debt you can name precisely.
Ground every decision in the evidence. Do NOT retire goals just because they are old; do NOT mint goals that restate an active or retired one. No change is a valid — and common — outcome.

Hard rules:
- Operator-seeded goals (provenance "operator-seed") may only be retired with disposition "met" and a concrete evidence-based reason. Never "dropped".
- A new goal must be actionable by mutating this codebase's own source code, start with an imperative verb, be 8-120 characters, ALL-CAPS.
- Its rationale (max 300 chars) states what "done" looks like.

Respond in strict JSON only:
{
  "commentary": "1-3 sentences: your read of the evidence",
  "retire": { "text": "<exact text of an active goal>", "disposition": "met" | "dropped", "reason": "..." } | null,
  "mint": { "text": "<ALL-CAPS imperative>", "rationale": "..." } | null
}`;

const REVIEW_GUIDED_JSON = {
  type: "object",
  properties: {
    commentary: { type: "string" },
    retire: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            text: { type: "string" },
            disposition: { type: "string", enum: ["met", "dropped"] },
            reason: { type: "string" },
          },
          required: ["text", "disposition", "reason"],
          additionalProperties: false,
        },
      ],
    },
    mint: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            text: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["text", "rationale"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["commentary", "retire", "mint"],
  additionalProperties: false,
} as const;

/** Sanitize LLM-provided text: strip control chars, collapse whitespace,
 *  hard cap length. Defense-in-depth under the length clamps. */
function sanitizeText(s: unknown, maxLen: number): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** Normalize a goal directive for comparison: uppercase, single spaces. */
function normalizeGoalText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toUpperCase();
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Recent mutation attempts — what the loop has actually been landing,
 *  the core evidence for "is this goal being served / met?". */
async function recentCorpusDigest(): Promise<string> {
  try {
    const rows = await db.mutationCorpus.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { gateOutcome: true, transformSummary: true, filePath: true },
    });
    if (rows.length === 0) return "(no recorded attempts yet)";
    return rows
      .map(
        (r) =>
          `- ${r.filePath} → ${r.gateOutcome}${r.transformSummary ? `: ${r.transformSummary.slice(0, 110)}` : ""}`
      )
      .join("\n");
  } catch {
    return "(corpus unavailable)";
  }
}

/** The cadence-gated review entry point — called every cycle by
 *  runCycle (fire-and-forget). Returns without LLM cost unless due. */
export async function maybeReviewGoals(
  evidence: GoalReviewEvidence,
  log?: (line: string, level?: "info" | "success" | "warn") => void
): Promise<GoalReviewOutcome> {
  const due = reviewPending || evidence.cycle - lastReviewCycle >= GOAL_REVIEW_INTERVAL;
  if (!due) return { ran: false };

  // QUOTA CONTRACT (same as the dreamer): the review self-skips while
  // the LLM gate is closed — mutations own the quota first. Mark
  // pending so the next cycle retries (a review that came due during a
  // 429 window must not silently slip a whole interval).
  if (llmCooldownMs() > 0) {
    reviewPending = true;
    return { ran: false, deferred: true };
  }

  return reviewGoalsNow(evidence, log);
}

/** Force a review now (operator/debug path — bypasses the cadence gate,
 *  still respects the quota gate and every clamp). */
export async function reviewGoalsNow(
  evidence: GoalReviewEvidence,
  log?: (line: string, level?: "info" | "success" | "warn") => void
): Promise<GoalReviewOutcome> {
  lastReviewCycle = evidence.cycle;
  reviewPending = false;

  const goals = await getActiveGoals();
  const corpus = await recentCorpusDigest();

  const goalsBlock = goals
    .map(
      (g) =>
        `- "${g.text}" [provenance: ${g.provenance}, active for ${evidence.cycle - g.activatedCycle} cycles] — ${g.rationale}`
    )
    .join("\n");

  const userPrompt = `Cycle ${evidence.cycle} of the loop. Cumulative: ${evidence.totalEnhanced} mutations landed and pushed, ${evidence.totalReverted} reverted at gates.

Current active goals:
${goalsBlock}

This cycle's outcome: ${evidence.enhancedThisCycle}/${evidence.filesThisCycle} files enhanced, ${evidence.deferredThisCycle} deferred${evidence.topReasons.length > 0 ? `\nOutcome reasons: ${evidence.topReasons.join("; ").slice(0, 400)}` : ""}

Most recent mutation attempts (newest first):
${corpus}

Review the goals against this evidence. Respond as strict JSON per your instructions.`;

  const res = await llmComplete({
    systemPrompt: REVIEW_SYSTEM,
    userPrompt,
    temperature: 0.2,
    guidedJson: REVIEW_GUIDED_JSON as unknown as Record<string, unknown>,
  });
  if (!res.ok) {
    return { ran: false, error: `goal review LLM unavailable: ${res.error ?? "unknown"}` };
  }

  const parsed = safeJsonParse(res.content);
  if (!parsed || typeof parsed !== "object") {
    return { ran: false, error: "goal review returned unparseable JSON (no change applied)" };
  }

  const commentary = sanitizeText(parsed.commentary, 400);
  const skipped: string[] = [];
  const outcome: GoalReviewOutcome = { ran: true, commentary, skipped };

  // ── Apply the retirement (at most one, clamped) ────────────────────
  const retireRaw = parsed.retire as Record<string, unknown> | null | undefined;
  if (retireRaw && typeof retireRaw === "object") {
    const text = sanitizeText(retireRaw.text, MAX_GOAL_TEXT);
    const disposition = retireRaw.disposition === "met" || retireRaw.disposition === "dropped"
      ? (retireRaw.disposition as "met" | "dropped")
      : null;
    const reason = sanitizeText(retireRaw.reason, 300);

    const target = goals.find((g) => normalizeGoalText(g.text) === normalizeGoalText(text));
    if (!target) {
      skipped.push(`retire: "${text.slice(0, 60)}" is not an active goal`);
    } else if (goals.length <= MIN_ACTIVE_GOALS) {
      skipped.push(`retire: would empty the goal set (min ${MIN_ACTIVE_GOALS})`);
    } else if (target.provenance === "operator-seed" && disposition !== "met") {
      // The operator's intent is graduated, never quietly dropped.
      skipped.push(`retire: operator-seeded "${target.text}" may only be retired as "met"`);
    } else if (target.provenance !== "operator-seed" && evidence.cycle - target.activatedCycle < MIN_GOAL_LIFETIME_CYCLES) {
      skipped.push(
        `retire: self-set "${target.text}" is only ${evidence.cycle - target.activatedCycle} cycles old (min lifetime ${MIN_GOAL_LIFETIME_CYCLES})`
      );
    } else if (!disposition) {
      skipped.push(`retire: invalid disposition for "${target.text}"`);
    } else if (!reason || reason.length < 10) {
      skipped.push(`retire: "${target.text}" lacks an evidence-based reason`);
    } else {
      await db.loopGoal.update({
        where: { id: target.id },
        data: {
          status: disposition,
          retiredCycle: evidence.cycle,
          retiredAt: new Date(),
          retiredReason: reason,
        },
      });
      outcome.retired = { text: target.text, disposition, reason };
      log?.(`🎯 goal retired (${disposition}): ${target.text} — ${reason}`, "success");
    }
  }

  // ── Apply the mint (at most one, clamped) ──────────────────────────
  const mintRaw = parsed.mint as Record<string, unknown> | null | undefined;
  const activeAfterRetire = outcome.retired ? goals.length - 1 : goals.length;
  if (mintRaw && typeof mintRaw === "object") {
    const text = normalizeGoalText(sanitizeText(mintRaw.text, MAX_GOAL_TEXT));
    const rationale = sanitizeText(mintRaw.rationale, MAX_RATIONALE);

    if (activeAfterRetire >= MAX_ACTIVE_GOALS) {
      skipped.push(`mint: "${text.slice(0, 60)}" — already at ${MAX_ACTIVE_GOALS} active goals`);
    } else if (text.length < MIN_GOAL_TEXT || text.length > MAX_GOAL_TEXT) {
      skipped.push(`mint: "${text.slice(0, 60)}" outside ${MIN_GOAL_TEXT}-${MAX_GOAL_TEXT} chars`);
    } else if (!rationale || rationale.length < 10) {
      skipped.push(`mint: "${text}" lacks a rationale`);
    } else {
      // Dedup against ALL rows (active + retired) — the schema-level
      // unique constraint is the backstop; this pre-check keeps the
      // error message human-readable in the log.
      const clash = await db.loopGoal.findFirst({ where: { text } });
      if (clash) {
        skipped.push(`mint: "${text}" duplicates ${clash.status === "active" ? "an active" : "a retired"} goal — no flip-flop`);
      } else {
        try {
          await db.loopGoal.create({
            data: {
              text,
              rationale,
              provenance: "self",
              status: "active",
              activatedCycle: evidence.cycle,
              reviewNote: commentary,
            },
          });
          outcome.minted = { text, rationale };
          log?.(`🎯 goal minted (self-set): ${text} — ${rationale}`, "success");
        } catch {
          skipped.push(`mint: "${text}" lost a create race (unique constraint) — skipped`);
        }
      }
    }
  }

  if (outcome.retired || outcome.minted) {
    invalidateGoalCache();
  }
  for (const s of skipped) {
    log?.(`🎯 review clamp: ${s}`, "info");
  }
  return outcome;
}
