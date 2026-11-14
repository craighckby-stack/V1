/**
 * Ancestral RAG — local, synchronous, zero-LLM-cost retrieval over the
 * postmortem ledger.
 *
 * Concept grafted from: craighckby-stack/Aether_Forge-
 *   (src/engine/darlekRAG.ts `queryAncestralWisdom`).
 *   See docs/CONCEPTS-GRAFTED.md GRAFT 3.
 *
 * The problem: `getConstraintsForFile(repo, branch, filePath)` retrieves
 * postmortems by EXACT path match. When the LLM enhances file X, it sees
 * only X's own failure history — never the lessons learned on SIMILAR
 * files. A syntax-drop failure on `foo.ts` teaches a constraint that
 * would prevent the same drop on `bar.ts`, but the per-file gate never
 * surfaces it.
 *
 * This module fills that gap with `queryRelevantPostmortems`: a local
 * keyword + failure-type search over ALL `verified` postmortems, ranked
 * by a deterministic score (keyword hit count, then recency). No LLM
 * call, no embeddings API — sub-millisecond, zero token cost. This is
 * the DARLEK_CAAN design: the library of postmortem books is consulted
 * locally; the LLM (Gemini) is reserved for genuine anomalies.
 *
 * Integration: the self-enhance loop calls `queryRelevantPostmortems`
 * with a keyword derived from the current failure symptom (or the file's
 * dominant error tokens) and injects the top-K results alongside the
 * per-file postmortem block. The LLM then sees BOTH "this file's
 * specific failures" AND "the species' ancestral lessons relevant to
 * this symptom".
 */

import { db } from "@/lib/db";
import type { Postmortem as PostmortemRow } from "@prisma/client";
import type { PostmortemFailureType, PostmortemRecord } from "./postmortem-store";

export interface AncestralHit {
  /** The postmortem record, mapped to the public shape. */
  record: PostmortemRecord;
  /** Score in [0, 1+]: how relevant this postmortem is to the query.
   *  Higher = more relevant. Deterministic — same query+DB = same score. */
  score: number;
  /** Which query terms matched, and in which fields. For auditability. */
  matchedTerms: string[];
  /** Which field the strongest hit was in: symptom | evidence | constraints. */
  strongestField: "symptom" | "evidence" | "constraints";
}

export interface AncestralQueryResult {
  hits: AncestralHit[];
  /** The number of verified postmortems scanned (the searchable corpus). */
  corpusSize: number;
  /** The query as executed (keywords + failureType + limit). */
  query: { keywords: string[]; failureType?: PostmortemFailureType; limit: number };
}

/** Tokenize a free-text keyword into searchable terms. Lowercases, splits
 *  on non-alphanumeric, drops empty + stop words. Keeps tokens >=3 chars
 *  so a 2-letter fragment doesn't dominate the score. */
