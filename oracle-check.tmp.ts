import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
const q = (sql: string, ...params: (string | number)[]) => {
  try {
    return db.query(sql).all(...params);
  } catch (e) {
    return [{ error: String(e) }];
  }
};

const now = Date.now();
const twoHoursAgo = now - 2 * 60 * 60 * 1000;

// Any recent deadline-timeout or retroactive settlements (the OLD failure mode)?
console.log("== Settlement method breakdown, last 24h ==");
console.log(q(
  "SELECT CASE WHEN evaluation LIKE 'Auto-adjudicated%' THEN 'auto-adjudicated' WHEN evaluation LIKE 'Retroactive%' THEN 'retroactive-corpus' WHEN evaluation LIKE 'Deterministic deadline%' THEN 'deadline-timeout' WHEN evaluation LIKE '[verdict%' THEN 'llm-evaluator' ELSE 'other' END AS method, status, COUNT(*) as n FROM Prophecy WHERE evaluatedAt >= ? GROUP BY method, status",
  now - 24 * 60 * 60 * 1000,
));

// The lone pending prophecy
console.log("\n== Pending prophecies ==");
console.log(q("SELECT id, domain, claim, evaluateBy, createdAt FROM Prophecy WHERE status='pending'"));

// MutationCorpus recent outcomes — what's the actual gate pass rate?
console.log("\n== MutationCorpus gateOutcome, last 2h ==");
console.log(q("SELECT gateOutcome, COUNT(*) as n FROM MutationCorpus WHERE createdAt >= ? GROUP BY gateOutcome", twoHoursAgo));

// Distinct file prefixes mutated in last 24h — is scope already beyond src/?
console.log("\n== File scope touched, last 24h (by top-level dir) ==");
console.log(q(
  "SELECT CASE WHEN filePath LIKE 'src/%' THEN 'src' WHEN filePath LIKE 'mini-services/%' THEN 'mini-services' WHEN filePath LIKE '.zscripts/%' THEN '.zscripts' WHEN filePath LIKE 'scripts/%' THEN 'scripts' ELSE 'other' END AS bucket, COUNT(DISTINCT filePath) as files, COUNT(*) as attempts FROM MutationCorpus WHERE createdAt >= ? GROUP BY bucket",
  now - 24 * 60 * 60 * 1000,
));

// OracleEvent recent — timestamp column format check
console.log("\n== OracleEvent sample ==");
const ev = q("SELECT type, message, timestamp FROM OracleEvent ORDER BY rowid DESC LIMIT 3") as Array<{ type: string; message: string; timestamp: unknown }>;
for (const e of ev) {
  console.log(`[${e.type}] ts(${typeof e.timestamp})=${String(e.timestamp).slice(0, 30)} :: ${e.message.slice(0, 120)}`);
}

db.close();
