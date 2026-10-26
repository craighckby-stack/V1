import { db } from "@/lib/db";
async function main() {
  const row = await db.llmConfig.findUnique({ where: { id: "singleton" } });
  console.log("configured:", !!row);
  if (row) console.log("model:", row.geminiModel, "hasKey:", !!row.geminiApiKey, "lastError:", row.lastError);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
