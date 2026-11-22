import { db } from "@/lib/db";
async function main() {
  const row = await db.llmConfig.findUnique({ where: { id: "singleton" } });
  console.log("configured:", !!row);
  if (row) {
    console.log("model:", row.geminiModel, "hasKey:", !!row.geminiApiKey, "lastError:", row.lastError);
  } else {
    console.warn("LLM configuration record with id 'singleton' not found in the database.");
  }
}
main().catch(e => {
  // Improved error context for database operation failure
  console.error("CRITICAL: Error during LLM configuration check (DB access failed). Ensure database connection is active and schema is correct.", e);
  process.exit(1);
});