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
    return NextResponse.json(
      { error: "Memory service is not properly initialized. Check service startup logs." },
      { status: 503 }
    );
  }

  try {
    // First ensure the store is seeded
    await emgRagInstance.ensureSeeded();
    
    // Then retrieve all entries (must be awaited if it's an async operation)
    const entries = await emgRagInstance.getAll();

    // Ensure we return an array, defaulting to empty array if null or undefined
    return NextResponse.json({ entries: entries || [] });
  } catch (err: unknown) {
    // Ensure 'error' is always an Error instance before accessing properties
    let error: Error;
    if (err instanceof Error) {
        error = err;
    } else {
        error = new Error("An unknown error occurred during memory retrieval from RAG store.");
    }
    
    // Log the actual error for debugging purposes before sending a generic response
    console.error("Error retrieving memory entries from RAG store:", error.message, error.stack ? error.stack : "No stack trace available");
    
    let errorMessage = "An error occurred while accessing the memory store. Please check server logs for details.";
    let statusCode = 500;

    // Provide more specific error messages based on error type
    if (error.message.includes("connection") || error.message.includes("timeout")) {
        errorMessage = "The memory store service is temporarily unavailable due to a connection issue. Please retry later.";
        statusCode = 503;
    } else if (error.message.includes("not found") || error.message.includes("missing")) {
        errorMessage = "Required memory data is missing. The service may need to be reinitialized.";
        statusCode = 404;
    }
    
    return NextResponse.json(
      { error: errorMessage },
      { status: statusCode }
    );
  }
}