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
      { error: "Catalog sources not available: SIPHON_SOURCES is undefined or null." },
      { status: 500 }
    );
  }

  if (!Array.isArray(SIPHON_SOURCES)) {
    return NextResponse.json(
      { error: "SIPHON_SOURCES must be an array." },
      { status: 500 }
    );
  }

  if (SIPHON_SOURCES.length === 0) {
    return NextResponse.json({ sources: [] });
  }

  // Use reduce for a single pass to build both valid and invalid lists efficiently
  const { validSources, invalidSources } = SIPHON_SOURCES.reduce(
    (acc, source, i) => {
      const currentInvalidSources = [...acc.invalidSources];
      const currentValidSources = [...acc.validSources];

      if (!source) {
        currentInvalidSources.push({
          index: i,
          reason: "Source element is null or undefined.",
        });
        return { validSources: currentValidSources, invalidSources: currentInvalidSources };
      }

      // Type guard for SiphonSource structure
      const sourceTyped = source as SiphonSource & { patterns?: string[] };
      const patterns = sourceTyped.patterns;

      if (!patterns || !Array.isArray(patterns)) {
        currentInvalidSources.push({
          index: i,
          reason: "Source is missing 'patterns' array or 'patterns' is not an array.",
        });
        return { validSources: currentValidSources, invalidSources: currentInvalidSources };
      }

      if (patterns.length === 0) {
        currentInvalidSources.push({
          index: i,
          reason: "Source patterns array is empty.",
        });
        return { validSources: currentValidSources, invalidSources: currentInvalidSources };
      }

      // Check all patterns for validity
      const hasInvalidPattern = patterns.some(p => typeof p !== 'string');
      if (hasInvalidPattern) {
        currentInvalidSources.push({
          index: i,
          reason: "One or more patterns in the source array are not strings.",
        });
        return { validSources: currentValidSources, invalidSources: currentInvalidSources };
      }

      // Source is valid, construct CatalogEntry
      currentValidSources.push({
        source: source as SiphonSource,
        count: patterns.length,
        complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
        status: "configured",
      });
      
      return { validSources: currentValidSources, invalidSources: currentInvalidSources };
    },
    { validSources: [] as CatalogEntry[], invalidSources: [] as InvalidSource[] }
  );

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