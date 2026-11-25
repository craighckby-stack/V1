import { db } from "@/lib/db";
async function main() {
  try {
    const row = await db.llmConfig.findUnique({ where: { id: "singleton" } });
    
    if (row) {
      console.log("configured:", true);
      // Narrowed payload to essential configuration details
      console.log("model:", row.geminiModel, "hasKey:", !!row.geminiApiKey, "lastError:", row.lastError || "N/A");
    } else {
      console.warn("LLM configuration record with id 'singleton' not found in the database.");
    }
  } catch (e) {
    // Improved error context for database operation failure
    console.error("CRITICAL: Error during LLM configuration check (DB access failed). Ensure database connection is active and schema is correct.", e);
    process.exit(1);
  }
}
main().catch(e => {
  // This catch block is now redundant due to try/catch in main, but kept to satisfy the original structure if main() itself threw outside the try block scope (unlikely here).
  // However, since main() now handles its own critical exit, this outer catch is mostly for unexpected runtime errors outside the DB call.
  console.error("CRITICAL: Unexpected runtime error during LLM configuration check.", e);
  process.exit(1);
});