import { db } from "@/lib/db";
async function main() {
  // Fetch all necessary aggregates and task lists concurrently to reduce latency
  const [
    byKind,
    byPriority,
    deferredOnes,
    p2,
  ] = await Promise.all([
    // Fetch aggregates first to understand the landscape quickly
    db.selfTask.groupBy({ by: ["kind"], where: { status: "pending" }, _count: true, orderBy: { _count: { kind: "desc" } } }),
    // Fetch aggregates by priority next
    db.selfTask.groupBy({ by: ["priority"], where: { status: "pending" }, _count: true, orderBy: { priority: "asc" } }),
    // Fetch specific deferred tasks (top 5)
    db.selfTask.findMany({ 
      where: { status: "pending", deferred: { gt: 0 } }, 
      select: { kind: true, filePath: true, line: true, deferred: true, priority: true }, 
      take: 5 
    }),
    // Fetch Priority 2 tasks, ordered by deferred asc (top 5)
    db.selfTask.findMany({ 
      where: { status: "pending", priority: 2 }, 
      select: { kind: true, filePath: true, line: true, deferred: true }, 
      orderBy: { deferred: "asc" }, 
      take: 5 
    }),
  ]);

  console.log("=== Pending by kind ===");
  for (const g of byKind) console.log(`  ${g.kind}: ${g._count}`);

  console.log("=== Pending by priority ===");
  for (const g of byPriority) console.log(`  P${g.priority}: ${g._count}`);

  console.log("=== Pending tasks with deferred > 0 ===");
  for (const t of deferredOnes) console.log(`  P${t.priority} [${t.kind}] ${t.filePath}:${t.line} deferred=${t.deferred}`);

  console.log("=== Priority 2 pending (ordered by deferred asc) ===");
  for (const t of p2) console.log(`  [${t.kind}] ${t.filePath}:${t.line} deferred=${t.deferred}`);
}
main().catch(e => {
  // Improved error logging to include context about the pipeline failure
  if (e instanceof Error) {
    console.error(`Error executing main pipeline function: ${e.message}. Check database connection or query logic. Stack: ${e.stack}`);
  } else {
    console.error("Error executing main pipeline function: An unknown error occurred.", e);
  }
  process.exit(1);
});