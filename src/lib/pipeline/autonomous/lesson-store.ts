/**
 * LESSON STORE — the compounding-intelligence engine.
 *
 * Postmortems are per-file and reactive (a scar log). Lessons are the
 * transfer layer: GENERAL rules distilled from AGGREGATE history that
 * inject into EVERY enhance prompt, with measured feedback on whether
 * they actually help.
 *
 * The loop: distill → inject → measure → prune.
 *   1. DISTILL — every DISTILL_INTERVAL cycles, one LLM call looks at
 *      aggregate postmortem patterns + recent successful change
 *      summaries and extracts up to MAX_LESSONS_PER_RUN general rules.
 *      Deduped against existing lessons (active AND pruned — a rule
 *      that already failed to transfer shouldn't be re-derived).
 *   2. INJECT — top MAX_INJECTED lessons by trust score are formatted
 *      into a prompt block that enhanceFile appends to the system
 *      prompt. Global, not per-file: that's the whole point.
 *   3. MEASURE — when the mutation's verdict lands, recordLessonOutcome
 *      bumps helped/hindered for exactly the lessons that were injected.
 *   4. PRUNE — score = helped/(helped+hindered). Below PRUNE_SCORE with
 *      at least MIN_OBSERVATIONS verdicts → deactivated. The lesson
 *      didn't transfer; stop paying its prompt-token cost.
 *
 * Why this compounds and postmortems don't: a surviving lesson raises
 * the pass rate of EVERY future mutation (not just one file), the score
 * PROVES it raised the pass rate, and pruned lessons are visible to the
 * distiller so the same dead end isn't re-derived. The 500th cycle is
 * better at improving than the 50th, measurably.
 */

import { db } from "@/lib/db";
import { llmComplete, llmCooldownMs } from "../llm/agent-llm";

/** Cycles between distillation passes. Each pass is ONE LLM call. */
export const DISTILL_INTERVAL = 10;
/** Max lessons the distiller may add per run. */
export const MAX_LESSONS_PER_RUN = 3;
/** Max lessons injected into any single enhance prompt. */
export const MAX_INJECTED = 5;
/** A lesson is pruned when score falls below this … */
export const PRUNE_SCORE = 0.35;
/** … with at least this many injected-then-observed verdicts. */
export const MIN_OBSERVATIONS = 4;

export interface LessonRow {
  id: string;
  content: string;
  score: number;
  injected: number;
  helped: number;
  hindered: number;
}

type LessonDelegate = typeof db.lesson | undefined;

/** The Prisma client in the RUNNING process predates the Lesson model
 *  until the server restarts. Fail soft: every caller treats "no table"
 *  as "no lessons" — the compounding loop just stays dormant until the
 *  next restart brings the model online. */
function lessons(): LessonDelegate {
  const d = (db as unknown as { lesson?: LessonDelegate }).lesson;
  return typeof d?.findMany === "function" ? d : undefined;
}

/** Top active lessons by score, for prompt injection. */
export async function getLessonsForPrompt(): Promise<LessonRow[]> {
  const l = lessons();
  if (!l) return [];
  try {
    const rows = await l.findMany({
      where: { active: true },
      orderBy: [{ score: "desc" }, { sourceCount: "desc" }],
      take: MAX_INJECTED,
    });
    return rows.map((r: { id: string; content: string; score: number; injected: number; helped: number; hindered: number }) => ({
      id: r.id,
      content: r.content,
      score: r.score,
      injected: r.injected,
      helped: r.helped,
      hindered: r.hindered,
    }));
  } catch {
    return [];
  }
}

/** Format lessons as a system-prompt block. Mirrors the postmortem
 *  block's imperative tone — these are rules, not trivia. */
