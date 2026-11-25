import { NextResponse } from "next/server";
import { emgRagInstance } from "@/lib/pipeline/emg/emg-rag";

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
    console.error("Memory service is not initialized. Cannot serve memory entries.");
    return NextResponse.json(
      { error: "Memory service is not properly initialized. Check service startup logs." },
      { status: 503 }
    );
  }

  try {
    // Run retrieval. Assuming getAll() handles necessary initialization/seeding checks internally
    // to reduce latency by avoiding a separate ensureSeeded() call.
    const entriesResult = await emgRagInstance.getAll();
    
    // Ensure we return an array, defaulting to empty array if null or undefined
    const entries = Array.isArray(entriesResult) ? entriesResult : [];
    return NextResponse.json({ entries: entries });
  } catch (err: unknown) {
    let errorMessage = "An error occurred while accessing the memory store. Please check server logs for details.";
    let statusCode = 500;
    let error: Error;

    if (err instanceof Error) {
        error = err;
    } else {
        // If it's not an Error instance, wrap it with context
        error = new Error("An unknown error occurred during memory retrieval from RAG store.");
        // Log the full unknown error object safely
        console.error("Unknown error object during memory retrieval:", String(err));
    }
    
    // Log the actual error for debugging purposes before sending a generic response
    console.error("Error retrieving memory entries from RAG store:", error.message, error.stack ? error.stack : "No stack trace available");
    
    // Provide more specific error messages based on error type/message content
    const message = error.message;
    if (message.includes("connection") || message.includes("timeout")) {
        errorMessage = "The memory store service is temporarily unavailable due to a connection issue. Please retry later.";
        statusCode = 503;
    } else if (message.includes("not found") || message.includes("missing")) {
        errorMessage = "Required memory data is missing. The service may need to be reinitialized.";
        statusCode = 404;
    }
    
    return NextResponse.json(
      { error: errorMessage },
      { status: statusCode }
    );
  }
}