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

interface ValidationResult {
  index: number;
  entry?: CatalogEntry;
  invalid?: InvalidSource;
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

  const validationPromises = SIPHON_SOURCES.map((source, i) => {
    // Synchronous validation logic, no need for Promise wrapper
    if (!source) {
      return { index: i, invalid: { index: i, reason: "Source element is null or undefined." } } as ValidationResult;
    }

    const patterns = source.patterns;

    if (!patterns || !Array.isArray(patterns)) {
      return { index: i, invalid: { index: i, reason: "Source is missing 'patterns' array or 'patterns' is not an array." } } as ValidationResult;
    }

    if (patterns.length === 0) {
      return { index: i, invalid: { index: i, reason: "Source patterns array is empty." } } as ValidationResult;
    }

    // Check all patterns for validity
    const hasInvalidPattern = patterns.some(p => typeof p !== 'string');
    if (hasInvalidPattern) {
      return { index: i, invalid: { index: i, reason: "One or more patterns in the source array are not strings." } } as ValidationResult;
    }

    // Source is valid, construct CatalogEntry
    return {
      index: i,
      entry: {
        source: source as SiphonSource,
        count: patterns.length,
        complianceStandard: "AST Diff Gate + Shannon Entropy Sanitizer",
        status: "configured",
      },
    } as ValidationResult;
  });

  const results = validationPromises; // Already synchronous array

  const validSources: CatalogEntry[] = [];
  const invalidSources: InvalidSource[] = [];

  results.forEach(result => {
    if (result.entry) {
      validSources.push(result.entry);
    } else if (result.invalid) {
      invalidSources.push(result.invalid);
    }
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