/**
 * META-PARAMS — the L4 rung: the loop's own knobs become rows.
 * (concepts: Raven Evolver, leezythu/Awesome-Harness-Self-Improvement L4,
 * genesis-agent PromptEvolution — see the D8 proposal)
 *
 * DISTILL_INTERVAL, MAX_INJECTED, PRUNE_SCORE, MIN_OBSERVATIONS and
 * SATURATION_THRESHOLD were constants the system never questioned. The
 * loop improved the body but never its own improvement loop. This module
 * makes them rows in MetaParam, read through a cached accessor:
 *
 *   seed (boot, idempotent) → read (cached, fail-soft to seed) →
 *   tune (meta-tuner.ts: propose → 20-cycle A/B trial → accept/rollback)
 *
 * READ contract (getMetaInt/getMetaFloat): every call resolves through
 * an in-memory cache. On a cache miss it reads the DB; if the table is
 * missing (client predates the model — same fail-soft as lesson-store)
 * or the row doesn't exist, it resolves to the SEED value passed by the
 * caller. Callers pass their documented seed so the module works before
 * the first boot ever seeds the table — the constants become defaults,
 * not authorities.
 *
 * WRITE contract (setMetaValue): write-through — DB update + cache
 * refresh. Only meta-tuner.ts (PROTECTED_FILES — the loop can never
 * rewrite its own tuner) writes here.
 *
 * This file is in PROTECTED_FILES and its model in
 * SCHEMA_PROTECTED_MODELS: a self-improving system must not be able to
 * edit the table that tunes its own loop.
 */

import { db } from "@/lib/db";

/** A tunable parameter: seed value, safe clamp range, and step size for
 *  the tuner's proposals. The clamps are the hard floor on damage: a
 *  trial can never propose a value outside [min, max] no matter what the
 *  pass-rate window says. PRUNE_SCORE's min of 0.20 is the procedure
 *  floor from D2 — the one place a bad tuning could lobotomize the
 *  lesson system is clamped shut by construction. */
export interface Tunable {
  key: string;
  valueType: "int" | "float";
  seed: number;
  min: number;
  max: number;
  step: number;
  /** Human phrase for logs: what the knob does. */
  purpose: string;
}

/** The tunable set. Order matters: round-robin starts at the top. */
export const TUNABLES: Tunable[] = [
  { key: "DISTILL_INTERVAL", valueType: "int", seed: 10, min: 5, max: 25, step: 2, purpose: "cycles between lesson distillation passes" },
  { key: "MAX_INJECTED", valueType: "int", seed: 5, min: 3, max: 8, step: 1, purpose: "max lessons injected into one enhance prompt" },
  { key: "PRUNE_SCORE", valueType: "float", seed: 0.35, min: 0.2, max: 0.6, step: 0.05, purpose: "trust score below which a lesson is pruned" },
  { key: "MIN_OBSERVATIONS", valueType: "int", seed: 4, min: 3, max: 10, step: 1, purpose: "verdicts required before pruning is allowed" },
  { key: "SATURATION_THRESHOLD", valueType: "int", seed: 3, min: 2, max: 6, step: 1, purpose: "consecutive no-growth cycles before file lockout" },
];

export function getTunable(key: string): Tunable | undefined {
  return TUNABLES.find((t) => t.key === key);
}

// ── Fail-soft delegate (same pattern as lesson-store: the running
// process's client predates the model until restart) ─────────────────
type MetaParamDelegate = typeof db.metaParam | undefined;
function metaParams(): MetaParamDelegate {
  const d = (db as unknown as { metaParam?: MetaParamDelegate }).metaParam;
  return typeof d?.findUnique === "function" ? d : undefined;
}

// ── In-memory cache ──────────────────────────────────────────────────
/** key → resolved numeric value. Written by reads (DB or seed) and by
 *  setMetaValue (write-through). Survives until process restart. */
const cache = new Map<string, number>();

function clampToTunable(t: Tunable, v: number): number {
  if (v < t.min) return t.min;
  if (v > t.max) return t.max;
  return v;
}

/** Read an int param. Resolves: cache → DB row → SEED (the caller's
 *  documented default). Never throws — a param read failure must never
 *  fail a cycle. */
export async function getMetaInt(key: string, seed: number): Promise<number> {
  const v = await readMeta(key, seed, "int");
  return Math.round(v);
}

/** Read a float param. Same resolution order as getMetaInt. */
export async function getMetaFloat(key: string, seed: number): Promise<number> {
  return readMeta(key, seed, "float");
}

