import { db } from "@/lib/db";
async function main() {
  // Simulate exactly what claimNextTask does
  const next = await db.selfTask.findFirst({
    where: { status: "pending" },
    orderBy: [{ priority: "asc" }, { deferred: "asc" }, { createdAt: "asc" }],
  });
  console.log("findFirst winner:", next ? `[${next.kind}] ${next.filePath}:${next.line} deferred=${next.deferred} priority=${next.priority}` : "NONE");
}
main().catch(e=>{console.error(e.message);process.exit(1);});
