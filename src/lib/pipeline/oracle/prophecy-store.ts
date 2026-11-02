/**
 * Prophecy Store — DB CRUD for the Prophecy model.
 *
 * The system makes falsifiable predictions about its own future, stores
 * them, and evaluates them over time. This module is the thin data-access
 * layer between the prophecy generator/evaluator and the DB. No business
 * logic — that lives in the generator and evaluator modules. Same
 * pattern as postmortem-store: typed CRUD, all server-side, errors
 * caught and surfaced as null/empty rather than thrown, so a DB hiccup
 * never crashes the loop that calls this.
 *
 * The store deliberately does NOT cascade-delete or auto-prune. Old
 * prophecies are the system's track record — even failed and retired
 * ones stay forever, because the calibration metric only means
 * something if it's computed over ALL predictions ever made, not just
 * the convenient ones. Pruning would be self-flattery.
 */

import { db } from "@/lib/db";
import type { Prophecy } from "@prisma/client";

/** A prophecy with the fields the UI needs. Same shape as the model —
 *  the model already excludes the secret-bearing fields (there are none
 *  on Prophecy; claims are public). Provided as a typed alias so callers
 *  don't import the Prisma type directly. */
export type ProphecyRow = Prophecy;

/** Create a new prophecy. Used by the generator after the LLM returns a
 *  validated claim. Returns the saved row on success, null on DB error.
 *  The generator is responsible for validating the claim's shape
 *  (non-empty fields, confidence in [0,1], evaluateBy in the future)
 *  before calling this — the store trusts what it's given. */
export async function createProphecy(input: {
  claim: string;
  confidence: number;
  rationale: string;
  falsifiabilityCriterion: string;
  evaluateBy: Date;
  contextSha?: string | null;
  historySnapshot?: string | null;
  domain?: string | null;
}): Promise<ProphecyRow | null> {
  try {
    return await db.prophecy.create({
      data: {
        claim: input.claim,
        confidence: input.confidence,
        rationale: input.rationale,
        falsifiabilityCriterion: input.falsifiabilityCriterion,
        evaluateBy: input.evaluateBy,
        contextSha: input.contextSha ?? null,
        historySnapshot: input.historySnapshot ?? null,
        domain: input.domain ?? null,
        status: "pending",
      },
    });
  } catch {
    return null;
  }
}

/** All pending prophecies, oldest first. Used by the evaluator to find
 *  prophecies whose deadline has passed (or that the user manually
 *  triggered evaluation on). Oldest-first is important: the evaluator
 *  should judge the prophecy with the longest waiting time first, so
 *  the track record reflects "what we said would happen, judged when
 *  we said it would." */
export async function listPendingProphecies(): Promise<ProphecyRow[]> {
  try {
    return await db.prophecy.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
    });
  } catch {
    return [];
  }
}

/** Pending prophecies whose evaluateBy deadline has passed. The
 *  evaluator's primary input. The `asOf` parameter lets a caller
 *  backfill (e.g. evaluate as of an hour ago for testing). Defaults to
 *  now. */
export async function listDueProphecies(asOf: Date = new Date()): Promise<ProphecyRow[]> {
  try {
    return await db.prophecy.findMany({
      where: {
        status: "pending",
        evaluateBy: { lte: asOf },
      },
      orderBy: { evaluateBy: "asc" },
    });
  } catch {
    return [];
  }
}

/** Recent prophecies of any status, newest first. The UI's main view —
 *  shows the system's latest predictions and their outcomes. Limited
 *  because the full history could grow large; the UI paginates further. */
export async function listRecentProphecies(limit = 50): Promise<ProphecyRow[]> {
  try {
    return await db.prophecy.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  } catch {
    return [];
  }
}

/** One prophecy by id, for the per-prophecy UI view and the evaluator's
 *  per-target path. */
export async function getProphecy(id: string): Promise<ProphecyRow | null> {
  try {
    return await db.prophecy.findUnique({ where: { id } });
  } catch {
    return null;
  }
}

/** Mark a prophecy as judged. Called by the evaluator with the verdict
 *  (fulfilled | failed | retired) and the reasoning. Sets evaluatedAt
 *  to now. Returns the updated row, or null on DB error. */
export async function judgeProphecy(
  id: string,
  verdict: "fulfilled" | "failed" | "retired",
  evaluation: string,
): Promise<ProphecyRow | null> {
  try {
    return await db.prophecy.update({
      where: { id },
      data: {
        status: verdict,
        evaluation,
        evaluatedAt: new Date(),
      },
    });
  } catch {
    return null;
  }
}

/** Counts for the track-record display. Each status bucket, plus the
 *  total. The calibration metric is computed by the caller (status.ts
 *  route) using these counts + the per-prophecy confidence values —
 *  this function deliberately returns only counts so the store stays
 *  a thin layer. */
export async function getProphecyCounts(): Promise<{
  pending: number;
  fulfilled: number;
  failed: number;
  retired: number;
  total: number;
}> {
  try {
    // SQLite doesn't support groupBy + count efficiently through Prisma's
    // older API on all versions; do four findMany+count calls. The
    // prophecy table will stay small (a few rows per day) so this is
    // cheaper than it looks and avoids version-specific groupBy quirks.
    const [pending, fulfilled, failed, retired, total] = await Promise.all([
      db.prophecy.count({ where: { status: "pending" } }),
      db.prophecy.count({ where: { status: "fulfilled" } }),
      db.prophecy.count({ where: { status: "failed" } }),
      db.prophecy.count({ where: { status: "retired" } }),
      db.prophecy.count({}),
    ]);
    return { pending, fulfilled, failed, retired, total };
  } catch {
    return { pending: 0, fulfilled: 0, failed: 0, retired: 0, total: 0 };
  }
}

/** All fulfilled + failed prophecies with their confidence, used to
 *  compute the calibration metric. The metric (computed by the caller)
 *  is: of prophecies with confidence >= 0.7, what fraction were
 *  fulfilled? A well-calibrated system should hit ~70%. We return the
 *  raw rows so the caller can compute any threshold-based metric
 *  without re-querying. */
export async function getJudgedPropheciesForCalibration(): Promise<
  Array<{ confidence: number; status: string }>
> {
  try {
    return await db.prophecy.findMany({
      where: { status: { in: ["fulfilled", "failed"] } },
      select: { confidence: true, status: true },
    });
  } catch {
    return [];
  }
}
