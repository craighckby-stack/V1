import { NextResponse } from "next/server";
import { readdirSync } from "fs";
import { join, relative } from "path";
import { isProtectedPath } from "@/lib/pipeline/autonomous/protected-files";
import { SCAN_SCOPES } from "@/lib/pipeline/autonomous/saturation";
import { PROJECT_ROOT } from "@/lib/pipeline/core/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/self-enhance/files
 *
 * Returns the REAL file inventory scanned from disk — never a hardcoded
 * listing. Uses the SAME SCAN_SCOPES the loop's scanFiles() uses (audit 6:
 * the prior version hardcoded only 2 of the 4 scopes, so the UI never
 * showed src/components or src/app/api files even though the loop scans
 * them). Each file is classified against isProtectedPath() — the single
 * predicate the loop uses — so the UI's `files` command can never drift
 * from the loop's actual scope.
 */
export async function GET() {
  try {
    const files: Array<{ path: string; protectedFile: boolean }> = [];

    const scan = (dir: string, extensions: string[]) => {
      let entries: import("fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // dir may not exist yet
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, extensions);
        } else {
          const isTs = entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts");
          const isTsx = entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx");
          const matches =
            (extensions.includes(".ts") && isTs) ||
            (extensions.includes(".tsx") && isTsx);
          if (matches) {
            const relPath = relative(PROJECT_ROOT, fullPath);
            files.push({
              path: relPath,
              protectedFile: isProtectedPath(relPath),
            });
          }
        }
      }
    };

    // Scan ALL 4 scopes — matches the loop's scanFiles() exactly.
    const scopeSummary = SCAN_SCOPES.map((s) => s.dir).join(" + ");
    for (const scope of SCAN_SCOPES) {
      scan(join(PROJECT_ROOT, scope.dir), scope.extensions);
    }

    // Sorted for stable output
    files.sort((a, b) => a.path.localeCompare(b.path));

    return NextResponse.json({
      root: scopeSummary,
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
