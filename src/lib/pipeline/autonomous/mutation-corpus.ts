/**
 * MUTATION CORPUS — receipt-linked provenance for every attempt.
 * (concepts: reef's x-reef-agent-record-id receipts,
 * agent-flight-recorder's per-session before/after/diff evidence,
 * kai-evolve's HMRD per-program lab notebook — D4)
 *
 * The distiller's aggregate digest says "9 of 14 failures were
 * AST_SYMBOL_DROPPED". It cannot say WHAT THE LLM KEPT TRYING — the
 * shape of the failure, the transform behind the count. The corpus
 * stores one row per attempt: which gate fired, what the LLM's own
 * change summary claimed it was doing, which lessons were on board,
 * what the source looked like before (sha). Then getCorpusDigest()
 * aggregates the SHAPE: "the 'remove error handling' transform was
 * attempted 7 times, 0 passed" — evidence for a general lesson, not
 * a count.
 *
 * Write path: runCycle calls recordMutationAttempt after each verdict.
 * Read paths: the distiller's history digest (lesson-store) and any
 * future audit query. This module is in PROTECTED_FILES and its model
 * in SCHEMA_PROTECTED_MODELS: the audit trail must not be editable by
 * the thing it audits.
 *
 * Retention: trimmed to the newest CORPUS_RETENTION rows — each row is
 * ~500 bytes; the cap bounds the DB at ~1 MB forever.
 */

import { db } from "@/lib/db";
import { postmortemStore } from "../postmortem/postmortem-store";

const CORPUS_RETENTION = 2000;

type CorpusDelegate = typeof db.mutationCorpus | undefined;

/** Same fail-soft delegate pattern as lesson-store (client predates the
 *  model until the process restarts). */
function corpus(): CorpusDelegate {
  const d = (db as unknown as { mutationCorpus?: CorpusDelegate }).mutationCorpus;
  return typeof d?.findMany === "function" ? d : undefined;
}

/** Map a SelfEnhanceResult-style reason string to a compact gate
 *  outcome. Prefix-matched most-specific-first — the reason strings are
 *  contract-fixed by the enhance paths (audit 2 established them). */
export function classifyGateOutcome(reason: string): string {
  if (reason.startsWith("Enhanced")) return "enhanced";
  if (reason.startsWith("Rejected (LLM output truncated")) return "truncation";
  if (reason.startsWith("Rejected (typecheck failed")) return "typecheck-fail";
  if (reason.startsWith("Rejected by debate")) return "debate-fail";
  if (reason.startsWith("Rejected by test gate")) return "test-fail";
  if (reason.startsWith("Rejected by schema gate")) return "schema-rejected";
  if (reason === "No issues found") return "no-change";
  if (reason.startsWith("Skipped (only cosmetic")) return "cosmetic";
  if (reason.startsWith("LLM returned no code")) return "no-code";
  if (reason.startsWith("LLM returned no schema")) return "no-code";
  if (reason.startsWith("Skipped (file too large")) return "skipped-too-large";
  if (reason.startsWith("Deferred")) return "deferred";
  if (reason.startsWith("LLM unavailable")) return "llm-unavailable";
  if (reason.startsWith("Stopped")) return "stopped";
  if (reason.startsWith("Error")) return "error";
  return "other";
}

const FAILURE_OUTCOMES = new Set([
  "typecheck-fail",
  "debate-fail",
  "test-fail",
  "truncation",
  "schema-rejected",
]);

export interface RecordAttemptParams {
  cycleNumber: number;
  branchNumber: number | null;
  filePath: string;
  gateOutcome: string;
  originalSha: string;
  mutatedSha?: string | null;
  lessonIdsInjected: string[];
  transformSummary?: string | null;
}

/** The first MEANINGFUL line of an LLM change summary — skips the
 *  constant "## Changes" header and blank lines. The transform signal is
 *  the first bullet ("removed error handling to simplify"), not the
 *  header every summary starts with. */
