/**
 * loop-db-tier.ts — the wipe-proof database tier (operator, 2026-11-23).
 *
 * ROOT CAUSE this closes: the sandbox platform DELETES untracked files on
 * every machine restart — db/custom.db among them. The next dev.sh boot
 * then runs `prisma db push`, which prints "SQLite database custom.db
 * created" and the entire learning history (Prophecy, Postmortem, Lesson,
 * MemoryEntry, MutationCorpus, SelfPrediction, cycles) is gone. This was
 * observed as the "retention defect" (2026-11-23 02:06→03:04→03:11→03:29
 * wipes) and is DOCUMENTED platform behavior — push-target.ts:49 ("the
 * sandbox this system runs in wipes both the DB file and the root state
 * file on every machine restart") has known it since the 2026-10-29 PAT
 * loss and already shipped a 3-tier recovery for the PAT; the DB never
 * got the same treatment. The .git/ directory is the only location
 * guaranteed to survive machine restarts (it holds the repo itself), so
 * .git/info/ is the wipe-proof tier — the same invariant the mutation
 * freeze, the armed state, and the push-target tier already rely on.
 *
 * Note: db/backups/*.db and db/custom.db.pre-push-snapshot are ALSO
 * untracked (*.db is gitignored) — they are wiped by the same mechanism
 * and are NOT a recovery path across machine restarts. They remain
 * useful only as a short forensic window WITHIN a single machine life.
 *
 * Usage (bun scripts/loop-db-tier.ts <command>):
 *   backup   — SQLite-safe online backup of db/custom.db into
 *              .git/info/loop-db-backup/ (custom.db + custom.prev.db,
 *              two generations against single-file corruption). Safe to
 *              run while the app is writing (uses the sqlite backup API,
 *              not a raw file copy).
 *   restore  — copy the tier backup back to db/custom.db, ONLY when the
 *              target is missing (a machine restart just wiped it). Never
 *              overwrites an existing DB. Exit code 0 = restored,
 *              1 = nothing to restore from, 2 = target already exists.
 *   status   — print both sides (existence, size, mtime, row counts).
 *
 * This file is on the protected list (evidence/recovery instrument — the
 * system being recovered must not be able to rewrite its own recovery).
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.dir is Bun-only (not in the root tsconfig's lib); the
// standard import.meta.url form typechecks everywhere Bun runs.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_DB = path.join(PROJECT_ROOT, "db", "custom.db");
const TIER_DIR = path.join(PROJECT_ROOT, ".git", "info", "loop-db-backup");
const TIER_DB = path.join(TIER_DIR, "custom.db");
const TIER_PREV = path.join(TIER_DIR, "custom.prev.db");

function fileStamp(p: string): string {
  if (!existsSync(p)) return "absent";
  const s = statSync(p);
  return `${(s.size / 1024).toFixed(0)}KB ${s.mtime.toISOString()}`;
}

function rowCounts(p: string): string {
  try {
    const db = new Database(p, { readonly: true });
    const parts: string[] = [];
    for (const t of ["Prophecy", "Postmortem", "Lesson", "MutationCorpus", "MemoryEntry"]) {
      try {
        const n = (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        parts.push(`${t}=${n}`);
      } catch {
        parts.push(`${t}=n/a`);
      }
    }
    db.close();
    return parts.join(" ");
  } catch {
    return "unreadable";
  }
}

async function cmdBackup(): Promise<number> {
  if (!existsSync(LIVE_DB)) {
    console.error(`[db-tier] live DB missing (${LIVE_DB}) — nothing to back up.`);
    return 1;
  }
  mkdirSync(TIER_DIR, { recursive: true });

  // Rotate: current → prev (two generations against single-file corruption),
  // then clear the primary slot — VACUUM INTO refuses to overwrite.
  if (existsSync(TIER_DB)) {
    try {
      copyFileSync(TIER_DB, TIER_PREV);
    } catch (err) {
      // Non-fatal: prev is redundancy, not the primary.
      console.warn(`[db-tier] prev-generation rotate failed (continuing): ${err}`);
    }
    unlinkSync(TIER_DB);
  }

  // SQLite-safe copy under concurrent writers: VACUUM INTO runs a proper
  // page-level consistent snapshot (NOT a torn raw cp of a hot file). It
  // fails if the target exists — the unlink above clears the slot after
  // the prev-generation rotate. Bun's bun:sqlite lacks .backup() in this
  // version (checked 2026-11-23); VACUUM INTO is the same guarantee.
  const live = new Database(LIVE_DB, { readonly: true });
  try {
    live.exec(`VACUUM INTO '${TIER_DB.replaceAll("'", "''")}'`);
  } catch (err) {
    console.error(`[db-tier] online backup failed: ${err}`);
    live.close();
    return 1;
  }
  live.close();

  console.log(`[db-tier] backup ok: ${TIER_DB} (${fileStamp(TIER_DB)})`);
  console.log(`[db-tier] prev generation: ${TIER_PREV} (${fileStamp(TIER_PREV)})`);
  console.log(`[db-tier] rows: ${rowCounts(TIER_DB)}`);
  return 0;
}

function cmdRestore(): number {
  if (existsSync(LIVE_DB)) {
    // Never overwrite a live DB — restore only fills the wiped-out hole.
    console.log(`[db-tier] live DB already exists (${fileStamp(LIVE_DB)}) — no restore needed.`);
    return 2;
  }
  const source = existsSync(TIER_DB)
    ? TIER_DB
    : existsSync(TIER_PREV)
      ? TIER_PREV
      : null;
  if (!source) {
    console.error(
      `[db-tier] no tier backup available (${TIER_DB}) — a fresh empty DB will be created by prisma.`
    );
    return 1;
  }
  mkdirSync(path.dirname(LIVE_DB), { recursive: true });
  copyFileSync(source, LIVE_DB);
  // Sanity: a corrupt restore is worse than none — verify it opens.
  try {
    const check = new Database(LIVE_DB, { readonly: true });
    check.close();
  } catch (err) {
    console.error(`[db-tier] restored file failed integrity open — removing it: ${err}`);
    unlinkSync(LIVE_DB);
    return 1;
  }
  console.log(`[db-tier] RESTORED ${LIVE_DB} from ${source}`);
  console.log(`[db-tier] restored state: ${fileStamp(LIVE_DB)} | ${rowCounts(LIVE_DB)}`);
  return 0;
}

function cmdStatus(): number {
  console.log(`live : ${LIVE_DB} — ${fileStamp(LIVE_DB)}`);
  if (existsSync(LIVE_DB)) console.log(`       ${rowCounts(LIVE_DB)}`);
  console.log(`tier : ${TIER_DB} — ${fileStamp(TIER_DB)}`);
  if (existsSync(TIER_DB)) console.log(`       ${rowCounts(TIER_DB)}`);
  console.log(`prev : ${TIER_PREV} — ${fileStamp(TIER_PREV)}`);
  return 0;
}

const cmd = process.argv[2];
const exitCode = await (async () => {
  switch (cmd) {
    case "backup":
      return cmdBackup();
    case "restore":
      return cmdRestore();
    case "status":
      return cmdStatus();
    default:
      console.error("usage: bun scripts/loop-db-tier.ts <backup|restore|status>");
      return 64;
  }
})();
process.exit(exitCode);
