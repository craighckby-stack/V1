/**
 * LESSON STORE — the compounding-intelligence engine.
 *
 * Postmortems are per-file and reactive (a scar log). Lessons are the
 * transfer layer: GENERAL rules distilled from AGGREGATE history that
 * inject into EVERY enhance prompt, with measured feedback on whether
 * they actually help.
 *
 * The loop: distill → inject → measure → prune.
 *   1. DISTILL — every DISTILL_INTERVAL cycles (meta-tunable, D8), one
 *      LLM call looks at the aggregate failure digest + the mutation
 *      corpus's recurring-transform section (D4) and the dreamer's
 *      named patterns (D3), and extracts up to MAX_LESSONS_PER_RUN
 *      general rules, each classified as a PROCEDURE or a JUDGMENT (D2).
 *      Deduped against existing lessons (active, pruned AND revoked —
 *      a rule that already failed to transfer shouldn't be re-derived;
 *      a rule reality contradicted must never come back, D9).
 *   2. INJECT — top MAX_INJECTED (meta-tunable) lessons by trust score
 *      formatted into a prompt block with a HARD byte budget (D6: the
 *      LORE 30 KiB principle scaled down — a prompt block that grows
 *      forever is a memory leak with extra steps). Promoted procedures
 *      (D2: an active procedure the LLM ignored 6+ times) graduate OUT
 *      of the bounded block into a permanent Operating Constraints
 *      block injected regardless of score, above the postmortem block.
 *   3. MEASURE — when the verdict lands, recordLessonOutcome bumps
 *      helped/hindered; the lapse detector (D1) additionally counts
 *      LAPSES — failures where the lesson was in the prompt, the file
 *      failed exactly the way the lesson covers, and the LLM ignored it.
 *   4. PRUNE — score = helped/(helped+hindered). Judgments: below
 *      PRUNE_SCORE (meta-tunable) with MIN_OBSERVATIONS (meta-tunable)
 *      verdicts → deactivated. Procedures (D2): a stricter floor (0.20
 *      at 6+ observations) and demotion to ADVISORY instead of death —
 *      the content stays visible to the distiller. REVOCATION (D9): a
 *      high-score judgment that takes 4 consecutive hindered after
 *      earning trust >= 0.6 is not pruned but REVOKED — reality
 *      contradicted it; the distiller is told never to re-derive
 *      anything resembling it.
 *
 * Why this compounds and postmortems don't: a surviving lesson raises
 * the pass rate of EVERY future mutation (not just one file), the score
 * PROVES it raised the pass rate, pruned lessons are visible to the
 * distiller so the same dead end isn't re-derived, and lapses make the
 * next PHRASING sharper — the system learns which of its own words the
 * model actually obeys. The 500th cycle is better at improving than the
 * 50th, measurably.
 *
 * KNOBS: DISTILL_INTERVAL / MAX_INJECTED / PRUNE_SCORE /
 * MIN_OBSERVATIONS read through meta-params (D8) — the constants below
 * are SEEDS, kept exported for backward compatibility.
 */

import { db } from "@/lib/db";
import { llmComplete, llmCooldownMs } from "../llm/agent-llm";
import { getMetaInt, getMetaFloat } from "./meta-params";
import { getCorpusDigest } from "./mutation-corpus";
import { getNamedPatterns } from "./dreamer";
import { exportLessonsMarkdown } from "./lessons-markdown";

/** Seeds (see module doc — the live values live in MetaParam, D8). */
export const DISTILL_INTERVAL = 10;
/** Max lessons the distiller may add per run. Static — low risk. */
export const MAX_LESSONS_PER_RUN = 3;
/** Seed for max lessons injected into any single enhance prompt. */
export const MAX_INJECTED = 5;
/** Seed for the judgment prune floor. */
export const PRUNE_SCORE = 0.35;
/** Seed for the observation minimum before pruning. */
export const MIN_OBSERVATIONS = 4;
/** Hard byte budget for the injected lessons block (D6). Overshoot
 *  demotes the lowest-score lessons to one-liners with a pointer to
 *  memory/lessons.md — bounded prompt cost, unbounded memory file. */
export const LESSONS_PROMPT_BUDGET = 4096;
/** Lapse count at which a HIGH-LAPSE warning prefix appears (D1). */
const HIGH_LAPSE_PREFIX_AT = 3;
/** Lapse count that promotes an active procedure (D2) and makes a
 *  lesson eligible for re-sharpening (D1). */