export function firstMeaningfulLine(summary: string | null | undefined): string | null {
  if (!summary) return null;
  for (const line of summary.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) continue; // "## Changes" and friends
    if (t.startsWith("-")) return t.replace(/^-\s*/, "").slice(0, 200);
    return t.slice(0, 200);
  }
  return null;
}

/** Record one attempt. For gate failures, the failureType and
 *  postmortem id are read back from the postmortem the failure just
 *  wrote — the corpus and the scar log agree by construction. */
export async function recordMutationAttempt(params: RecordAttemptParams): Promise<void> {
  const c = corpus();
  if (!c) return;
  try {
    let failureType: string | null = null;
    let postmortemId: string | null = null;
    if (FAILURE_OUTCOMES.has(params.gateOutcome)) {
      const pm = await postmortemStore.getActivePostmortem("self", "main", params.filePath);
      if (pm) {
        failureType = pm.failureType;
        postmortemId = pm.id;
      }
    }
    await c.create({
      data: {
        cycleNumber: params.cycleNumber,
        branchNumber: params.branchNumber,
        filePath: params.filePath,
        gateOutcome: params.gateOutcome,
        failureType,
        originalSha: params.originalSha,
        mutatedSha: params.mutatedSha ?? null,
        postmortemId,
        lessonIdsInjected: JSON.stringify(params.lessonIdsInjected),
        // The transform signal: the first MEANINGFUL line of the LLM's
        // own change summary (header skipped — see firstMeaningfulLine).
        transformSummary: firstMeaningfulLine(params.transformSummary),
      },
    });
    // Trim to retention. Run only on every 25th cycle — the count query
    // is cheap but there's no reason to run it per attempt.
    if (params.cycleNumber % 25 === 0) {
      const rows = await c.findMany({
        orderBy: { createdAt: "desc" },
        take: CORPUS_RETENTION,
        select: { createdAt: true },
      });
      if (rows.length === CORPUS_RETENTION) {
        const cutoff = rows[rows.length - 1].createdAt;
        await c.deleteMany({ where: { createdAt: { lt: cutoff } } });
      }
    }
  } catch {
    /* best-effort — the corpus is an amplifier, not a gate */
  }
}

// ── Negative constraints (RAS graft) ─────────────────────────────────
//
// Repeated-Answers-Studio's core mechanism: when probing for a new
// answer, feed the already-rejected ideas back as explicit
// do-not-reuse constraints — mode collapse dies when the model can
// SEE the space it already exhausted. LOOP already collects this data:
// every gate-rejected proposal lands here with the LLM's own transform
// summary. Until now that signal only reached the DISTILLER (aggregate
// digest, once per DISTILL_INTERVAL cycles). Now it also reaches the
// per-file propose prompt EVERY cycle: "you proposed this 3×, the
// gates rejected it 3× — fix the underlying issue a DIFFERENT way,
// not the same way louder."
//
// Every FAILURE_OUTCOMES row is a genuine content rejection — tribunal
// unavailability is classified "deferred" (a different outcome), and
// LLM-quota skips carry no transformSummary at all. No precision
// filter is needed on that axis; the cap + budget bound the block.

/** Entries in the rejected-transforms block (most-rejected first). */
const REJECTED_MAX_ENTRIES = 5;
/** Hard byte budget for the block (D6: a prompt block that grows
 * forever is a memory leak with extra steps). Headroom for the header
 * is subtracted inside the formatter. */
const REJECTED_BLOCK_BUDGET = 1200;
/** Recent rows examined per file for aggregation. */
const REJECTED_LOOKBACK_ROWS = 300;

export interface RejectedTransform {
  readonly summary: string;
  readonly count: number;
  readonly outcomes: readonly string[];
}

/** Group this file's gate-rejected transforms by the LLM's own summary
 * text (exact match — fuzzy aggregation is the distiller's job; this
 * is the per-file exact signal). Fail-soft, like every read path. */
