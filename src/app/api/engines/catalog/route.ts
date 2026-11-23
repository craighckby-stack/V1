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

  const results = SIPHON_SOURCES.map((source, i) => {
    let isValid = true;
    let reason = "";
    let patterns: string[] | undefined = undefined;

    if (!source) {
      isValid = false;
      reason = "Source element is null or undefined.";
    } else {
      // Type guard for SiphonSource structure
      const sourceTyped = source as SiphonSource & { patterns?: string[] };
      patterns = sourceTyped.patterns;

      if (!patterns || !Array.isArray(patterns)) {
        isValid = false;
        reason = "Source is missing 'patterns' array or 'patterns' is not an array.";
      } else if (patterns.length === 0) {
        isValid = false;
        reason = "Source patterns array is empty.";
      } else {
        // Check all patterns for validity
        const firstInvalidIndex = patterns.findIndex((p): p is string => typeof p === 'string');
        if (firstInvalidIndex === -1) {
          isValid = false;
          reason = "One or more patterns in the source array are not strings.";
        }
      }
    }

    return {
      index: i,
      isValid,
      reason,
      source: source as SiphonSource,
      patterns: patterns as string[] | undefined,
    };
  });

  const validSources: CatalogEntry[] = [];
  const invalidSources: InvalidSource[] = [];

  results.forEach(result => {
    if (result.isValid) {
      // Source is valid, construct CatalogEntry
      validSources.push({
        source: result.source,
        count: (result.patterns || []).length,
        complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
        status: "configured",
      });
    } else {
      invalidSources.push({ index: result.index, reason: result.reason });
    }
  });

  if (invalidSources.length > 0) {
    return NextResponse.json(
      { 
        error: "Input validation failed: One or more siphon sources are invalid.", 
        invalidSources: invalidSources.map(inv => ({ index: inv.index, reason: inv.reason }))
      },
      { status: 400 }
    );
  }
    
  return NextResponse.json({ sources: validSources });
}