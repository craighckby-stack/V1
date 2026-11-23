/**
 * Read-only state probe (operator evidence instrument): DB health, backup
 * tier parity, Prophecy status breakdown. No writes to production state.
 * Usage: bun scripts/state-probe.ts
 */
import { Database } from "bun:sqlite";

const CURRENT = "/home/z/my-project/db/custom.db";
const TIER_A = "/home/z/my-project/.git/info/loop-db-backup/custom.db";
const TIER_B = "/home/z/my-project/.git/info/loop-db-backup/custom.prev.db";

function probe(path: string, label: string) {
  try {
    const db = new Database(path, { readonly: true });
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    console.log(`\n=== ${label} (${path}) ===`);
    for (const t of tables.map((x) => x.name)) {
      try {
        const n = (db.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
        const newest = (() => {
          try {
            const cols = db
              .query(`PRAGMA table_info("${t}")`)
              .all() as { name: string }[];
            const timeCol = cols.find(
              (c) => ["createdAt", "created_at", "at", "timestamp", "ts"].includes(c.name)
            )?.name;
            if (!timeCol) return "";
            const row = db
              .query(`SELECT "${timeCol}" AS v FROM "${t}" ORDER BY "${timeCol}" DESC LIMIT 1`)
              .get() as { v: unknown } | null;
            return row ? ` | newest ${timeCol}=${String(row.v).slice(0, 30)}` : "";
          } catch {
            return "";
          }
        })();
        console.log(`  ${t}: ${n} rows${newest}`);
      } catch (e) {
        console.log(`  ${t}: ERR ${e instanceof Error ? e.message : e}`);
      }
    }
    const integrity = db.query("PRAGMA integrity_check").get() as { ok?: string } | null;
    console.log(`  integrity: ${integrity?.ok ?? "n/a"}`);
    db.close();
  } catch (e) {
    console.log(`\n=== ${label} === FAILED: ${e instanceof Error ? e.message : e}`);
  }
}

probe(CURRENT, "LIVE db/custom.db");
probe(TIER_A, "TIER custom.db (newest)");
probe(TIER_B, "TIER custom.prev.db (previous)");

try {
  const db = new Database(CURRENT, { readonly: true });
  const rows = db.query("SELECT status, COUNT(*) AS n FROM Prophecy GROUP BY status").all() as {
    status: string;
    n: number;
  }[];
  console.log("\n=== Prophecy status (live) ===");
  for (const r of rows) console.log(`  ${r.status}: ${r.n}`);
  const newest = db
    .query("SELECT createdAt FROM Prophecy ORDER BY createdAt DESC LIMIT 1")
    .get() as { createdAt: string } | null;
  console.log(`  newest prophecy createdAt: ${newest?.createdAt ?? "none"}`);
  db.close();
} catch (e) {
  console.log(`Prophecy breakdown failed: ${e instanceof Error ? e.message : e}`);
}