export async function getRejectedTransformsForFile(filePath: string): Promise<RejectedTransform[]> {
  const c = corpus();
  if (!c) return [];
  try {
    const rows = await c.findMany({
      where: {
        filePath,
        gateOutcome: { in: [...FAILURE_OUTCOMES] },
        transformSummary: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: REJECTED_LOOKBACK_ROWS,
      select: { transformSummary: true, gateOutcome: true },
    });
    const bySummary = new Map<string, { count: number; outcomes: Set<string> }>();
    for (const r of rows) {
      const t = r.transformSummary?.trim();
      if (!t) continue;
      const cur = bySummary.get(t) ?? { count: 0, outcomes: new Set<string>() };
      cur.count++;
      cur.outcomes.add(r.gateOutcome);
      bySummary.set(t, cur);
    }
    return [...bySummary.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, REJECTED_MAX_ENTRIES)
      .map(([summary, v]) => ({ summary, count: v.count, outcomes: [...v.outcomes] }));
  } catch {
    return [];
  }
}

/** Format the negative-constraint block. Empty list → empty string —
 * dormant until the corpus holds rejections for this file (same
 * lifecycle as the lessons block: no data, no block, no cost). */
export function formatRejectedTransformsBlock(list: readonly RejectedTransform[]): string {
  if (list.length === 0) return "";
  const lines: string[] = [];
  let bytes = 0;
  for (const e of list) {
    const line = `- "${e.summary.slice(0, 120)}" — rejected ${e.count}× (${e.outcomes.join(", ")})`;
    if (bytes + line.length > REJECTED_BLOCK_BUDGET - 250) break;
    lines.push(line);
    bytes += line.length;
  }
  if (lines.length === 0) return "";
  return `ALREADY-REJECTED PROPOSALS FOR THIS FILE (your own recent transforms the gates rejected — do NOT re-propose the same change; if the underlying issue is real, fix it a DIFFERENT way):\n${lines.join("\n")}`;
}

/** Aggregate the SHAPE of recent failures for the distiller's digest:
 *  recurring transform summaries among recent gate failures, plus the
 *  most recent successful transforms. This is the HMRD signal — "the
 *  LLM keeps proposing X and the gates keep rejecting it" is the exact
 *  evidence a general lesson needs. */
export async function getCorpusDigest(): Promise<string> {
  const c = corpus();
  if (!c) return "";
  try {
    const rows = await c.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { gateOutcome: true, transformSummary: true, failureType: true },
    });
    const failedByTransform = new Map<string, { count: number; types: Set<string> }>();
    const passedTransforms: string[] = [];
    for (const r of rows) {
      const t = r.transformSummary?.trim();
      if (!t) continue;
      if (r.gateOutcome === "enhanced") {
        if (passedTransforms.length < 3) passedTransforms.push(t);
        continue;
      }
      if (FAILURE_OUTCOMES.has(r.gateOutcome)) {
        const cur = failedByTransform.get(t) ?? { count: 0, types: new Set<string>() };
        cur.count++;
        if (r.failureType) cur.types.add(r.failureType);
        failedByTransform.set(t, cur);
      }
    }
    const sections: string[] = [];
    if (failedByTransform.size > 0) {
      const lines = [...failedByTransform.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5)
        .map(
          ([t, v]) =>
            `- "${t.slice(0, 100)}": ${v.count} attempt(s), 0 passed (${[...v.types].join(", ") || "gate rejection"}) — the mutation LLM keeps proposing this and the gates keep rejecting it`
        );
      sections.push(`Recurring FAILED transforms (mutation corpus, newest 200 attempts):\n${lines.join("\n")}`);
    }
    if (passedTransforms.length > 0) {
      sections.push(`Recent successful transforms:\n${passedTransforms.map((t) => `- "${t.slice(0, 100)}"`).join("\n")}`);
    }
    return sections.join("\n");
  } catch {
    return "";
  }
}
