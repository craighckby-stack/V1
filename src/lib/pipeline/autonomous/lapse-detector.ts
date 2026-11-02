/**
 * LAPSE DETECTOR — the missing half of lesson measurement.
 * (concept: pixle-codes/relapse; cross-cutting theme 1 from the
 * compounding-intelligence analysis — lapse detection vs verdict counting)
 *
 * recordLessonOutcome (lesson-store) measures whether an injected lesson
 * was followed by a pass or a fail. It CANNOT tell the difference between:
 *   (a) "the lesson was injected, the LLM didn't need it, and the
 *        mutation failed for an unrelated reason" — an honest hindered.
 *   (b) "the lesson was injected, the LLM read it, ignored it, and the
 *        file failed exactly the way the lesson said it would" — a LAPSE.
 *
 * Case (b) is a much stronger signal: the rule's wording failed to change
 * the model's behaviour even when the rule was in the prompt. The
 * response is not to lower the score (case (a) and (b) look identical to
 * the score) but to change the PHRASING and, at sustained lapse counts,
 * promote the lesson into a less negotiable prompt position (D2) or
 * force a re-distillation from its own lapse evidence.
 *
 * MATCHING (v0 — deliberately simple, no embeddings, no per-lapse LLM):
 * a lesson "covers" a failure when the stemmed-token overlap between the
 * failure signature (failureType + symptom) and the lesson content is
 * >= 0.30 of the signature, with at least 2 matched tokens. The tiny
 * stemmer (ing|ed|es|s) catches the remove/removes/removing and
 * reject/rejected/rejects families that dominate this system's failure
 * vocabulary. False positives are bounded by the 0.30 ratio; false
 * negatives are acceptable (a missed lapse is just the status quo).
 *
 * Called by runCycle right after a FAILED gate verdict, with the ids of
 * the lessons that were injected into that attempt's prompt (the same
 * list recordLessonOutcome consumes) and the postmortem that was just
 * recorded. Best-effort — a lapse-write failure must never fail a cycle.
 */

import { db } from "@/lib/db";

type LessonDelegate = typeof db.lesson | undefined;

/** Same fail-soft delegate pattern as lesson-store/meta-params. */
function lessons(): LessonDelegate {
  const d = (db as unknown as { lesson?: LessonDelegate }).lesson;
  return typeof d?.findMany === "function" ? d : undefined;
}

// ── Tiny stemmer + tokenization ──────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "was", "were", "are", "you",
  "your", "from", "has", "had", "have", "not", "but", "its", "it", "in",
  "on", "at", "to", "of", "by", "as", "is", "be", "or", "an", "a", "did",
  "does", "done", "will", "would", "could", "should", "can", "when", "then",
  "them", "they", "than", "over", "into", "only", "very", "without", "code",
  "file", "files", "line", "lines", "previous", "next", "attempt", "attempts",
]);

/** Strip the four suffix families that dominate this codebase's failure
 *  vocabulary. Kept conservative (len > 4 after cut) so "test" doesn't
 *  become "tes" and "class" doesn't become "clas". */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/** Does this lesson cover this failure? See module doc for the v0
 *  matching rule (ratio >= 0.30, >= 2 matched tokens). */
export function lessonCoversFailure(lessonContent: string, failureType: string, symptom: string): boolean {
  const failureSig = tokens(
    `${failureType.replace(/_/g, " ")} ${symptom.slice(0, 140)}`
  );
  if (failureSig.size < 2) return false;
  const lessonTok = tokens(lessonContent);
  let matched = 0;
  for (const t of failureSig) if (lessonTok.has(t)) matched++;
  return matched >= 2 && matched / failureSig.size >= 0.3;
}

export interface LapseOutcome {
  checked: number;
  lapsed: number;
  /** The lessons that lapsed (id + new count), for the cycle log. */
  details: Array<{ id: string; lapseCount: number; lastLapseFile: string }>;
}

/**
 * Record lapses for the lessons that were injected into a FAILED
 * mutation's prompt. Only call this when:
 *   - the mutation actually produced an LLM proposal (llmUsed — a
 *     deferred call never saw the lessons in action), AND
 *   - the failure landed at a gate (a postmortem exists with a
 *     failureType + symptom).
 *
 * Side effects per lapsed lesson: lapseCount+1, lastLapseAt, lastLapseFile.
 * The downstream consumers read the counts:
 *   - formatLessonsBlock: lapseCount >= 3 → HIGH-LAPSE warning prefix
 *   - getPromotedProcedures (D2): active procedure with lapseCount >= 6 →
 *     promoted to the permanent Operating Constraints block
 *   - sharpenHighLapseLessons (lesson-store): lapseCount >= 6 → candidate
 *     for a sharper rephrase at the next distillation pass
 *   - recordLessonOutcome (D2 back-promotion): procedure lapseCount >= 8
 *     with score < 0.3 → demoted back to judgment
 */
export async function recordLessonLapse(
  ids: string[],
  filePath: string,
  failureType: string,
  symptom: string
): Promise<LapseOutcome> {
  const out: LapseOutcome = { checked: 0, lapsed: 0, details: [] };
  const l = lessons();
  if (!l || ids.length === 0) return out;
  for (const id of ids) {
    try {
      const row = await l.findUnique({ where: { id } });
      if (!row || !row.active) continue;
      out.checked++;
      if (!lessonCoversFailure(row.content, failureType, symptom)) continue;
      const lapseCount = (row.lapseCount ?? 0) + 1;
      await l.update({
        where: { id },
        data: {
          lapseCount,
          lastLapseAt: new Date(),
          lastLapseFile: filePath,
        },
      });
      out.lapsed++;
      out.details.push({ id, lapseCount, lastLapseFile: filePath });
    } catch {
      /* best-effort — next failure retries */
    }
  }
  return out;
}
