/**
 * operator-questions.ts — the loop asking the operator.
 *
 * WHAT THIS IS
 * ───────────
 * The third "alive" behavior (step 4 of "what the system should be for"):
 * turn the terminal from a one-way output into a two-way conversation. The
 * loop can pose a yes/no question that surfaces in the console stream; the
 * operator types `answer yes` / `answer no` (or `answer <id> yes|no`) to
 * respond. The answer is recorded; the loop can read it.
 *
 * This is NOT sentience. It's the loop gaining a voice — it can express
 * uncertainty, ask for direction, or flag something it noticed. The
 * operator stays in control: questions are ADVISORY, never blocking; the
 * loop can't force a response; old unanswered questions auto-expire.
 *
 * RATE LIMIT (the honesty rule)
 * ────────────────────────────
 * The loop can pose at most MIN_CYCLES_BETWEEN_QUESTIONS (default 50)
 * cycles apart. At ~10s/cycle, that's ~8 minutes minimum between
 * questions — the loop can't spam the operator. The rate limit is
 * enforced in canPoseQuestion() (checks the most recent question's
 * cycleNumber); poseQuestion() double-checks.
 *
 * EXPIRY
 * ──────
 * Questions auto-expire after EXPIRY_CYCLES (default 200) unanswered.
 * expireOldQuestions() marks them `expired`. The loop reads only
 * answered_yes/answered_no; pending questions older than the expiry
 * are treated as "the operator didn't engage" — not a yes, not a no.
 *
 * SAFETY
 * ──────
 * - Questions are best-effort: a DB failure returns null, never throws.
 * - The loop can pose a question but CANNOT answer its own question
 *   (the answer path requires operator input via the `answer` command,
 *   which lives in the protected control surface).
 * - The question text + rationale are LLM-authored content; they're
 *   rendered in the terminal as DATA (the console-stream already treats
 *   output lines as opaque text, so no injection surface).
 * - poseQuestion is rate-limited; canPoseQuestion is the public gate.
 *
 * INTEGRITY: this module is in PROTECTED_FILES so the loop can't rewrite
 * its own rate limit or the answer-recording logic.
 */

import { db } from "@/lib/db";

/** Minimum cycles between questions the loop can pose. At ~10s/cycle,
 *  50 cycles ≈ 8 minutes — the loop can't spam. */
export const MIN_CYCLES_BETWEEN_QUESTIONS = 50;

/** Cycles after which an unanswered question auto-expires. 200 cycles
 *  ≈ 33 minutes — the operator has a real window to respond. */
export const EXPIRY_CYCLES = 200;

/** Max question text length (enforced on pose). */
export const MAX_QUESTION_TEXT = 240;
/** Max rationale length (enforced on pose). */
export const MAX_RATIONALE = 400;

export interface PendingQuestion {
  id: string;
  cycleNumber: number;
  text: string;
  rationale: string | null;
  createdAt: string;
}

/** Can the loop pose a question right now? Returns {can, reason}.
 *  Checks the rate limit (most recent question's cycleNumber). */
export async function canPoseQuestion(
  currentCycle: number,
): Promise<{ can: boolean; reason: string }> {
  try {
    const latest = await db.operatorQuestion.findFirst({
      orderBy: { createdAt: "desc" },
      select: { cycleNumber: true },
    });
    if (!latest) return { can: true, reason: "no prior questions" };
    const cyclesSince = currentCycle - latest.cycleNumber;
    if (cyclesSince < MIN_CYCLES_BETWEEN_QUESTIONS) {
      return {
        can: false,
        reason: `rate-limited — last question was ${cyclesSince} cycles ago (min ${MIN_CYCLES_BETWEEN_QUESTIONS})`,
      };
    }
    return { can: true, reason: `${cyclesSince} cycles since last question` };
  } catch {
    // DB unavailable — don't pose (safer than spamming).
    return { can: false, reason: "DB unavailable" };
  }
}

