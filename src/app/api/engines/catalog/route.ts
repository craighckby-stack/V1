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

interface InvalidSource {
  index: number;
  reason: string;
}

/**
 * GET /api/engines/catalog
 * Lists every siphon (architectural template) source available to the pipeline.
 */
export async function GET() {
  if (!SIPHON_SOURCES) {
    return NextResponse.json(
      { error: "Catalog sources not available: SIPHON_SOURCES is undefined or null. Check pipeline initialization." },
      { status: 500 }
    );
  }

  if (!Array.isArray(SIPHON_SOURCES)) {
    return NextResponse.json(
      { error: "SIPHON_SOURCES must be an array, received type: " + typeof SIPHON_SOURCES },
      { status: 500 }
    );
  }

  if (SIPHON_SOURCES.length === 0) {
    return NextResponse.json({ sources: [] });
  }

  const validSources: CatalogEntry[] = [];
  const invalidSources: InvalidSource[] = [];

  SIPHON_SOURCES.forEach((source, i) => {
    if (!source) {
      invalidSources.push({
        index: i,
        reason: "Source element is null or undefined.",
      });
      return;
    }

    // Check for required structure properties directly on the source object
    const patterns = source.patterns;

    if (!patterns || !Array.isArray(patterns)) {
      invalidSources.push({
        index: i,
        reason: "Source is missing 'patterns' array or 'patterns' is not an array.",
      });
      return;
    }

    if (patterns.length === 0) {
      invalidSources.push({
        index: i,
        reason: "Source patterns array is empty.",
      });
      return;
    }

    // Check all patterns for validity
    const hasInvalidPattern = patterns.some(p => typeof p !== 'string');
    if (hasInvalidPattern) {
      invalidSources.push({
        index: i,
        reason: "One or more patterns in the source array are not strings.",
      });
      return;
    }

    // Source is valid, construct CatalogEntry
    // Since we validated the structure, we can safely cast/assume SiphonSource structure here
    validSources.push({
      source: source as SiphonSource,
      count: patterns.length,
      complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
      status: "configured",
    });
  });

  if (invalidSources.length > 0) {
    return NextResponse.json(
      { 
        error: "Input validation failed: One or more siphon sources are invalid.", 
        invalidSources: invalidSources
      },
      { status: 400 }
    );
  }
    
  return NextResponse.json({ sources: validSources });
}