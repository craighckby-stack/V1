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
 *   v6 (2026-11-22): out-of-src expansion — the mini-services
 *   loop-worker, loop-ws-service, and fleet-harvester join the scope
 *   (scoped-program typecheck via in-memory-typecheck.ts; dev-watchdog
 *   stays protected as the resurrection layer).
 *   v7 (2026-11-22): the operator utility scripts join as `scripts/`
 *   (.ts, root tsconfig program). push-now.ts / seal-push-token.ts
 *   (the credential/push path) and dev-daemon.py (supervision) are
 *   protected individually; .zscripts/ (the launch chain) is
 *   prefix-protected.
 *
 * These tests pin the v7 scope so a future "the loop should also scan X"
 * expansion has to update this file (and an operator has to review it).
 * The enforcement is architectural: `saturation.ts` is in PROTECTED_FILES
 * (protected-files.ts), so the loop itself cannot edit SCAN_SCOPES —
 * only a human-directed change to this protected file can. These tests
 * are the documentation + the regression canary.
 */
describe("SCAN_SCOPES (v7 operator-directed expansion)", () => {
  test("exactly seven scopes: 3 src + 3 mini-services + scripts", () => {
    expect(SCAN_SCOPES).toHaveLength(7);
    expect(SCAN_SCOPES[0].dir).toBe("src/lib/pipeline");
    expect(SCAN_SCOPES[1].dir).toBe("src/app");
    expect(SCAN_SCOPES[2].dir).toBe("src/components/pipeline");
    expect(SCAN_SCOPES[3].dir).toBe("mini-services/loop-worker");
    expect(SCAN_SCOPES[4].dir).toBe("mini-services/loop-ws-service");
    expect(SCAN_SCOPES[5].dir).toBe("mini-services/fleet-harvester");
    expect(SCAN_SCOPES[6].dir).toBe("scripts");
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

  test("v6 boundary in mini-services: the three services ARE in scope, dev-watchdog is NOT", () => {
    // The out-of-src expansion (v6) covers the worker wrapper, the WS
    // relay, and the fleet harvester. dev-watchdog — the dev server's
    // 2-strike respawn supervisor — is prefix-protected and must stay
    // out of every scope (the resurrection layer is never a mutation
    // target).
    const inScope = (rel: string) =>
      SCAN_SCOPES.some((s) => rel.startsWith(s.dir + "/"));
    expect(inScope("mini-services/loop-worker/index.ts")).toBe(true);
    expect(inScope("mini-services/loop-ws-service/index.ts")).toBe(true);
    expect(inScope("mini-services/fleet-harvester/src/lib/engineHarvester.ts")).toBe(true);
    // The watchdog is BOTH out of scope and explicitly protected:
    expect(inScope("mini-services/dev-watchdog/index.ts")).toBe(false);
    expect(isProtectedPath("mini-services/dev-watchdog/index.ts")).toBe(true);
  });

  test("v7 boundary in scripts/: utility scripts ARE in scope, the credential/push path is NOT", () => {
    // The operator utility scripts join the scope; the two scripts
    // that handle the sealed PAT (push-now, seal-push-token) and the
    // dev-server daemonizer stay protected. A loop that could rewrite
    // its own credential-sealing path is the same escape hatch as
    // rewriting push-target.ts.
    const inScope = (rel: string) =>
      SCAN_SCOPES.some((s) => rel.startsWith(s.dir + "/"));
    // Utility scripts — scannable (root tsconfig program, same gates):
    expect(inScope("scripts/audit-remote.ts")).toBe(true);
    expect(inScope("scripts/check-llm.ts")).toBe(true);
    expect(inScope("scripts/q.ts")).toBe(true);
    expect(inScope("scripts/record-uuid-postmortem.ts")).toBe(true);
    expect(inScope("scripts/repair-prophecy-verdicts.ts")).toBe(true);
    // Credential/push path — protected:
    expect(isProtectedPath("scripts/push-now.ts")).toBe(true);
    expect(isProtectedPath("scripts/seal-push-token.ts")).toBe(true);
    expect(inScope("scripts/push-now.ts")).toBe(true); // in the scripts/ scope...
    // ...but isProtectedPath is the hard floor: scanFiles filters it.
    // (Being in a scope AND protected means the scope walk enumerates
    // it and the filter drops it — same as protected src/app routes.)
  });

  test("v7 launch chain: .zscripts/ is prefix-protected and never scannable", () => {
    // .zscripts/ holds dev.sh / start.sh / mini-services-*.sh — the
    // launch layer. Not in any scan scope, and prefix-protected so a
    // future widening can't reach it without operator review.
    const inScope = (rel: string) =>
      SCAN_SCOPES.some((s) => rel.startsWith(s.dir + "/"));
    expect(inScope(".zscripts/dev.sh")).toBe(false);
    expect(isProtectedPath(".zscripts/dev.sh")).toBe(true);
    expect(isProtectedPath(".zscripts/mini-services-start.sh")).toBe(true);
    // And the daemonizer entry (defense in depth for a future .py scope):
    expect(isProtectedPath("scripts/dev-daemon.py")).toBe(true);
  });
});