const PROMOTE_LAPSE_AT = 6;

export interface LessonRow {
  id: string;
  content: string;
  score: number;
  injected: number;
  helped: number;
  hindered: number;
  kind: string;
  lapseCount: number;
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

interface RawLesson {
  id: string;
  content: string;
  score: number;
  injected: number;
  helped: number;
  hindered: number;
  kind: string;
  lapseCount: number;
}

function mapRow(r: RawLesson): LessonRow {
  return {
    id: r.id,
    content: r.content,
    score: r.score,
    injected: r.injected,
    helped: r.helped,
    hindered: r.hindered,
    kind: r.kind ?? "judgment",
    lapseCount: r.lapseCount ?? 0,
  };
}

/** Promoted procedures (D2): active procedures with lapseCount >= 6.
 *  These graduate OUT of the bounded block into the unbounded Operating
 *  Constraints block — the system has decided the rule is
 *  non-negotiable because the LLM kept ignoring it in the bounded slot. */
export async function getPromotedProcedures(): Promise<LessonRow[]> {
  const l = lessons();
  if (!l) return [];
  try {
    const rows = await l.findMany({
      where: { active: true, kind: "procedure" as const, lapseCount: { gte: PROMOTE_LAPSE_AT } },
      orderBy: { lapseCount: "desc" },
      take: 4,
    });
    return (rows as RawLesson[]).map(mapRow);
  } catch {
    return [];
  }
}

/** Top active lessons by score, for the bounded prompt block. Excludes
 *  advisory (demoted procedures — they no longer inject) and promoted
 *  procedures (they inject via the Operating Constraints block). */
export async function getLessonsForPrompt(): Promise<LessonRow[]> {
  const l = lessons();
  if (!l) return [];
  try {
    const cap = await getMetaInt("MAX_INJECTED", MAX_INJECTED);
    const rows = await l.findMany({
      where: { active: true },
      orderBy: [{ score: "desc" }, { sourceCount: "desc" }],
      take: cap + 8, // headroom: promoted + advisory rows get filtered below
    });
    const filtered = (rows as RawLesson[])
      .map(mapRow)
      .filter((r) => r.kind !== "advisory")
      .filter((r) => !(r.kind === "procedure" && r.lapseCount >= PROMOTE_LAPSE_AT))
      .slice(0, cap);
    return filtered;
  } catch {
    return [];
  }
}

/** Render the numbered lines, with the HIGH-LAPSE prefix (D1) and
 *  one-liner demotion for budget (D6). */
function renderLines(ls: LessonRow[], demoted: Set<string>): string[] {
  return ls.map((x, i) => {
    if (demoted.has(x.id)) {
      return `${i + 1}. ${x.content.slice(0, 60)}… (demoted for prompt budget — full text in memory/lessons.md)`;
    }
    const lapseWarn =
      x.lapseCount >= HIGH_LAPSE_PREFIX_AT
        ? ` [⚠ HIGH-LAPSE — you ignored this rule ${x.lapseCount}× in prompts where it was present; treat it as a HARD rule, not advice]`
        : "";
    return `${i + 1}. ${x.content}${lapseWarn}`;
  });
}

/** Format the bounded lessons block (D6 budget inside). Sorts by score
 *  descending so budget demotion always hits the weakest lessons. */
export function formatLessonsBlock(ls: LessonRow[]): string {
  if (ls.length === 0) return "";
  const sorted = [...ls].sort((a, b) => b.score - a.score);
  const demoted = new Set<string>();
  const header =
    `\n--- LEARNED LESSONS (general rules this system distilled from its own history) ---\n` +
    `These rules were extracted from this codebase's accumulated failure and success history.\n` +
    `Follow them unless they directly contradict the file-specific constraints above.\n`;
  const footer = `\n--- END LEARNED LESSONS ---\n`;
  let body = renderLines(sorted, demoted).join("\n");
  while (header.length + body.length + footer.length > LESSONS_PROMPT_BUDGET && demoted.size < sorted.length) {
    // Demote the lowest-score lesson not yet demoted.
    const target = [...sorted].reverse().find((x) => !demoted.has(x.id));
    if (!target) break;
    demoted.add(target.id);
    body = renderLines(sorted, demoted).join("\n");
  }
  return header + body + footer;
}

/** The Operating Constraints block (D2) — above the postmortem block,
 *  always injected regardless of score, unbounded (capped at 4 rows by
 *  the query). This is where a procedure the LLM kept ignoring ends up:
 *  non-negotiable by position, not by score. */
export function formatOperatingConstraintsBlock(ls: LessonRow[]): string {
  if (ls.length === 0) return "";
  const lines = ls.map(
    (x) =>
      `${x.content} [this rule was ignored ${x.lapseCount}× while it was a normal lesson — it is now permanent]`
  );
  return (
    `\n--- OPERATING CONSTRAINTS (non-negotiable rules this system earned the hard way) ---\n` +
    `These were ordinary lessons once. The mutation LLM ignored them too many times even when\n` +
    `they were in the prompt, so they graduated to permanent constraints. Violating any of\n` +
    `these fails the cycle:\n` +
    lines.join("\n") +
    `\n--- END OPERATING CONSTRAINTS ---\n`
  );
}

/** The measured half: a mutation that had these lessons injected either
 *  passed or failed. Bump counters, recompute score, prune/kill/demote.
 *  Best-effort — a feedback-write failure must never fail the cycle.
 *
 *  D9: revocation (judgments only). D2: split prune floor + advisory
 *  demotion + back-promotion. */
export async function recordLessonOutcome(ids: string[], passed: boolean): Promise<void> {
  const l = lessons();
  if (!l || ids.length === 0) return;
  const pruneScoreSeed = await getMetaFloat("PRUNE_SCORE", PRUNE_SCORE);
  const minObsSeed = await getMetaInt("MIN_OBSERVATIONS", MIN_OBSERVATIONS);
  for (const id of ids) {
    try {
      const row = await l.findUnique({ where: { id } });
      if (!row || !row.active) continue;
      const helped = row.helped + (passed ? 1 : 0);
      const hindered = row.hindered + (passed ? 0 : 1);
      const observations = helped + hindered;
      const score = observations > 0 ? helped / observations : row.score;
      const consecutiveHindered = passed ? 0 : (row.consecutiveHindered ?? 0) + 1;
      const isProcedure = (row.kind ?? "judgment") === "procedure";

      // D9: REVOCATION. A lesson that had EARNED trust (prior score
      // >= 0.6) and then takes 4 consecutive hindered is not merely
      // unhelpful — reality contradicted it. Pruned lessons didn't
      // transfer; revoked lessons actively hurt. Procedures are exempt
      // (a real procedure shouldn't be revoked by 4 noisy judgments).
      const revoke =
        !passed && !isProcedure && (row.score ?? 0) >= 0.6 && consecutiveHindered >= 4;

      // D2: split prune floor. Procedures are harder to kill (0.20 at
      // 6+ observations) and demote to ADVISORY instead of deactivating
      // — the content stays visible to the distiller, never re-derived.
      const pruneAt = isProcedure ? 0.2 : pruneScoreSeed;
      const minObs = isProcedure ? 6 : minObsSeed;
      const shouldPrune = observations >= minObs && score < pruneAt;

      // D2 back-promotion: a procedure with sustained lapses AND a dead
      // score wasn't actually universal — demote it back to a judgment
      // so it can die honestly by the judgment rules.
      const demoteBack = isProcedure && (row.lapseCount ?? 0) >= 8 && score < 0.3;

      await l.update({
        where: { id },
        data: {
          helped,
          hindered,
          score,
          consecutiveHindered,
          active: revoke || shouldPrune ? false : row.active,
          kind: shouldPrune && isProcedure ? "advisory" : demoteBack ? "judgment" : (row.kind ?? "judgment"),
          revokedAt: revoke ? new Date() : (row.revokedAt ?? null),
          revocationReason: revoke
            ? "contradicted by 4 consecutive failures after score >= 0.6"
            : (row.revocationReason ?? null),
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
 *  the signal ("9 of 14 failures were X"). D4: the corpus adds the
 *  SHAPE — recurring transforms the LLM keeps attempting. D3: the
 *  dreamer's named patterns ride along when fresh. */
async function buildHistoryDigest(): Promise<string> {
  try {
    const [byType, hotFiles, resolved, total, corpusDigest] = await Promise.all([
      db.postmortem.groupBy({ by: ["failureType"], _count: { _all: true }, where: { status: "active" } }),
      db.postmortem.findMany({
        where: { status: "active" },
        orderBy: { attempts: "desc" },
        take: 5,
        select: { filePath: true, failureType: true, attempts: true, symptom: true },
      }),
      db.postmortem.count({ where: { status: "resolved" } }),
      db.postmortem.count(),
      getCorpusDigest(),
    ]);
    const typeLines = byType
      .map((t: { failureType: string; _count: { _all: number } }) => `${t.failureType}: ${t._count._all}`)
      .join("\n");
    const hotLines = hotFiles
      .map((h: { filePath: string; failureType: string; attempts: number; symptom: string }) =>
        `- ${h.filePath} (${h.attempts} attempts, ${h.failureType}): ${h.symptom.slice(0, 120)}`)
      .join("\n");
    const sections = [
      `Total postmortems: ${total} (${resolved} resolved)`,
      `Failures by type (active):`,
      typeLines || "(none)",
      `Most-attempted files:`,
      hotLines || "(none)",
    ];
    if (corpusDigest) sections.push(corpusDigest);
    const named = getNamedPatterns();
    if (named) {
      sections.push(`Recurring transforms (named by the idle-time dreamer — an interpretation of the corpus, not a fact):\n${named}`);
    }
    return sections.join("\n");
  } catch {
    return "(postmortem history unavailable)";
  }
}

/** Tag an existing lesson for the distiller's context (D2/D9 aware):
 *  the distiller must see WHAT a lesson became, not just that it
 *  exists — a revoked rule and an active rule demand very different
 *  treatment in the "don't restate these" list. */
function existingTag(e: { active: boolean; kind: string; revokedAt: Date | null }): string {
  if (!e.active) {
    if (e.revokedAt) return "REVOKED — contradicted by reality after earning trust; NEVER re-derive anything resembling it";
    if ((e.kind ?? "judgment") === "advisory") return "PRUNED procedure (demoted to advisory) — did not transfer; do not re-derive";
    return "PRUNED — did not transfer; do not re-derive";
  }
  if ((e.kind ?? "judgment") === "procedure") return "active procedure (always-true rule; hard to kill by design)";
  return "active";
}

/** D1: re-sharpen lessons the LLM keeps ignoring. One batched LLM call
 *  for ALL lessons at lapseCount >= 6 (max 5) — given each lesson's
 *  content and where it last lapsed, produce a phrasing that is harder
 *  to ignore. The lapse count is KEPT (it's history); the content is
 *  replaced. Runs inside distillLessons (same gate + cadence), before
 *  the distill call, so the distiller immediately sees the sharpened
 *  versions and won't re-derive near-duplicates of the old phrasing. */
async function sharpenHighLapseLessons(): Promise<number> {
  const l = lessons();
  if (!l) return 0;
  try {
    const rows = await l.findMany({
      where: { active: true, lapseCount: { gte: PROMOTE_LAPSE_AT } },
      orderBy: { lapseCount: "desc" },
      take: 5,
    });
    if (rows.length === 0) return 0;
    const list = rows
      .map(
        (r: { id: string; content: string; lapseCount: number; lastLapseFile: string | null }) =>
          `- id=${r.id} (ignored ${r.lapseCount}×, last on ${r.lastLapseFile ?? "unknown"}): ${r.content}`
      )
      .join("\n");
    const system = `You reword rules for a mutation LLM that keeps ignoring them. These rules were IN THE PROMPT when the model made the same mistake anyway. The wording failed to change behaviour. Reword each so it is harder to ignore: concrete, imperative, names the exact consequence (which gate rejects which change). 1-2 sentences each. Output STRICT JSON only: {"sharpened": [{"id": "...", "content": "..."}]}`;
    const res = await llmComplete({
      systemPrompt: system,
      userPrompt: `Rules that failed to change behaviour:\n\n${list}`,
      temperature: 0.3,
    });
    if (!res.ok) return 0;
    let raw = res.content.trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1].trim();
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first === -1 || last <= first) return 0;
    let parsed: { sharpened?: Array<{ id?: string; content?: string }> };
    try {
      parsed = JSON.parse(raw.slice(first, last + 1));
    } catch {
      return 0;
    }
    let n = 0;
    for (const s of parsed.sharpened ?? []) {
      if (!s.id || !s.content || s.content.length < 20 || s.content.length > 400) continue;
      try {
        await l.update({ where: { id: s.id }, data: { content: s.content.trim() } });
        n++;
      } catch {
        /* skip */
      }
    }
    if (n > 0) {
      console.log(`[LESSONS] re-sharpened ${n} high-lapse lesson(s) — the old phrasing failed to change behaviour`);
    }
    return n;
  } catch {
    return 0;
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
    // D1: sharpen first so the distiller sees the new phrasing below.
    await sharpenHighLapseLessons();

    const [digest, existing] = await Promise.all([
      buildHistoryDigest(),
      l.findMany({ select: { content: true, active: true, kind: true, revokedAt: true }, orderBy: { createdAt: "asc" } }),
    ]);
    // The distiller sees ACTIVE lessons (to skip duplicates), PRUNED
    // ones (rules that already failed to transfer) and REVOKED ones
    // (rules reality contradicted — the strongest possible "never
    // again" signal this system can emit).
    const existingList = existing
      .map((e: { content: string; active: boolean; kind: string; revokedAt: Date | null }) =>
        `- [${existingTag(e)}] ${e.content}`)
      .join("\n");

    const system = `You are the metacognition module of a self-improving code system. Your job: look at the AGGREGATE failure history of this system's own mutation attempts and extract GENERAL lessons — rules that would apply to improving ANY file in this codebase, not just the ones that failed.

A good lesson is:
- GENERAL (about patterns of change, not one specific file)
- ACTIONABLE (an imperative the mutation LLM can follow)
- EVIDENCED (grounded in the failure counts and recurring transforms you see)

A bad lesson is file-specific ("halt.ts needs X") — that's what postmortems are for.

TWO KINDS of lessons (classify each):
- "procedure" — an always-true operating rule ("never remove error handling without a replacement"). These survive noisy scores and can graduate to permanent constraints. Reserve for rules that should NEVER be broken.
- "judgment" — a scorable prediction about the mutation model's tendencies ("the LLM drops exports on small files"). These live and die by measured outcomes.

Existing lessons (do NOT restate these; PRUNED ones already failed to transfer; REVOKED ones were contradicted by reality — never re-derive anything resembling them):
${existingList || "(none yet)"}

Output STRICT JSON only, no markdown fence, no prose:
{"lessons": [{"content": "...", "kind": "procedure"|"judgment", "evidence": "short citation of the counts/transforms"}]}
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
    let parsed: { lessons?: Array<{ content?: string; kind?: string }> };
    try {
      parsed = JSON.parse(raw.slice(first, last + 1));
    } catch {
      return 0;
    }
    const candidates = (parsed.lessons ?? [])
      .map((x) => ({
        content: typeof x.content === "string" ? x.content.trim() : "",
        kind: x.kind === "procedure" ? "procedure" : "judgment",
      }))
      .filter((c) => c.content.length >= 20 && c.content.length <= 400)
      .slice(0, MAX_LESSONS_PER_RUN);
    if (candidates.length === 0) return 0;

    // Final dedupe: exact-prefix match against existing content (the LLM
    // was told not to restate, but LLMs restate).
    const existingContents = existing.map((e: { content: string }) => e.content.toLowerCase());
    const fresh = candidates.filter(
      (c) => !existingContents.some((e: string) => e.includes(c.content.toLowerCase().slice(0, 60)))
    );

    let added = 0;
    for (const c of fresh) {
      try {
        await l.create({
          data: { content: c.content, kind: c.kind, sourceType: "distilled", sourceCount: Math.max(1, await countPostmortems()) },
        });
        added++;
      } catch {
        /* skip this one */
      }
    }
    return added;
  } catch {
    return 0;
  } finally {
    // D6: mirror to memory/lessons.md after EVERY pass (added or not —
    // the file also reflects pruning/revocation state changes).
    void exportLessonsMarkdown().catch(() => {
      /* best-effort */
    });
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
  const interval = await getMetaInt("DISTILL_INTERVAL", DISTILL_INTERVAL);
  if (cyclesCompleted <= 0 || cyclesCompleted % interval !== 0) return 0;
  return distillLessons();
}

/** Seed lessons — the system starts with the meta-knowledge its own
 *  git history already proved. Called once at boot (idempotent —
 *  skips if any seed row exists). The seed is a PROCEDURE (D2): an
 *  always-true operating rule, hard to kill by design. */
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
        kind: "procedure",
        sourceType: "seed",
        sourceCount: 28,
      },
    });
    // D6: materialize the seed immediately (don't wait for the first
    // distillation — the file should exist from boot).
    void exportLessonsMarkdown().catch(() => {
      /* best-effort */
    });
  } catch {
    /* table missing or write failed — dormant until restart */
  }
}
