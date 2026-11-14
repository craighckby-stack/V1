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
        { error: "Catalog sources not available - SIPHON_SOURCES is undefined" },
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
        // Throwing here will be caught by the outer try/catch
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
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during catalog retrieval.";
    return NextResponse.json(
      { error: `Failed to retrieve catalog from /api/engines/catalog: ${errorMessage}` },
      { status: 500 }
    );
  }
}