/** Pose a yes/no question. Best-effort: returns null on any failure
 *  (rate-limited, DB error, validation). Never throws.
 *
 *  The caller (the loop) is responsible for:
 *   1. Calling canPoseQuestion first (this double-checks).
 *   2. Phrasing the question as yes/no.
 *   3. Logging that it posed the question (so the operator can see it
 *      in the cycle log AND in the console stream via getPendingQuestions).
 */
export async function poseQuestion(
  currentCycle: number,
  text: string,
  rationale?: string,
): Promise<PendingQuestion | null> {
  // Validate text length.
  const cleanText = text.trim().slice(0, MAX_QUESTION_TEXT);
  if (cleanText.length < 10) return null; // too short to be meaningful
  const cleanRationale = rationale?.trim().slice(0, MAX_RATIONALE) || null;

  // Double-check the rate limit (defense in depth).
  const { can, reason } = await canPoseQuestion(currentCycle);
  if (!can) {
    // Silent on rate-limit (the caller should have checked). Log reason
    // via the returned null — the caller can decide whether to log.
    void reason;
    return null;
  }

  try {
    const row = await db.operatorQuestion.create({
      data: {
        cycleNumber: currentCycle,
        text: cleanText,
        rationale: cleanRationale,
        status: "pending",
      },
    });
    return {
      id: row.id,
      cycleNumber: row.cycleNumber,
      text: row.text,
      rationale: row.rationale,
      createdAt: row.createdAt.toISOString(),
    };
  } catch {
    return null;
  }
}

/** Get all pending questions (newest-first), for the terminal UI to
 *  surface. Best-effort: returns [] on DB failure. */
export async function getPendingQuestions(): Promise<PendingQuestion[]> {
  try {
    const rows = await db.operatorQuestion.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return rows.map((r) => ({
      id: r.id,
      cycleNumber: r.cycleNumber,
      text: r.text,
      rationale: r.rationale,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

/** Record the operator's answer to a question. Called by the `answer`
 *  console command (the protected control surface). Returns the
 *  updated row, or null if the question wasn't pending / wasn't found.
 *
 *  The answer is the OPERATOR's input — the loop never calls this. */
export async function recordAnswer(
  questionId: string,
  answer: "yes" | "no",
  currentCycle: number,
  note?: string,
): Promise<{ text: string; status: string } | null> {
  try {
    // Only pending questions can be answered.
    const existing = await db.operatorQuestion.findUnique({
      where: { id: questionId },
    });
    if (!existing || existing.status !== "pending") return null;

    const status = answer === "yes" ? "answered_yes" : "answered_no";
    const updated = await db.operatorQuestion.update({
      where: { id: questionId },
      data: {
        status,
        answeredCycle: currentCycle,
        answerNote: note?.trim().slice(0, 400) || null,
        answeredAt: new Date(),
      },
    });
    return { text: updated.text, status: updated.status };
  } catch {
    return null;
  }
}

/** Auto-expire unanswered questions older than EXPIRY_CYCLES. Called
 *  from the loop's cycle hook (same cadence as the health snapshot).
 *  Returns the count expired. Best-effort. */
export async function expireOldQuestions(currentCycle: number): Promise<number> {
  try {
    const cutoff = currentCycle - EXPIRY_CYCLES;
    const result = await db.operatorQuestion.updateMany({
      where: {
        status: "pending",
        cycleNumber: { lt: cutoff },
      },
      data: { status: "expired" },
    });
    return result.count;
  } catch {
    return 0;
  }
}

/** Read the operator's most recent answer to a question (for the loop
 *  to act on). Returns the answer + note, or null if the question is
 *  still pending / expired / not found. */
export async function getAnswer(
  questionId: string,
): Promise<{ answer: "yes" | "no"; note: string | null } | null> {
  try {
    const row = await db.operatorQuestion.findUnique({
      where: { id: questionId },
    });
    if (!row) return null;
    if (row.status === "answered_yes") return { answer: "yes", note: row.answerNote };
    if (row.status === "answered_no") return { answer: "no", note: row.answerNote };
    return null; // pending or expired
  } catch {
    return null;
  }
}
