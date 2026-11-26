import { db } from "@/lib/db";
async function main() {
  try {
    const row = await db.llmConfig.findUnique({ where: { id: "singleton" } });
    
    if (row) {
      console.log("configured:", true);
      // Narrowed payload to essential configuration details
      console.log("model:", row.geminiModel, "hasKey:", !!row.geminiApiKey, "lastError:", row.lastError ?? "N/A");
    } else {
      console.warn("LLM configuration record with id 'singleton' not found in the database.");
    }
  } catch (e: unknown) {
    let errorMessage = "An unknown error occurred during LLM configuration check.";
    
    if (e instanceof Error) {
      errorMessage = e.message;
    } else if (typeof e === 'string') {
      errorMessage = e;
    } else {
      // Handle other types (e.g., objects without Error interface) safely
      errorMessage = String(e);
    }
    
    // Improved error context for database operation failure
    console.error("CRITICAL: Error during LLM configuration check (DB access failed). Ensure database connection is active and schema is correct. Details:", errorMessage);
  }
}
main();