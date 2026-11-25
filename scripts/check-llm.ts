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
    const error = e instanceof Error ? e : new Error("An unknown error occurred during LLM configuration check.");
    // Improved error context for database operation failure
    console.error("CRITICAL: Error during LLM configuration check (DB access failed). Ensure database connection is active and schema is correct.", error.message);
    process.exit(1);
  }
}
main();