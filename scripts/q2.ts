import { db } from "@/lib/db";
async function main() {
  const byKind = await db.selfTask.groupBy({ by: ["kind"], where: { status: "pending" }, _count: true });
  for (const g of byKind) console.log(`  ${g.kind}: ${g._count}`);
  const det = await db.selfTask.count({ where: { status: "pending", kind: "missing-return-type" } });
  console.log(`  DETERMINISTIC available: ${det}`);
  const done = await db.selfTask.findMany({ where: { status: "done" }, select: { kind: true, filePath: true, line: true, commitSha: true, fixSummary: true } });
  console.log(`=== DONE tasks (${done.length}) ===`);
  for (const d of done) console.log(`  [${d.kind}] ${d.filePath}:${d.line} sha=${d.commitSha ?? "?"} — ${(d.fixSummary ?? "").slice(0,80)}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
