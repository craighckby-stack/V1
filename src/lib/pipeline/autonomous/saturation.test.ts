import { describe, test, expect } from "bun:test";
import { SCAN_SCOPES } from "./saturation";
import { isProtectedPath } from "./protected-files";
import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";

/**
 * Characterization tests for the scan scope (operator-directed).
 *
 * History:
 *   v4 (2026-11-12): scope rolled back from `src/components` to
 *   `src/lib/pipeline` + `src/app` because 88% of mutations on
 *   `src/components/ui` (vendored shadcn primitives) were convergent
 *   defensive no-ops.
 *   v5 (2026-11-17): LOOP-authored display panels RE-ADDED as
 *   `src/components/pipeline` (.tsx). The vendored `src/components/ui`
 *   subtree stays excluded (third-party code). Control-surface
 *   components inside the re-added subtree (api-unlock.tsx,
 *   boot-splash.tsx) are protected individually in PROTECTED_FILES;
 *   the operator-PIN gate on [unlock] + the convergent-move guard are
 *   the friction layers that made the re-expansion safe.
 *
 * These tests pin the v5 scope so a future "the loop should also scan X"
 * expansion has to update this file (and an operator has to review it).
 * The enforcement is architectural: `saturation.ts` is in PROTECTED_FILES
 * (protected-files.ts), so the loop itself cannot edit SCAN_SCOPES —
 * only a human-directed change to this protected file can. These tests
 * are the documentation + the regression canary.
 */
describe("SCAN_SCOPES (v5 operator-directed re-expansion)", () => {
  test("exactly three scopes: src/lib/pipeline, src/app, src/components/pipeline", () => {
    expect(SCAN_SCOPES).toHaveLength(3);
    expect(SCAN_SCOPES[0].dir).toBe("src/lib/pipeline");
    expect(SCAN_SCOPES[1].dir).toBe("src/app");
    expect(SCAN_SCOPES[2].dir).toBe("src/components/pipeline");
  });

  test("includes ONLY src/components/pipeline — not all of src/components, not the vendored ui subtree", () => {
    // v5 re-added the LOOP-authored display panels as a narrow scope.
    // The scope must be exactly "src/components/pipeline": broader
    // ("src/components") would re-sweep the vendored shadcn primitives;
    // narrower would miss panels. Anything under src/components/ui
    // stays uncovered.
    for (const scope of SCAN_SCOPES) {
      if (scope.dir.startsWith("src/components")) {
        expect(scope.dir).toBe("src/components/pipeline");
      }
    }
    const uiInScope = SCAN_SCOPES.some((s) =>
      s.dir === "src/components" || s.dir.startsWith("src/components/ui")
    );
    expect(uiInScope).toBe(false);
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
      "src/app/api/branches/route.ts",
    ];
    for (const p of protectedAppPaths) {
      expect(isProtectedPath(p)).toBe(true);
    }
  });

  test("non-protected src/app paths ARE scannable (display, memory, boot, self-model)", () => {
    // The merge preserves the previously-scannable non-protected subtrees.
    // (api/memory/query and api/engines/catalog were deleted as unused
    // routes in the endpoint cleanup — api/emg and api/evolution went
    // with them, and their PROTECTED_PREFIXES entries went too.)
    const scannableAppPaths = [
      "src/app/display/console-stream.tsx",
      "src/app/api/memory/entries/route.ts",
      "src/app/api/boot/scan/route.ts",
      "src/app/api/self-model/route.ts",
    ];
    for (const p of scannableAppPaths) {
      expect(isProtectedPath(p)).toBe(false);
    }
  });

  test("src/components/ui is NOT scannable (vendored primitives stay excluded in v5)", () => {
    // Even though src/components/ui is not in PROTECTED_FILES, it is
    // not in any SCAN_SCOPE — so scanFiles() never enumerates it.
    // This test confirms the negative: no scope covers it.
    const uiSample = "src/components/ui/button.tsx";
    // It's not protected (it's third-party, not control surface):
    expect(isProtectedPath(uiSample)).toBe(false);
    // And it's not in any scan scope:
    const inScope = SCAN_SCOPES.some((s) => "src/components/ui/button.tsx".startsWith(s.dir + "/"));
    expect(inScope).toBe(false);
  });

  test("v5 boundary inside src/components: pipeline files ARE in scope, ui files are NOT", () => {
    // Walk src/components and pin the v5 split: LOOP-authored pipeline
    // panels are scannable, the vendored shadcn primitives are not.
    // This is the regression canary: if a future change broadens the
    // components scope past src/components/pipeline (re-sweeping the
    // vendored subtree) or drops it entirely, this test breaks loudly.
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
    expect(componentFiles.length).toBeGreaterThan(0);
    for (const f of componentFiles) {
      const inScope = SCAN_SCOPES.some((s) => f.startsWith(s.dir + "/"));
      if (f.startsWith("src/components/pipeline/")) {
        // v5: LOOP-authored panels are intentionally scannable...
        expect(inScope).toBe(true);
      } else {
        // ...everything else under src/components (vendored ui) is not.
        expect(inScope).toBe(false);
      }
    }
  });
});
