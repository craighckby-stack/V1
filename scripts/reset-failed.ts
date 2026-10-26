import { db } from "@/lib/db";
async function main() {
  // Reset all failed tasks back to pending (they failed due to the pre-existing
  // type error in agent-llm.ts, not because the fix was wrong). Reset attempts
  // so the generator doesn't permanently skip them.
  const failed = await db.selfTask.findMany({ where: { status: "failed" }, select: { id: true, kind: true, filePath: true, line: true, attempts: true } });
  console.log(`Found ${failed.length} failed tasks:`);
  for (const t of failed) console.log(`  [${t.kind}] ${t.filePath}:${t.line} attempts=${t.attempts}`);
  const result = await db.selfTask.updateMany({
    where: { status: "failed" },
    data: { status: "pending", attempts: 0, lastError: null },
  });
  console.log(`Reset ${result.count} tasks to pending.`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