export function tokenize(keyword: string): string[] {
  if (!keyword) return [];
  const STOP = new Set([
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at",
    "for", "is", "was", "are", "be", "by", "with", "from", "this", "that",
    "it", "as", "not", "no", "yes", "if", "then", "else", "when", "will",
    "has", "have", "had", "do", "does", "did", "can", "could", "should",
  ]);
  return keyword
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Field-weighted score: a keyword hit in `constraints` (the imperative
 *  the LLM must follow) counts more than one in `symptom`, which counts
 *  more than one in `evidence` (the verbose machine-copied facts). This
 *  biases the ranking toward postmortems whose LESSONS match the query,
 *  not just whose failure description happens to share a word. */
const FIELD_WEIGHTS = { constraints: 3, symptom: 2, evidence: 1 } as const;

/** Map a raw Prisma row to the public PostmortemRecord shape. Mirrors the
 *  private mapper in postmortem-store so the caller doesn't need to know
 *  the DB column names. */
function mapRow(r: PostmortemRow): PostmortemRecord {
  return {
    id: r.id,
    targetRepo: r.targetRepo,
    branch: r.branch,
    filePath: r.filePath,
    status: r.status as "active" | "resolved",
    verificationStatus: r.verificationStatus as "verified" | "candidate" | "rejected",
    failureType: r.failureType as PostmortemFailureType,
    symptom: r.symptom,
    evidence: r.evidence,
    constraints: r.constraints,
    attempts: r.attempts,
    parentHash: r.parentHash,
    hash: r.hash,
    lastAttemptAt: r.lastAttemptAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Query the ancestral postmortem ledger for records relevant to a
 * keyword (typically the current failure symptom or the file's dominant
 * error tokens). Returns the top-K verified postmortems ranked by a
 * deterministic field-weighted keyword score.
 *
 * Only `verified` postmortems are returned (candidates and rejected
 * records never steer the refactor — same gate as getConstraintsForFile).
 * The current file's OWN postmortem (if any) is excluded from the
 * ancestral results so the per-file block and the ancestral block don't
 * duplicate each other in the prompt.
 *
 * @param opts.keyword   Free text — typically the symptom or error tokens.
 * @param opts.failureType Optional filter: only return postmortems of
 *                         this failure type (e.g. "AST_SYMBOL_DROPPED").
 * @param opts.excludeFilePath Skip this file's own postmortem (pass the
 *                             file currently being enhanced).
 * @param opts.repo      Only search postmortems for this repo (default "self").
 * @param opts.limit     Max results (default 5).
 */
export async function queryRelevantPostmortems(opts: {
  keyword: string;
  failureType?: PostmortemFailureType;
  excludeFilePath?: string;
  repo?: string;
  limit?: number;
}): Promise<AncestralQueryResult> {
  const keywords = tokenize(opts.keyword);
  const limit = opts.limit ?? 5;
  const repo = opts.repo ?? "self";

  if (keywords.length === 0) {
    return { hits: [], corpusSize: 0, query: { keywords: [], failureType: opts.failureType, limit } };
  }

  let corpus: PostmortemRow[] = [];
  try {
    corpus = await db.postmortem.findMany({
      where: {
        targetRepo: repo,
        status: "active",
        verificationStatus: "verified",
        ...(opts.failureType ? { failureType: opts.failureType } : {}),
      },
    });
  } catch {
    return { hits: [], corpusSize: 0, query: { keywords, failureType: opts.failureType, limit } };
  }

  const hits: AncestralHit[] = [];
  for (const row of corpus) {
    // Skip the current file's own postmortem — it goes in the per-file
    // block, not the ancestral block.
    if (opts.excludeFilePath && row.filePath === opts.excludeFilePath) continue;

    const symptomLower = row.symptom.toLowerCase();
    const evidenceLower = row.evidence.toLowerCase();
    const constraintsLower = row.constraints.toLowerCase();

    let score = 0;
    const matchedTerms: string[] = [];
    let strongestField: AncestralHit["strongestField"] = "symptom";
    let strongestFieldScore = 0;

    for (const kw of keywords) {
      let termScore = 0;
      if (constraintsLower.includes(kw)) {
        termScore += FIELD_WEIGHTS.constraints;
        if (FIELD_WEIGHTS.constraints > strongestFieldScore) {
          strongestFieldScore = FIELD_WEIGHTS.constraints;
          strongestField = "constraints";
        }
      }
      if (symptomLower.includes(kw)) {
        termScore += FIELD_WEIGHTS.symptom;
        if (FIELD_WEIGHTS.symptom > strongestFieldScore) {
          strongestFieldScore = FIELD_WEIGHTS.symptom;
          strongestField = "symptom";
        }
      }
      if (evidenceLower.includes(kw)) {
        termScore += FIELD_WEIGHTS.evidence;
        if (FIELD_WEIGHTS.evidence > strongestFieldScore) {
          strongestFieldScore = FIELD_WEIGHTS.evidence;
          strongestField = "evidence";
        }
      }
      if (termScore > 0) {
        score += termScore;
        matchedTerms.push(kw);
      }
    }
    if (score === 0) continue;

    hits.push({
      record: mapRow(row),
      score,
      matchedTerms,
      strongestField,
    });
  }

  // Deterministic ranking: score desc, then attempts desc (a postmortem
  // the system has hit multiple times is more authoritative), then
  // createdAt asc (older = more ancestral). This mirrors the DARLEK_CAAN
  // "generational lineage + recency" ordering, adapted to LOOP's schema.
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.record.attempts !== a.record.attempts) return b.record.attempts - a.record.attempts;
    return a.record.createdAt.localeCompare(b.record.createdAt);
  });

  return {
    hits: hits.slice(0, limit),
    corpusSize: corpus.length,
    query: { keywords, failureType: opts.failureType, limit },
  };
}

/** Format the ancestral hits as a single LLM-prompt block, separate from
 *  the per-file postmortem block. The LLM sees this as "lessons the
 *  species learned on OTHER files that may apply here". */
export function formatAncestralPromptBlock(result: AncestralQueryResult): string {
  if (result.hits.length === 0) return "";
  const lines: string[] = [
    "",
    "",
    `--- ANCESTRAL LESSONS (from ${result.corpusSize} verified postmortem(s), ranked by relevance) ---`,
  ];
  for (let i = 0; i < result.hits.length; i++) {
    const hit = result.hits[i];
    lines.push(
      `[${i + 1}] ${hit.record.failureType} on ${hit.record.filePath} ` +
      `(attempts=${hit.record.attempts}, score=${hit.score}, matched: ${hit.matchedTerms.join(", ")})`
    );
    lines.push(`SYMPTOM: ${hit.record.symptom}`);
    // Truncate evidence — it's verbose machine facts, not the lesson.
    const evidenceShort = hit.record.evidence.length > 200
      ? hit.record.evidence.slice(0, 200) + "…"
      : hit.record.evidence;
    lines.push(`EVIDENCE: ${evidenceShort}`);
    lines.push(`CONSTRAINT (MUST follow if applicable): ${hit.record.constraints.split("\n")[0]}`);
  }
  lines.push("--- END ANCESTRAL LESSONS ---");
  return lines.join("\n");
}
