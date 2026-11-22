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

// Settlement method FOR prophecies CREATED in last 3h (post-fix cohort)
console.log("== Prophecies CREATED last 3h, by settlement method ==");
console.log(q(
  `SELECT CASE WHEN evaluation LIKE 'Auto-adjudicated%' THEN 'auto-adjudicated'
               WHEN evaluation LIKE 'Retroactive%' THEN 'retroactive-corpus'
               WHEN evaluation LIKE 'Deterministic deadline%' THEN 'deadline-timeout'
               WHEN evaluation LIKE '[verdict%' THEN 'llm-evaluator'
               ELSE 'unsettled-or-other' END AS method, status, COUNT(*) as n
   FROM Prophecy WHERE createdAt >= ? GROUP BY method, status`,
  now - 3 * 60 * 60 * 1000,
));

// The formerly-pending prophecy on loop-ws-service
console.log("\n== loop-ws-service prophecy now ==");
console.log(q("SELECT status, evaluatedAt, substr(evaluation,1,180) as eval FROM Prophecy WHERE claim LIKE '%loop-ws-service%' ORDER BY createdAt DESC LIMIT 1"));

// Pending count right now
console.log("\n== Pending now ==");
console.log(q("SELECT COUNT(*) as n FROM Prophecy WHERE status='pending'"));

// Recent commits — is the loop still pushing?
db.close();
