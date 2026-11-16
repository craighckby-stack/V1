import { NextResponse } from "next/server";
import { emgRagInstance, VectorEntry } from "@/lib/pipeline/emg/emg-rag";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/memory/entries
 *
 * Ensures the RAG memory store is seeded, then returns every persisted
 * memory entry (clean patterns, failure diagnoses, etc.).
 */
export async function GET() {
  if (!emgRagInstance) {
    return NextResponse.json(
      { error: "Memory service is not properly initialized. Check service startup logs." },
      { status: 503 } // Changed to 503 Service Unavailable for uninitialized dependency
    );
  }

  try {
    // Run seeding and fetching in parallel to reduce latency
    const [seedResult, entries] = await Promise.all([
      emgRagInstance.ensureSeeded(),
      emgRagInstance.getAll(),
    ]);
    
    // Ensure we return an array, defaulting to empty array if null or undefined
    return NextResponse.json({ entries: entries || [] });
  } catch (err: unknown) {
    // Log the actual error for debugging purposes before sending a generic response
    const error = err instanceof Error ? err : new Error("An unknown error occurred during memory retrieval from RAG store.");
    console.error("Error retrieving memory entries from RAG store:", error.message, error.stack ? error.stack : "No stack trace available");
    
    let errorMessage = "An error occurred while accessing the memory store. Please check server logs for details.";
    let statusCode = 500;

    // If the error message suggests a specific issue (e.g., database connection failure), 
    // we might refine the response, but sticking to the original structure while ensuring context.
    if (error.message.includes("connection") || error.message.includes("timeout")) {
        errorMessage = "The memory store service is temporarily unavailable due to a connection issue. Please retry later.";
        statusCode = 503; // Use 503 for transient service unavailability
    }
    
    return NextResponse.json(
      { error: errorMessage },
      { status: statusCode }
    );
  }
}