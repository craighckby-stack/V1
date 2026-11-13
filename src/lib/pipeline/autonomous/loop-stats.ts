/**
 * Loop stats persistence — the durable tier for the banner counters.
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * The loop's `stats` object (totalEnhanced / totalReverted / totalPushed /
 * cyclesCompleted …) lived ONLY in worker memory. Every worker boot —
 * crash-respawn, config reboot, sandbox restart — reset it to zero, while
 * the self-model panel next to it reads the DB (all-time since the last
 * DB epoch). Two surfaces, two windows, one banner comment claiming
 * "cumulative counters": the banner showed `cycles:0` next to a panel
 * showing `attempts:29`, and nobody could tell which clock was lying.
 *
 * This file makes the banner's clock durable. Same contract as the armed
 * state (see self-enhance-armed-state.ts): a JSON file under .git/info/,
 * never committed, never pushed, surviving process restarts AND the
 * sandbox's SQLite rolls. The in-memory object stays the live source;
 * the file is the restart tier.
 *
 * FIRST-BOOT SEEDING: when the file is absent (first run after this
 * module lands), the caller seeds it once from the DB's self-model
 * aggregates — the same numbers the self-model panel shows — so the
 * banner and the panel start from ONE window instead of banner-zero vs
 * panel-29. The seed happens in the loop's hydrateStats() (it needs the
 * Prisma client; this module stays a pure fs leaf).
 *
 * Pure leaf: fs + path + PROJECT_ROOT only, no pipeline imports — safe
 * to load from anywhere (constructor, API routes).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";

const STATS_FILE = PROJECT_ROOT ? join(
  PROJECT_ROOT,
  ".git/info/loop-stats.json"
) : undefined;

/** The durable shape of the loop's in-memory `stats` object. Kept in
 * 1:1 field correspondence with SelfEnhanceLoop's private stats so the
 * hydrate/persist paths are plain object copies, never mappings. */
export interface LoopStatsState {
  totalScanned: number;
  totalEnhanced: number;
  totalReverted: number;
  totalPushed: number;
  testsWritten: number;
  cyclesCompleted: number;
  tasksGenerated: number;
  /** ISO timestamp or null — same as the in-memory field. */
  lastEnhancementAt: string | null;
}

const NUMERIC_FIELDS: Array<keyof LoopStatsState> = [
  "totalScanned",
  "totalEnhanced",
  "totalReverted",
  "totalPushed",
  "testsWritten",
  "cyclesCompleted",
  "tasksGenerated",
];

/** Persist the stats snapshot. Never throws — a persistence failure must
 *  never fail the cycle that just updated the counters (the in-memory
 *  object remains the live source; the file is the restart tier). */
export function writeLoopStats(state: LoopStatsState): void {
  if (!PROJECT_ROOT || !STATS_FILE) {
    console.error("writeLoopStats: PROJECT_ROOT is undefined — cannot persist stats.");
    return;
  }
  try {
    const infoDir = join(PROJECT_ROOT, ".git/info");
    mkdirSync(infoDir, { recursive: true });
    writeFileSync(STATS_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    // Best-effort by contract: log, never throw.
    console.error(
      `writeLoopStats: failed to persist stats to ${STATS_FILE}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** Read the persisted stats. null when absent, unreadable, or malformed —
 *  the caller treats null as "first boot" and seeds from the DB. Fail
 *  closed against fabricated counters: a torn or partial file must never
 *  invent history. Validation is strict (all numeric fields present and
 *  finite non-negative integers; lastEnhancementAt is a valid ISO string
 *  or null). */
export function readLoopStats(): LoopStatsState | null {
  if (!PROJECT_ROOT || !STATS_FILE) {
    console.error("readLoopStats: PROJECT_ROOT is undefined — cannot read stats.");
    return null;
  }
  try {
    if (!existsSync(STATS_FILE)) return null;
    const raw = readFileSync(STATS_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;

    // Check for presence of all required fields first
    for (const field of NUMERIC_FIELDS) {
      if (!(field in obj)) return null;
    }
    if (!('lastEnhancementAt' in obj)) return null;

    // Every numeric field must be a finite, non-negative integer.
    for (const field of NUMERIC_FIELDS) {
      const v = obj[field];
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        v < 0 ||
        !Number.isInteger(v)
      ) {
        return null;
      }
    }
    // lastEnhancementAt: null or a parseable ISO string.
    const ts = obj.lastEnhancementAt;
    if (ts !== null && (typeof ts !== "string" || isNaN(Date.parse(ts)))) {
      return null;
    }

    return {
      totalScanned: obj.totalScanned as number,
      totalEnhanced: obj.totalEnhanced as number,
      totalReverted: obj.totalReverted as number,
      totalPushed: obj.totalPushed as number,
      testsWritten: obj.testsWritten as number,
      cyclesCompleted: obj.cyclesCompleted as number,
      tasksGenerated: obj.tasksGenerated as number,
      lastEnhancementAt: (ts as string | null) ?? null,
    };
  } catch {
    // Missing, unreadable, or torn — first-boot semantics.
    return null;
  }
}