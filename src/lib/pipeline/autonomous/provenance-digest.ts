/**
 * provenance-digest.ts — the loop reads its own history before mutating.
 *
 * WHAT THIS IS
 * ───────────
 * The "do better" direction the operator asked for: the system looks at
 * its own changes and learns from them, not just from scars (postmortems)
 * but from the full per-file history (frequency, recency, operator intent,
 * knowledge trail). The /api/provenance route gives the OPERATOR this
 * view; this module gives the LOOP the same view as a prompt-ready block.
 *
 * The digest is injected into the enhance prompt between the postmortem
 * constraints (the active failure) and the rejected transforms (the
 * exhausted space). It answers four questions the loop can't currently
 * ask:
 *   1. "Have I been here before?" (frequency — churny files need care)
 *   2. "Did my last attempt land?" (recency — a good file shouldn't break)
 *   3. "What did the operator last do here?" (intent — taste, not just bugs)
 *   4. "What knowledge did I apply last time?" (the lessons-injected trail)
 *
 * DESIGN RULES
 * ────────────
 * - COMPACT: ~1500b cap (matches the arch-context budget). The file
 *   content is the bulk of the prompt; the digest is a sidebar.
 * - NO DUPLICATION: the active postmortem is already in its own block
 *   (block #9); the rejected transforms are in block #10. The digest
 *   references them ("see POSTMORTEM CONSTRAINTS above") instead of
 *   repeating them. Its signal is the BROADER context they don't cover.
 * - FAIL-SOFT: returns "" on any error (git unavailable, DB down, file
 *   untracked). The prompt proceeds without the digest — the cycle
 *   never crashes on provenance. Same contract as every amplifier block.
 * - HONEST: facts only. No narrative the LLM invents. "15 attempts, 12
 *   enhanced, 3 rejected" — not "this file has been challenging."
 * - MODE-AGNOSTIC: injected in both refactor and visual-polish prompts
 *   (the loop's prior attempts on a UI file are still relevant for a
 *   styling pass).
 *
 * PERFORMANCE
 * ───────────
 * Called once per file per cycle, BEFORE the LLM call. Cost: 1 git spawn
 * (~50ms) + 1 DB query (~5ms) = ~55ms per file. With ~5-10 files/cycle,
 * ~300-600ms added per cycle — dominated by the 1.7-14s LLM call. The
 * git spawn is capped at 5 commits (recent history is most relevant);
 * the DB query is capped at 10 attempts.
 */

import { PROJECT_ROOT } from "../core/paths";
import { gitLogForFile, classifyCommitActor } from "../core/git-log";
import { getRecentAttemptsForFile } from "./mutation-corpus";

/** Hard byte cap for the digest block (matches arch-context's
 *  MAX_SUMMARY_CHARS). A file with 100+ attempts still gets a compact
 *  digest — the counts + the last attempt + the operator's last commit. */
const PROVENANCE_BLOCK_BUDGET = 1500;

/** How many recent git commits to read (newest-first). The operator's
 *  last commit is the "intent" signal; the loop's own commits are
 *  classified but only counted (the mutation corpus has the richer
 *  per-attempt detail). 5 is enough to find the operator's most recent
 *  gesture even on a heavily-mutated file. */
const GIT_LOG_TAKE = 5;

/** How many recent mutation attempts to read (all outcomes). 10 gives
 *  the loop its last ~10 cycles of work on this file — enough to see a
 *  pattern (3 rejections in a row = stop trying the same thing) without
 *  flooding the digest with ancient history. */
const ATTEMPTS_TAKE = 10;

/** Build the provenance digest block for the enhance prompt. Returns
 *  "" on any error or when there's no provenance data (a fresh file the
 *  loop has never touched + no git history → no block, no cost). The
 *  caller injects the result between the postmortem and rejected blocks.
 *
 *  `filePath` is the project-relative POSIX path (e.g.
 *  "src/lib/retro-boot-audio.ts") — the same key the mutation corpus
 *  uses for `filePath` and the same form `git log --follow` expects. */