export function formatLessonsBlock(ls: LessonRow[]): string {
  if (ls.length === 0) return "";
  const lines = ls.map((x, i) => `${i + 1}. ${x.content}`);
  return (
    `\n--- LEARNED LESSONS (general rules this system distilled from its own ${ls.length > 0 ? "history" : ""}) ---\n` +
    `These rules were extracted from this codebase's accumulated failure and success history.\n` +
    `Follow them unless they directly contradict the file-specific constraints above.\n` +
    lines.join("\n") +
    `\n--- END LEARNED LESSONS ---\n`
  );
}

/** The measured half: a mutation that had these lessons injected either
 *  passed or failed. Bump counters, recompute score, prune if dead.
 *  Best-effort — a feedback-write failure must never fail the cycle. */
export async function recordLessonOutcome(ids: string[], passed: boolean): Promise<void> {
  const l = lessons();
  if (!l || ids.length === 0) return;
  for (const id of ids) {
    try {
      const row = await l.findUnique({ where: { id } });
      if (!row || !row.active) continue;
      const helped = row.helped + (passed ? 1 : 0);
      const hindered = row.hindered + (passed ? 0 : 1);
      const observations = helped + hindered;
      const score = observations > 0 ? helped / observations : row.score;
      const shouldPrune = observations >= MIN_OBSERVATIONS && score < PRUNE_SCORE;
      await l.update({
        where: { id },
        data: {
          helped,
          hindered,
          score,
          active: shouldPrune ? false : row.active,
        },
      });
    } catch {
      /* next verdict will retry the counters */
    }
  }
}

/** Bump `injected` for the lessons that went into a prompt (called at
 *  injection time so the count is exact even if the LLM call later
 *  defers — a deferred call still paid the prompt-token cost). */
export async function markInjected(ids: string[]): Promise<void> {
  const l = lessons();
  if (!l || ids.length === 0) return;
  for (const id of ids) {
    try {
      await l.update({ where: { id }, data: { injected: { increment: 1 } } });
    } catch {
      /* best-effort */
    }
  }
}

/** Aggregate the failure history into a compact digest for the LLM.
 *  Raw postmortem rows are too many tokens; the aggregate pattern IS
 *  the signal ("9 of 14 failures were X"). */
async function buildHistoryDigest(): Promise<string> {
  try {
    const [byType, hotFiles, resolved, total] = await Promise.all([
      db.postmortem.groupBy({ by: ["failureType"], _count: { _all: true }, where: { status: "active" } }),
      db.postmortem.findMany({
        where: { status: "active" },
        orderBy: { attempts: "desc" },
        take: 5,
        select: { filePath: true, failureType: true, attempts: true, symptom: true },
      }),
      db.postmortem.count({ where: { status: "resolved" } }),
      db.postmortem.count(),
    ]);
    const typeLines = byType
      .map((t: { failureType: string; _count: { _all: number } }) => `${t.failureType}: ${t._count._all}`)
      .join("\n");
    const hotLines = hotFiles
      .map((h: { filePath: string; failureType: string; attempts: number; symptom: string }) =>
        `- ${h.filePath} (${h.attempts} attempts, ${h.failureType}): ${h.symptom.slice(0, 120)}`)
      .join("\n");
    return [
      `Total postmortems: ${total} (${resolved} resolved)`,
      `Failures by type (active):`,
      typeLines || "(none)",
      `Most-attempted files:`,
      hotLines || "(none)",
    ].join("\n");
  } catch {
    return "(postmortem history unavailable)";
  }
}

/** Run one distillation pass. Returns the number of lessons added.
 *  Skips silently when: the LLM gate is closed (never burn quota on
 *  meta-work while real work is rate-limited), the table is missing,
 *  or the LLM returns nothing usable. */
