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
  // Input validation - check required fields and confidence range
  if (!input.claim || !input.rationale || !input.falsifiabilityCriterion) {
    return null;
  }
  if (!input.claim.trim() || !input.rationale.trim() || !input.falsifiabilityCriterion.trim()) {
    return null;
  }
  if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) {
    return null;
  }
  if (!(input.evaluateBy instanceof Date) || isNaN(input.evaluateBy.getTime())) {
    return null;
  }

  if (!db) {
    console.error("Database connection (db) is not initialized in createProphecy.");
    return null;
  }

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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Database error in createProphecy: DB operation failed. Error: ${errorMessage}`);
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
  if (!db) {
    console.error("Database connection (db) is not initialized in listPendingProphecies.");
    return [];
  }
  try {
    return await db.prophecy.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to list pending prophecies in listPendingProphecies: DB query failed. Error: ${errorMessage}`);
    return [];
  }
}

/** Pending prophecies whose evaluateBy deadline has passed. The
 *  evaluator's primary input. The `asOf` parameter lets a caller
 *  backfill (e.g. evaluate as of an hour ago for testing). Defaults to
 *  now. */
export async function listDueProphecies(asOf: Date = new Date()): Promise<ProphecyRow[]> {
  if (!db) {
    console.error("Database connection (db) is not initialized in listDueProphecies.");
    return [];
  }
  try {
    return await db.prophecy.findMany({
      where: {
        status: "pending",
        evaluateBy: { lte: asOf },
      },
      orderBy: { evaluateBy: "asc" },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to list due prophecies in listDueProphecies: DB query failed. Error: ${errorMessage}`);
    return [];
  }
}

/** Recent prophecies of any status, newest first. The UI's main view —
 *  shows the system's latest predictions and their outcomes. Limited
 *  because the full history could grow large; the UI paginates further. */
export async function listRecentProphecies(limit = 50): Promise<ProphecyRow[]> {
  // Validate limit parameter
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
    return [];
  }

  if (!db) {
    console.error("Database connection (db) is not initialized in listRecentProphecies.");
    return [];
  }

  try {
    return await db.prophecy.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to list recent prophecies in listRecentProphecies: DB query failed. Error: ${errorMessage}`);
    return [];
  }
}

/** One prophecy by id, for the per-prophecy UI view and the evaluator's
 *  per-target path. */
export async function getProphecy(id: string): Promise<ProphecyRow | null> {
  // Validate id parameter
  if (typeof id !== 'string' || !id.trim()) {
    return null;
  }

  if (!db) {
    console.error("Database connection (db) is not initialized in getProphecy.");
    return null;
  }

  try {
    const prophecy = await db.prophecy.findUnique({ where: { id } });
    if (!prophecy) {
      console.warn(`Prophecy not found with ID: ${id}`);
    }
    return prophecy || null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to get prophecy with ID ${id} in getProphecy: DB operation failed. Error: ${errorMessage}`);
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
  // Validate id parameter
  if (typeof id !== 'string' || !id.trim()) {
    return null;
  }
  
  // Validate verdict parameter
  if (!["fulfilled", "failed", "retired"].includes(verdict)) {
    return null;
  }
  
  // Validate evaluation parameter
  if (typeof evaluation !== 'string' || !evaluation.trim()) {
    return null;
  }

  if (!db) {
    console.error("Database connection (db) is not initialized in judgeProphecy.");
    return null;
  }

  try {
    const updated = await db.prophecy.update({
      where: { id },
      data: {
        status: verdict,
        evaluation,
        evaluatedAt: new Date(),
      },
    });
    return updated;
  } catch (error) {
    // Prisma error often indicates record not found (P2025) or constraint violation.
    // We check for the specific 'record not found' case to provide better context than a generic DB error.
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('P2025') || errorMessage.includes('No record found')) {
        console.warn(`Attempted to judge non-existent prophecy with ID ${id}.`);
        return null;
    }
    console.error(`Failed to judge prophecy with ID ${id} in judgeProphecy: DB operation failed. Error: ${errorMessage}`);
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
  if (!db) {
    console.error("Database connection (db) is not initialized in getProphecyCounts.");
    return { pending: 0, fulfilled: 0, failed: 0, retired: 0, total: 0 };
  }
  try {
    // Use a single query with groupBy for better performance
    const result = await db.prophecy.groupBy({
      by: ['status'],
      _count: {
        status: true,
      },
    });
    
    // Initialize all counts to 0
    const counts: {
      pending: number;
      fulfilled: number;
      failed: number;
      retired: number;
      total: number;
    } = {
      pending: 0,
      fulfilled: 0,
      failed: 0,
      retired: 0,
      total: 0,
    };
    
    // Process the groupBy results safely
    if (Array.isArray(result)) {
      result.forEach(item => {
        const status = item.status;
        if (status && ["pending", "fulfilled", "failed", "retired"].includes(status as string)) {
          counts[status as keyof typeof counts] = item._count.status;
        }
      });
    }
    
    // Calculate total by summing individual counts
    counts.total = counts.pending + counts.fulfilled + counts.failed + counts.retired;
    
    return counts;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to get prophecy counts in getProphecyCounts: DB query failed. Error: ${errorMessage}`);
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
  if (!db) {
    console.error("Database connection (db) is not initialized in getJudgedPropheciesForCalibration.");
    return [];
  }
  try {
    const prophecies = await db.prophecy.findMany({
      where: { status: { in: ["fulfilled", "failed"] } },
      select: { confidence: true, status: true },
    });
    
    return prophecies;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to get judged prophecies for calibration in getJudgedPropheciesForCalibration: DB query failed. Error: ${errorMessage}`);
    return [];
  }
}