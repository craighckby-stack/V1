// Check live prophecy settlement since the same-attempt fix + SelfTask backlog
import Database from "better-sqlite3";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });

// 1. Overall prophecy stats
const overall = db
  .prepare(`SELECT status, COUNT(*) as n FROM Prophecy GROUP BY status`)
  .all();
console.log("=== Prophecy overall ===", overall);

// 2. Self-prediction prophecies created in last 2 hours: status breakdown
const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
const recent = db
  .prepare(
    `SELECT status, COUNT(*) as n FROM Prophecy WHERE domain='self-prediction' AND createdAt >= ? GROUP BY status`,
  )
  .all(twoHoursAgo);
console.log("=== Self-prophecies last 2h ===", recent);

// 3. Recent self-prophecies detail (last 10)
const detail = db
  .prepare(
    `SELECT id, status, confidence, createdAt, evaluatedAt, evaluateBy, claim, evaluation FROM Prophecy WHERE domain='self-prediction' ORDER BY createdAt DESC LIMIT 10`,
  )
  .all() as Array<{
  id: string;
  status: string;
  confidence: number;
  createdAt: number;
  evaluatedAt: number | null;
  evaluateBy: number;
  claim: string;
  evaluation: string | null;
}>;
for (const d of detail) {
  console.log(
    `\n[${d.status}] conf=${d.confidence.toFixed(2)} created=${new Date(d.createdAt).toISOString()} evaluated=${d.evaluatedAt ? new Date(d.evaluatedAt).toISOString() : "never"}`,
  );
  console.log(`  claim: ${d.claim.slice(0, 120)}`);
  if (d.evaluation) console.log(`  eval: ${d.evaluation.slice(0, 200)}`);
}

// 4. SelfTask backlog by kind+status
const tasks = db
  .prepare(`SELECT kind, status, COUNT(*) as n FROM SelfTask GROUP BY kind, status ORDER BY kind, status`)
  .all();
console.log("\n=== SelfTask by kind/status ===");
for (const t of tasks) console.log(t);

// 5. Pending oracle-failed-prophecy tasks: oldest and count
const pending = db
  .prepare(
    `SELECT COUNT(*) as n, MIN(createdAt) as oldest FROM SelfTask WHERE kind='oracle-failed-prophecy' AND status='pending'`,
  )
  .get() as { n: number; oldest: number | null };
console.log("\n=== Pending oracle-failed-prophecy ===", {
  count: pending.n,
  oldest: pending.oldest ? new Date(pending.oldest).toISOString() : null,
});

// 6. Self-prophecies created in last 24h
const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
const sinceFix = db
  .prepare(
    `SELECT status, COUNT(*) as n, AVG(confidence) as avgConf FROM Prophecy WHERE domain='self-prediction' AND createdAt >= ? GROUP BY status`,
  )
  .all(dayAgo);
console.log("\n=== Self-prophecies last 24h ===", sinceFix);

// 7. Recent OracleEvents mentioning self-prophecy (last 15)
const events = db
  .prepare(
    `SELECT type, message, timestamp FROM OracleEvent WHERE message LIKE '%self-prophecy%' ORDER BY timestamp DESC LIMIT 15`,
  )
  .all() as Array<{ type: string; message: string; timestamp: number }>;
console.log("\n=== Recent self-prophecy events ===");
for (const e of events) {
  console.log(`${new Date(e.timestamp).toISOString()} [${e.type}] ${e.message.slice(0, 150)}`);
}

db.close();
