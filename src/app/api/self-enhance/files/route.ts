import { NextResponse } from "next/server";
import { readdirSync } from "fs";
import { join, relative } from "path";
import { PROTECTED_FILES } from "@/lib/pipeline/autonomous/self-enhance-loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PIPELINE_SRC_DIR = "/home/z/my-project/src/lib/pipeline";
const DISPLAY_SRC_DIR = "/home/z/my-project/src/app/display";
const PROJECT_ROOT = "/home/z/my-project";

/**
 * GET /api/self-enhance/files
 *
 * Returns the REAL file inventory scanned from disk — never a hardcoded
 * listing. Two scopes:
 *   1. src/lib/pipeline/ (.ts) — the system's own logic
 *   2. src/app/display/ (.tsx) — the mutable UI display layer
 * Each file is classified against the live PROTECTED_FILES set (the same
 * set the loop uses), so the UI's `files` command can never drift from
 * reality.
 */
export async function GET() {
  try {
    const files: Array<{ path: string; protectedFile: boolean }> = [];

    const scan = (dir: string, wantTsx: boolean) => {
      let entries: import("fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // dir may not exist yet
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, wantTsx);
        } else {
          const isTs = entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts");
          const isTsx = wantTsx && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx");
          if (isTs || isTsx) {
            const relPath = relative(PROJECT_ROOT, fullPath);
            files.push({
              path: relPath,
              protectedFile: PROTECTED_FILES.has(relPath),
            });
          }
        }
      }
    };
    scan(PIPELINE_SRC_DIR, false); // .ts only
    scan(DISPLAY_SRC_DIR, true); // .tsx — the mutable display layer

    // Sorted for stable output
    files.sort((a, b) => a.path.localeCompare(b.path));

    return NextResponse.json({
      root: "src/lib/pipeline/ + src/app/display/",
      totalFiles: files.length,
      protectedCount: files.filter((f) => f.protectedFile).length,
      enhanceableCount: files.filter((f) => !f.protectedFile).length,
      files,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to scan directories: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