export async function buildProvenanceDigestForPrompt(filePath: string): Promise<string> {
  try {
    // Gather both sources in parallel — neither blocks the other.
    const [gitLog, attempts] = await Promise.all([
      gitLogForFile(PROJECT_ROOT, filePath, GIT_LOG_TAKE),
      getRecentAttemptsForFile(filePath, ATTEMPTS_TAKE),
    ]);

    // No data at all → no block (a fresh file the loop + git have never
    // touched). Same lifecycle as the lessons/rejected blocks: no data,
    // no block, no prompt cost.
    if (gitLog.length === 0 && attempts.length === 0) return "";

    const lines: string[] = [];
    lines.push("--- PROVENANCE (your history with this file) ---");
    lines.push(`File: ${filePath}`);

    // ── 1. ATTEMPT FREQUENCY + LAST OUTCOME ──────────────────────
    // "I've been here 15 times" tells the loop this is a churny file —
    // be careful. "Last attempt: enhanced" tells it the file is in a
    // good state; don't break it. This is the signal the postmortem
    // (failure-only) and rejected (failure-only) blocks don't give.
    if (attempts.length > 0) {
      const enhanced = attempts.filter((a) => a.gateOutcome === "enhanced").length;
      const rejected = attempts.filter(
        (a) => a.gateOutcome !== "enhanced" && a.gateOutcome !== "deferred" && a.gateOutcome !== "no-change" && a.gateOutcome !== "cosmetic",
      ).length;
      const last = attempts[0]; // newest-first
      const lastTransform = last.transformSummary?.slice(0, 100) ?? "(no summary)";
      lines.push(
        `Your attempts: ${attempts.length} (${enhanced} enhanced · ${rejected} rejected). Last: cycle ${last.cycleNumber} ${last.gateOutcome} "${lastTransform}".`,
      );

      // ── 2. RECENT REJECTION PATTERN ──────────────────────────
      // If the last 10 attempts include rejections, surface the pattern
      // (count by outcome). Don't list the specific transforms — that's
      // the rejected block's job (block #10). This is the "you keep
      // failing the same gate" signal.
      if (rejected > 0) {
        const rejectionTypes = new Map<string, number>();
        for (const a of attempts) {
          if (a.gateOutcome !== "enhanced" && a.gateOutcome !== "deferred" && a.gateOutcome !== "no-change" && a.gateOutcome !== "cosmetic") {
            rejectionTypes.set(a.gateOutcome, (rejectionTypes.get(a.gateOutcome) ?? 0) + 1);
          }
        }
        const pattern = [...rejectionTypes.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([outcome, count]) => `${outcome} (${count}×)`)
          .join(", ");
        lines.push(
          `Recent rejection pattern: ${pattern} — see POSTMORTEM CONSTRAINTS above for the active constraint, and ALREADY-REJECTED PROPOSALS for the specific transforms.`,
        );
      }

      // ── 3. KNOWLEDGE TRAIL ──────────────────────────────────
      // "What lessons did I inject last time?" — the loop's借鉴ing
      // trail. This connects the provenance surface to the lesson
      // injection: the loop can see "I applied L-42 and L-7 here last
      // time" and judge whether to lean on the same knowledge or try
      // something different.
      const lastWithLessons = attempts.find((a) => {
        try {
          const ids = JSON.parse(a.lessonIdsInjected) as string[];
          return Array.isArray(ids) && ids.length > 0;
        } catch {
          return false;
        }
      });
      if (lastWithLessons) {
        try {
          const ids = JSON.parse(lastWithLessons.lessonIdsInjected) as string[];
          if (Array.isArray(ids) && ids.length > 0) {
            lines.push(
              `Knowledge applied: ${ids.length} lesson(s) injected on cycle ${lastWithLessons.cycleNumber} (${ids.map((id) => id.slice(-6)).join(", ")}).`,
            );
          }
        } catch {
          /* malformed lessonIdsInjected — skip the trail line */
        }
      }
    } else {
      // The loop has never touched this file via the mutation corpus
      // (or the corpus is empty). This is itself a signal: "fresh file."
      lines.push("Your attempts: 0 (this is a fresh file — no prior loop history).");
    }

    // ── 4. OPERATOR'S LAST CHANGE ──────────────────────────────
    // The operator's most recent commit on this file — their "intent"
    // signal. "fix(audit-3): dead-code purge" tells the loop the
    // operator doesn't want prank code here; the loop shouldn't re-add
    // it. This is the single most actionable provenance signal for
    // taste alignment, and it's the one the loop has been completely
    // blind to.
    const operatorCommits = gitLog.filter((c) => classifyCommitActor(c.message) === "operator");
    if (operatorCommits.length > 0) {
      const lastOp = operatorCommits[0]; // git log is newest-first
      const date = lastOp.at.split(" ")[0]; // "2026-11-03"
      const msg = lastOp.message.split("\n")[0].slice(0, 100);
      lines.push(`Operator's last change: "${msg}" (${date}).`);
    }

    // ── 5. LOOP COMMIT COUNT (git history) ─────────────────────
    // The git log gives the TRUE commit count (the mutation corpus
    // only has post-DB-reset rows). "15 self-enhancement commits" tells
    // the loop the file's real churn weight. Capped at GIT_LOG_TAKE,
    // so this is a lower bound (>= N), not exact — honest about it.
    const loopCommits = gitLog.filter((c) => classifyCommitActor(c.message) === "loop");
    if (loopCommits.length > 0) {
      lines.push(
        `Git history: ${loopCommits.length}+ self-enhancement commit(s) by you${operatorCommits.length > 0 ? ` + ${operatorCommits.length} by the operator` : ""} (in the last ${GIT_LOG_TAKE} commits).`,
      );
    }

    lines.push("--- END PROVENANCE ---");

    // Enforce the byte cap. If the digest is over budget (a file with
    // many rejection types + a long operator message), truncate the
    // least-essential lines from the bottom (the git history line is
    // last; the attempt frequency is first and most essential).
    let result = lines.join("\n");
    if (result.length > PROVENANCE_BLOCK_BUDGET) {
      // Hard cap: keep the header + first lines, drop the tail.
      result = result.slice(0, PROVENANCE_BLOCK_BUDGET - 20) + "\n--- END PROVENANCE ---";
    }
    return result;
  } catch {
    // Fail-soft: any error → empty string. The prompt proceeds without
    // the digest. The cycle never crashes on provenance.
    return "";
  }
}
