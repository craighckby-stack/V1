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
const threeHoursAgo = now - 3 * 60 * 60 * 1000;

// Timeout prophecies: extract filePath from historySnapshot, check corpus
const timeouts = q(
  `SELECT id, claim, createdAt, historySnapshot FROM Prophecy
   WHERE createdAt >= ? AND evaluation LIKE 'Deterministic deadline%'
   ORDER BY createdAt DESC LIMIT 8`,
  threeHoursAgo,
) as Array<{ id: string; createdAt: number; historySnapshot: string | null }>;

console.log("== Timeout prophecy files vs MutationCorpus ==");
for (const t of timeouts) {
  const meta = t.historySnapshot ? (JSON.parse(t.historySnapshot) as { filePath?: string; cycleNumber?: number }) : {};
  const file = meta.filePath ?? "?";
  const cycle = meta.cycleNumber ?? "?";
  const corpus = q(
    `SELECT cycleNumber, gateOutcome, createdAt FROM MutationCorpus WHERE filePath = ? AND createdAt >= ? ORDER BY createdAt ASC LIMIT 3`,
    file,
    t.createdAt,
  ) as Array<{ cycleNumber: number; gateOutcome: string; createdAt: number }>;
  const anyCorpus = q(
    `SELECT COUNT(*) as n FROM MutationCorpus WHERE filePath = ?`,
    file,
  ) as Array<{ n: number }>;
  console.log(
    `${file} (cycle ${cycle}) created=${new Date(t.createdAt).toISOString().slice(11, 19)} → corpus-after: ${corpus.map((c) => `#${c.cycleNumber}/${c.gateOutcome}@${new Date(c.createdAt).toISOString().slice(11, 19)}`).join(",") || "NONE"} (total rows ever: ${anyCorpus[0].n})`,
  );
}

// When did cycle 1265 start? First prophecy mentioning cycle 1265
const first1265 = q(
  `SELECT MIN(createdAt) as first FROM Prophecy WHERE claim LIKE '%cycle\n1265%' OR claim LIKE '%at cycle 1265%'`,
) as Array<{ first: number | null }>;
console.log("\nFirst cycle-1265 prophecy:", first1265[0].first ? new Date(first1265[0].first).toISOString() : "none");

// Last cycle-1264 (old-format) prophecy
const last1264 = q(
  `SELECT MAX(createdAt) as last FROM Prophecy WHERE claim LIKE '%next refactor mutation attempt%'`,
) as Array<{ last: number | null }>;
console.log("Last old-format prophecy:", last1264[0].last ? new Date(last1264[0].last).toISOString() : "none");

// Recent cycle records
console.log("\n== Recent AutonomousCycles ==");
console.log(q(`SELECT cycleNumber, mode, status, startedAt, finishedAt, filesScanned, filesCommitted, error FROM AutonomousCycle ORDER BY startedAt DESC LIMIT 5`));

db.close();
