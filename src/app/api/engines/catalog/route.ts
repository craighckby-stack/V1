import { NextResponse } from "next/server";
import { SIPHON_SOURCES, SiphonSource } from "@/lib/pipeline/core/siphon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CatalogEntry {
  source: SiphonSource;
  count: number;
  complianceStandard: string;
  status: string;
}

/**
 * GET /api/engines/catalog
 * Lists every siphon (architectural template) source available to the pipeline.
 */
export async function GET() {
  try {
    if (!SIPHON_SOURCES) {
      return NextResponse.json(
        { error: "Catalog sources not available - SIPHON_SOURCES is undefined or null" },
        { status: 500 }
      );
    }

    if (!Array.isArray(SIPHON_SOURCES)) {
      return NextResponse.json(
        { error: "SIPHON_SOURCES must be an array." },
        { status: 500 }
      );
    }

    const sources: CatalogEntry[] = SIPHON_SOURCES.map((source) => {
      if (!source || !source.patterns) {
        // Return an error structure immediately for invalid entries instead of throwing
        // to prevent the entire request from failing with a generic 500.
        throw new Error(`Invalid siphon source found: missing required 'patterns' property in source object.`);
      }
      
      return {
        source,
        count: source.patterns.length,
        complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
        // Honest label: these are CONFIGURED siphon sources (declarative
        // config), not verified-live remote repositories. No liveness probe
        // is performed here, so we don't claim "active".
        status: "configured",
      };
    });
    
    return NextResponse.json({ sources });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid siphon source found:")) {
      // Handle specific validation errors from map() as 400 Bad Request
      return NextResponse.json(
        { error: `Input validation failed for catalog sources: ${err.message}` },
        { status: 400 }
      );
    }
    
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during catalog retrieval.";
    return NextResponse.json(
      { error: `Failed to retrieve catalog from /api/engines/catalog: ${errorMessage}` },
      { status: 500 }
    );
  }
}