export async function distillLessons(): Promise<number> {
  const l = lessons();
  if (!l) return 0;
  if (llmCooldownMs() > 0) return 0; // quota belongs to mutations right now

  try {
    const [digest, existing] = await Promise.all([
      buildHistoryDigest(),
      l.findMany({ select: { content: true, active: true }, orderBy: { createdAt: "asc" } }),
    ]);
    // The distiller sees ACTIVE lessons (to skip duplicates) and PRUNED
    // ones (to skip re-deriving rules that already failed to transfer).
    const existingList = existing
      .map((e: { content: string; active: boolean }) => `- [${e.active ? "active" : "PRUNED — did not transfer"}] ${e.content}`)
      .join("\n");

    const system = `You are the metacognition module of a self-improving code system. Your job: look at the AGGREGATE failure history of this system's own mutation attempts and extract GENERAL lessons — rules that would apply to improving ANY file in this codebase, not just the ones that failed.

A good lesson is:
- GENERAL (about patterns of change, not one specific file)
- ACTIONABLE (an imperative the mutation LLM can follow)
- EVIDENCED (grounded in the failure counts you see)

A bad lesson is file-specific ("halt.ts needs X") — that's what postmortems are for.

Existing lessons (do NOT restate these; PRUNED ones already failed to transfer — do not re-derive them):
${existingList || "(none yet)"}

Output STRICT JSON only, no markdown fence, no prose:
{"lessons": [{"content": "...", "evidence": "short citation of the counts"}]}
Max ${MAX_LESSONS_PER_RUN} lessons. If the history genuinely supports no new general lesson, output {"lessons": []}.`;

    const user = `Failure history digest:\n\n${digest}\n\nExtract up to ${MAX_LESSONS_PER_RUN} general lessons as JSON.`;

    const res = await llmComplete({ systemPrompt: system, userPrompt: user, temperature: 0.3 });
    if (!res.ok) return 0;

    // Parse the JSON — tolerate a fence if the LLM added one anyway.
    let raw = res.content.trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1].trim();
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return 0;
    let parsed: { lessons?: Array<{ content?: string }> };
    try {
      parsed = JSON.parse(raw.slice(first, last + 1));
    } catch {
      return 0;
    }
    const candidates = (parsed.lessons ?? [])
      .map((x) => (typeof x.content === "string" ? x.content.trim() : ""))
      .filter((c) => c.length >= 20 && c.length <= 400)
      .slice(0, MAX_LESSONS_PER_RUN);
    if (candidates.length === 0) return 0;

    // Final dedupe: exact-prefix match against existing content (the LLM
    // was told not to restate, but LLMs restate).
    const existingContents = existing.map((e: { content: string }) => e.content.toLowerCase());
    const fresh = candidates.filter(
      (c) => !existingContents.some((e: string) => e.includes(c.toLowerCase().slice(0, 60)))
    );

    let added = 0;
    for (const content of fresh) {
      try {
        await l.create({
          data: { content, sourceType: "distilled", sourceCount: Math.max(1, await countPostmortems()) },
        });
        added++;
      } catch {
        /* skip this one */
      }
    }
    return added;
  } catch {
    return 0;
  }
}

async function countPostmortems(): Promise<number> {
  try {
    return await db.postmortem.count();
  } catch {
    return 1;
  }
}

/** The maybe-hook runCycle calls after each cycle. Counts are cheap. */
export async function maybeDistill(cyclesCompleted: number): Promise<number> {
  if (cyclesCompleted <= 0 || cyclesCompleted % DISTILL_INTERVAL !== 0) return 0;
  return distillLessons();
}

/** Seed lessons — the system starts with the meta-knowledge its own
 *  git history already proved. Called once at boot (idempotent —
 *  skips if any seed row exists). */
export async function seedLessons(): Promise<void> {
  const l = lessons();
  if (!l) return;
  try {
    const existing = await l.findFirst({ where: { sourceType: "seed" } });
    if (existing) return;
    await l.create({
      data: {
        content:
          "Never remove error-handling branches or empty catch blocks without replacing them with equal-or-better handling — the debate tribunal rejects 'simplification' of error paths, and this system's own history is dominated by such rejections.",
        sourceType: "seed",
        sourceCount: 28,
      },
    });
  } catch {
    /* table missing or write failed — dormant until restart */
  }
}
