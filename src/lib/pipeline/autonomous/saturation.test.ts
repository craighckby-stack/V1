import { describe, test, expect } from "bun:test";
import { SCAN_SCOPES } from "./saturation";
import { isProtectedPath } from "./protected-files";
import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";

/**
 * Characterization tests for the v4 scan scope (operator-directed,
 * 2026-11-12). The scope was rolled back from `src/components` to
 * `src/lib/pipeline` + `src/app` because 88% of mutations on
 * `src/components/ui` (vendored shadcn primitives) were convergent
 * defensive no-ops.
 *
 * These tests pin the scope so a future "the loop should also scan X"
 * expansion has to update this file (and an operator has to review it).
 * The enforcement is architectural: `saturation.ts` is in PROTECTED_FILES
 * (protected-files.ts), so the loop itself cannot edit SCAN_SCOPES —
 * only a human-directed change to this protected file can. These tests
 * are the documentation + the regression canary.
 */
describe("SCAN_SCOPES (v4 operator-directed rollback)", () => {
  test("exactly two scopes: src/lib/pipeline and src/app", () => {
    expect(SCAN_SCOPES).toHaveLength(2);
    expect(SCAN_SCOPES[0].dir).toBe("src/lib/pipeline");
    expect(SCAN_SCOPES[1].dir).toBe("src/app");
  });

  test("does NOT include src/components (the rolled-back vendored/ui subtree)", () => {
    // The whole src/components dir is gone — neither ui nor pipeline.
    for (const scope of SCAN_SCOPES) {
      expect(scope.dir.startsWith("src/components")).toBe(false);
    }
  });

  test("src/lib/pipeline scope is .ts only (no .tsx exists there)", () => {
    expect(SCAN_SCOPES[0].extensions).toEqual([".ts"]);
  });

  test("src/app scope covers both .ts and .tsx (routes + display)", () => {
    // The merge of src/app/display (.tsx) + src/app/api (.ts) into a
    // single src/app scope requires both extensions.
    expect(SCAN_SCOPES[1].extensions).toContain(".ts");
    expect(SCAN_SCOPES[1].extensions).toContain(".tsx");
  });

  test("protected subtrees under src/app are still filtered by isProtectedPath", () => {
    // The merged src/app scope includes paths that are individually
    // protected (the control-surface + gate + PAT-using APIs). The
    // scanFiles() method in self-enhance-loop.ts filters these via
    // isProtectedPath after the directory walk. This test pins that
    // the filter still rejects them — so the scope merge did NOT
    // accidentally expose protected paths to mutation.
    const protectedAppPaths = [
      "src/app/page.tsx", // control surface
      "src/app/layout.tsx",
      "src/app/api/self-enhance/start/route.ts",
      "src/app/api/autonomous/status/route.ts",
      "src/app/api/hot-swap/status/route.ts",
      "src/app/api/duress/route.ts",
      "src/app/api/red-team/run/route.ts",
      "src/app/api/postmortems/route.ts",
      "src/app/api/pipeline/run/route.ts",
      "src/app/api/github/route.ts",
      "src/app/api/oracle/route.ts",
      "src/app/api/secret-scan/route.ts",
      "src/app/api/evolution/route.ts",
      "src/app/api/emg/route.ts",
      "src/app/api/branches/route.ts",
    ];
    for (const p of protectedAppPaths) {
      expect(isProtectedPath(p)).toBe(true);
    }
  });

  test("non-protected src/app paths ARE scannable (display, memory, engines, self-model)", () => {
    // The merge preserves the previously-scannable non-protected subtrees.
    const scannableAppPaths = [
      "src/app/display/console-stream.tsx",
      "src/app/api/memory/entries/route.ts",
      "src/app/api/memory/query/route.ts",
      "src/app/api/engines/catalog/route.ts",
      "src/app/api/self-model/route.ts",
    ];
    for (const p of scannableAppPaths) {
      expect(isProtectedPath(p)).toBe(false);
    }
  });

  test("src/components/ui is NOT scannable (the vendored primitives the operator rolled back)", () => {
    // Even though src/components/ui is not in PROTECTED_FILES, it is
    // no longer in any SCAN_SCOPE — so scanFiles() never enumerates it.
    // This test confirms the negative: no scope covers it.
    const uiSample = "src/components/ui/button.tsx";
    // It's not protected (it's third-party, not control surface):
    expect(isProtectedPath(uiSample)).toBe(false);
    // And it's not in any scan scope:
    const inScope = SCAN_SCOPES.some((s) => "src/components/ui/button.tsx".startsWith(s.dir + "/"));
    expect(inScope).toBe(false);
  });

  test("the merge reduced the scannable surface (no src/components file is in any scope)", () => {
    // Walk src/components and confirm nothing there is covered by a scope.
    // This is the regression canary: if a future change re-adds
    // src/components, this test breaks loudly.
    const componentFiles: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const rel = p.replace(/\\/g, "/").replace(/^.*\/src\//, "src/");
        if (statSync(p).isDirectory()) walk(p);
        else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) componentFiles.push(rel);
      }
    };
    walk(join(process.cwd(), "src/components"));
    for (const f of componentFiles) {
      const inScope = SCAN_SCOPES.some((s) => f.startsWith(s.dir + "/"));
      expect(inScope).toBe(false);
    }
  });
});