async function readMeta(key: string, seed: number, valueType: "int" | "float"): Promise<number> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const m = metaParams();
  if (m) {
    try {
      const row = await m.findUnique({ where: { key } });
      if (row) {
        const parsed = valueType === "int" ? parseInt(row.value, 10) : parseFloat(row.value);
        if (Number.isFinite(parsed)) {
          cache.set(key, parsed);
          return parsed;
        }
      }
    } catch {
      /* fall through to seed */
    }
  }
  cache.set(key, seed);
  return seed;
}

/** Write-through update. Refreshes the cache so the NEXT read in this
 *  process sees the new value immediately (the running process's Prisma
 *  client predates nothing here — the table exists or the write fails
 *  softly and the cache keeps the old value). */
export async function setMetaValue(
  key: string,
  value: number,
  provenance: "seed" | "trial" | "meta-tuned",
  extra?: { baselineValue?: number; proposedBy?: string; acceptedAt?: Date; trialPassRate?: number; baselinePassRate?: number }
): Promise<boolean> {
  const t = getTunable(key);
  const v = t ? clampToTunable(t, value) : value;
  const m = metaParams();
  if (!m) {
    cache.set(key, v);
    return false; // table missing — cache-only (best-effort)
  }
  try {
    await m.update({
      where: { key },
      data: {
        value: String(v),
        provenance,
        ...(extra?.baselineValue !== undefined ? { baselineValue: String(extra.baselineValue) } : {}),
        ...(extra?.proposedBy ? { proposedBy: extra.proposedBy } : {}),
        ...(extra?.acceptedAt ? { acceptedAt: extra.acceptedAt } : {}),
        ...(extra?.trialPassRate !== undefined ? { trialPassRate: extra.trialPassRate } : {}),
        ...(extra?.baselinePassRate !== undefined ? { baselinePassRate: extra.baselinePassRate } : {}),
      },
    });
    cache.set(key, v);
    return true;
  } catch {
    cache.set(key, v);
    return false;
  }
}

export interface MetaParamSnapshot {
  key: string;
  value: number;
  provenance: string;
  baselineValue: number | null;
  purpose: string;
}

/** Read the full table (for the status surface / audit). Joins the
 *  tunable definitions so the reader sees what each knob does. */
export async function listMetaParams(): Promise<MetaParamSnapshot[]> {
  const m = metaParams();
  const out: MetaParamSnapshot[] = [];
  if (!m) return out;
  try {
    const rows = await m.findMany();
    for (const r of rows) {
      const t = getTunable(r.key);
      if (!t) continue;
      out.push({
        key: r.key,
        value: r.valueType === "int" ? parseInt(r.value, 10) : parseFloat(r.value),
        provenance: r.provenance,
        baselineValue: r.baselineValue !== null && r.baselineValue !== undefined ? parseFloat(r.baselineValue) : null,
        purpose: t.purpose,
      });
    }
  } catch {
    /* best-effort */
  }
  return out;
}

/** Boot-time seeding (idempotent). For every TUNABLE without a row:
 *  create it with provenance="seed". For every row LEFT IN "trial"
 *  provenance (a restart orphaned an in-flight A/B trial — the trial
 *  window can never complete across a restart): revert the value to
 *  baselineValue and restore provenance to its last accepted state
 *  ("meta-tuned" if it was ever accepted, else "seed").
 *
 *  Called once at boot from runContinuous, next to seedLessons(). */
export async function seedMetaParams(): Promise<void> {
  const m = metaParams();
  if (!m) return;
  try {
    for (const t of TUNABLES) {
      const row = await m.findUnique({ where: { key: t.key } });
      if (!row) {
        await m.create({
          data: {
            key: t.key,
            value: String(t.seed),
            valueType: t.valueType,
            provenance: "seed",
            baselineValue: String(t.seed),
          },
        });
        cache.set(t.key, t.seed);
        continue;
      }
      if (row.provenance === "trial") {
        // Orphaned trial from a restart mid-window. The trial never got
        // to prove itself; the honest move is rollback to baseline.
        const baseline = row.baselineValue !== null && row.baselineValue !== undefined
          ? (t.valueType === "int" ? parseInt(row.baselineValue, 10) : parseFloat(row.baselineValue))
          : t.seed;
        const fallback: number = Number.isFinite(baseline) ? baseline : t.seed;
        await m.update({
          where: { key: t.key },
          data: {
            value: String(fallback),
            provenance: row.acceptedAt ? "meta-tuned" : "seed",
          },
        });
        cache.set(t.key, fallback);
        console.log(
          `[META-PARAMS] orphaned trial on ${t.key} reverted to ${fallback} (restart cut the A/B window short)`
        );
      } else {
        const v = t.valueType === "int" ? parseInt(row.value, 10) : parseFloat(row.value);
        if (Number.isFinite(v)) cache.set(t.key, v);
      }
    }
  } catch {
    /* table missing or write failed — seeds resolve per-read */
  }
}
