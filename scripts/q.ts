import { db } from "@/lib/db";
async function main() {
  const byKind = await db.selfTask.groupBy({ by: ["kind"], where: { status: "pending" }, _count: true, orderBy: { _count: { kind: "desc" } } });
  console.log("=== Pending by kind ===");
  for (const g of byKind) console.log(`  ${g.kind}: ${g._count}`);
  const byPriority = await db.selfTask.groupBy({ by: ["priority"], where: { status: "pending" }, _count: true, orderBy: { priority: "asc" } });
  console.log("=== Pending by priority ===");
  for (const g of byPriority) console.log(`  P${g.priority}: ${g._count}`);
  const deferredOnes = await db.selfTask.findMany({ where: { status: "pending", deferred: { gt: 0 } }, select: { kind: true, filePath: true, line: true, deferred: true, priority: true }, take: 5 });
  console.log("=== Pending tasks with deferred > 0 ===");
  for (const t of deferredOnes) console.log(`  P${t.priority} [${t.kind}] ${t.filePath}:${t.line} deferred=${t.deferred}`);
  const p2 = await db.selfTask.findMany({ where: { status: "pending", priority: 2 }, select: { kind: true, filePath: true, line: true, deferred: true }, orderBy: { deferred: "asc" }, take: 5 });
  console.log("=== Priority 2 pending (ordered by deferred asc) ===");
  for (const t of p2) console.log(`  [${t.kind}] ${t.filePath}:${t.line} deferred=${t.deferred}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
