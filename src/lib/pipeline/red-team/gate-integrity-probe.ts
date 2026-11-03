/**
 * GATE-INTEGRITY PROBE — deterministic self-audit of the gates.
 * (concepts: vibecode-pro-max-kit's 36 mechanical validators, Millennium
 * RSI's verified-gate principle at 1% of the cost — D5, twin of
 * test-attacker.ts)
 *
 * The attacker checks the TESTS with LLM calls; the probe checks the
 * GATES with pure functions. Both directions matter: a gate that
 * rejects everything is as broken as a gate that accepts anything, and
 * both failures are invisible from inside the loop (every mutation
 * just looks "rejected" or "accepted" — the system can't tell whether
 * that was earned).
 *
 * Every PROBE_INTERVAL cycles, run the suite: construct KNOWN-BAD and
 * KNOWN-GOOD proposals against the REAL live gate code and assert the
 * verdicts. The probes are the Millennium ablation in miniature: each
 * one proves a gate is doing work, not just returning.
 *
 *   P1 schema-gate rejects a model deletion          (known-bad)
 *   P2 schema-gate rejects a protected-model edit    (known-bad)
 *   P3 schema-gate rejects non-defaulted new fields  (known-bad)
 *   P4 schema-gate accepts a valid additive model    (known-good — a
 *      gate that rejects everything is also broken)
 *   P5-P8 protected-files blocks the control surface, the self-enhance
 *      API subtree, and the learning substrate, while NOT blocking the
 *      mutable body (over-blocking is drift too)
 *   P9 saturation classification contract (growth/neutral/no-growth)
 *   P10 the protection list contains its own auditors
 *
 *   AUDIT 3 additions — the gates the probe never tested:
 *   P11 the autonomous API subtree (the loop's own stop/start routes)
 *       is protected
 *   P12 mutation-guard rejects a newly-introduced eval( (the escape-
 *       pattern gate — runs on BOTH the autonomous and remote paths now)
 *   P13 secret-scan catches a ghp_ literal in content
 *   P14 ast-diff-gate rejects a dropped class method (the check the
 *       regex validator structurally cannot do)
 *   P15 the gate subtrees (core/, emg/, postmortem/, red-team/) are
 *       protected — the gates themselves must not be mutable
 *
 * ANY probe failure = a gate has stopped doing its job = raise the
 * safe-mode flag (runtime cache + durable DB row) and halt the loop
 * until the operator clears it. A self-improving system whose gates
 * silently fail is not improving; it is degrading with a paper trail.
 *
 * This file is in PROTECTED_FILES: it is part of the integrity chain.
 */

import { readFileSync } from "fs";
import { checkAdditiveSchema } from "../autonomous/schema-gate";
import { isProtectedPath } from "../autonomous/protected-files";
import { classifyGrowth } from "../autonomous/saturation";
import { raiseSafeModeFlag } from "../core/duress";
import { gateMutation } from "../core/mutation-guard";
import { evaluateAstDiff } from "../core/ast-diff-gate";
import { scanContent } from "../core/secret-scan";

const PROJECT_ROOT = "/home/z/my-project";
const SCHEMA_PATH = `${PROJECT_ROOT}/prisma/schema.prisma`;

/** Cycles between probe rounds. Not tunable (same rule as the attacker:
 *  the auditor is never on the same dial as the audited). */
export const PROBE_INTERVAL = 10;

export interface ProbeResult {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface ProbeRound {
  total: number;
  passed: number;
  failed: ProbeResult[];
  halted: boolean; // true → safe-mode was raised
}

// ── probe helpers: construct proposals against the LIVE schema ──────

function liveSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf-8");
}

/** Remove one `model X { ... }` block (inclusive) from schema text. */
function removeModel(text: string, model: string): string {
  const re = new RegExp(`^model\\s+${model}\\s*\\{[\\s\\S]*?^\\}\\s*`, "m");
  return text.replace(re, "");
}

/** Append a field line to a model block (first field position — safe
 *  for both protected-edit and additive probes). */
function appendFieldToModel(text: string, model: string, fieldDecl: string): string {
  return text.replace(
    new RegExp(`^(model\\s+${model}\\s*\\{)$`, "m"),
    `$1\n  ${fieldDecl.replace(/\n/g, "\n  ")}`
  );
}

/** Append a whole new model at the end. */
function appendModel(text: string, modelDecl: string): string {
  return `${text}\n${modelDecl}\n`;
}

const PROBE_CANARY_MODEL = `model ProbeCanaryNeverKept {
  id        String   @id @default(cuid())
  flag      Boolean  @default(false)
  note      String?
  createdAt DateTime @default(now())
}`;

// ── the suite ─────────────────────────────────────────────────────────

export function runGateIntegrityProbes(): ProbeRound {
  const results: ProbeResult[] = [];
  const schema = liveSchema();

  // P1: deleting a model (Lesson) must be rejected.
  let r = checkAdditiveSchema(schema, removeModel(schema, "Lesson"));
  results.push({ name: "P1 schema-gate rejects model deletion (Lesson)", expected: "reject", actual: r.ok ? "ACCEPT" : "reject", pass: !r.ok });

  // P2: editing a protected model (Postmortem) must be rejected.
  r = checkAdditiveSchema(schema, appendFieldToModel(schema, "Postmortem", "evilProbeField String"));
  results.push({ name: "P2 schema-gate rejects protected-model edit (Postmortem)", expected: "reject", actual: r.ok ? "ACCEPT" : "reject", pass: !r.ok });

  // P3: a new field without @default/nullable on a non-protected model
  // (PipelineRun) must be rejected — it would break existing rows.
  r = checkAdditiveSchema(schema, appendFieldToModel(schema, "PipelineRun", "evilNoDefault String"));
  results.push({ name: "P3 schema-gate rejects non-defaulted new field (PipelineRun)", expected: "reject", actual: r.ok ? "ACCEPT" : "reject", pass: !r.ok });

  // P4: a valid additive new model must be ACCEPTED. A gate that
  // rejects everything is as broken as one that accepts everything —
  // this probe is the over-blocking detector.
  r = checkAdditiveSchema(schema, appendModel(schema, PROBE_CANARY_MODEL));
  results.push({ name: "P4 schema-gate accepts valid additive model (canary)", expected: "accept", actual: r.ok ? "accept" : "REJECT", pass: r.ok });

  // P5: control surface is protected.
  const p5 = isProtectedPath("src/app/page.tsx");
  results.push({ name: "P5 protected-files blocks the control surface (page.tsx)", expected: "block", actual: p5 ? "block" : "OPEN", pass: p5 });

  // P6: the self-enhance API subtree is protected (prefix rule).
  const p6 = isProtectedPath("src/app/api/self-enhance/start/route.ts");
  results.push({ name: "P6 protected-files blocks the self-enhance API subtree", expected: "block", actual: p6 ? "block" : "OPEN", pass: p6 });

  // P7: the learning substrate is protected.
  const p7 = isProtectedPath("src/lib/pipeline/autonomous/lesson-store.ts");
  results.push({ name: "P7 protected-files blocks the learning substrate (lesson-store)", expected: "block", actual: p7 ? "block" : "OPEN", pass: p7 });

  // P8: the mutable body must NOT be blocked (over-blocking drift).
  // Audit 3: the old second canary (src/lib/pipeline/halt.ts) was a
  // PHANTOM — the real halt.ts lives in emg/ (now protected), so the old
  // check asserted nothing. Real mutable canaries: a UI component and
  // an advisory pipeline module (documented mutable in protected-files).
  const p8 =
    !isProtectedPath("src/components/ui/button.tsx") &&
    !isProtectedPath("src/lib/pipeline/autonomous/dreamer.ts") &&
    !isProtectedPath("src/lib/pipeline/autonomous/reflection.ts");
  results.push({ name: "P8 protected-files does NOT block the mutable body", expected: "open", actual: p8 ? "open" : "BLOCKED", pass: p8 });

  // P9: saturation classification contract — the churn control's
  // growth/neutral/no-growth split. "Deferred" MUST be neutral (a quota
  // pause is not a verdict on the file); "Rejected" MUST be no-growth.
  const p9 =
    classifyGrowth("Enhanced and live") === "growth" &&
    classifyGrowth("Deferred (LLM cooldown — 30s)") === "neutral" &&
    classifyGrowth("Rejected (typecheck failed — nothing written to disk)") === "no-growth" &&
    classifyGrowth("No issues found") === "no-growth";
  results.push({ name: "P9 saturation classify contract (growth/neutral/no-growth)", expected: "contract", actual: p9 ? "contract" : "DRIFTED", pass: p9 });

  // P10: the protected set actually contains the integrity chain itself
  // (the probe, the attacker, the tuner). A protection list that forgot
  // its own auditors is drift. (Audit 3: uses isProtectedPath — the
  // red-team subtree moved to PREFIX protection, so a raw Set.has check
  // would false-fail.)
  const p10 =
    isProtectedPath("src/lib/pipeline/red-team/gate-integrity-probe.ts") &&
    isProtectedPath("src/lib/pipeline/red-team/test-attacker.ts");
  results.push({ name: "P10 protected-files contains its own auditors", expected: "protected", actual: p10 ? "protected" : "MISSING", pass: p10 });

  // P11 (audit 3): the autonomous API subtree — the loop's own
  // start/stop/trigger routes — is protected. Same hazard as the
  // self-enhance subtree: a mutation of /api/autonomous/stop that
  // no-ops the stop call would take the operator's OFF switch away.
  const p11 = isProtectedPath("src/app/api/autonomous/stop/route.ts");
  results.push({ name: "P11 protected-files blocks the autonomous API subtree (stop route)", expected: "block", actual: p11 ? "block" : "OPEN", pass: p11 });

  // P12 (audit 3): mutation-guard must reject a NEWLY-introduced eval(
  // (not one that was already in the original — the diff is the point).
  // This is the escape-pattern gate; it runs on both mutation paths now.
  const p12a = gateMutation({
    filePath: "src/components/ui/canary.tsx",
    originalCode: "export function a() { return 1; }",
    evolvedCode: "export function a() { return eval('1'); }",
  });
  const p12b = gateMutation({
    filePath: "src/components/ui/canary.tsx",
    originalCode: "export function a() { return eval('1'); }",
    evolvedCode: "export function a() { return eval('2'); }",
  });
  const p12 = !p12a.allowed && p12b.allowed;
  results.push({ name: "P12 mutation-guard rejects NEWLY-introduced eval(, keeps pre-existing", expected: "reject-new/keep-old", actual: p12 ? "reject-new/keep-old" : "DRIFTED", pass: p12 });

  // P13 (audit 3): secret-san must flag a ghp_ literal. A scanner whose
  // pattern list was emptied by a "dead code cleanup" mutation must fail
  // here, not at the worst possible moment.
  const p13 = scanContent('const token = "ghp_' + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0" + '";').length > 0;
  results.push({ name: "P13 secret-scan catches ghp_ literal", expected: "flag", actual: p13 ? "flag" : "MISSED", pass: p13 });

  // P14 (audit 3): ast-diff-gate must FLAG a dropped class method — the
  // exact check the regex structural validator cannot do (it tracks only
  // top-level export names, so Foo.bar disappearing is invisible). The
  // gate is score-based (a single drop is "medium" and may still pass on
  // score — by design for the remote path); the MUTATION paths hard-fail
  // on any AST_SYMBOL_DROPPED violation (verify-refactor.ts Gate 1b,
  // chat-task.ts). So the probe asserts the VIOLATION is produced, which
  // is the load-bearing half of the contract.
  const p14 = evaluateAstDiff(
    "export class Canary { alpha() { return 1; } beta() { return 2; } }",
    "export class Canary { alpha() { return 1; } }",
    "src/components/ui/canary.tsx"
  ).violations.some((v) => v.code === "AST_SYMBOL_DROPPED" && v.message.includes("beta"));
  results.push({ name: "P14 ast-diff-gate flags dropped class method", expected: "flag", actual: p14 ? "flag" : "MISSED", pass: p14 });

  // P15 (audit 3): the gate subtrees are protected — the gates themselves
  // (mutation-guard, secret-scan, ast-diff-gate, sanitizer, duress, the
  // postmortem memory, the red-team runner) must never be in the loop's
  // mutation scope. A gate that can be rewritten by the thing it gates is
  // not a gate.
  const p15 =
    isProtectedPath("src/lib/pipeline/core/mutation-guard.ts") &&
    isProtectedPath("src/lib/pipeline/core/secret-scan.ts") &&
    isProtectedPath("src/lib/pipeline/core/ast-diff-gate.ts") &&
    isProtectedPath("src/lib/pipeline/emg/sanitizer.ts") &&
    isProtectedPath("src/lib/pipeline/postmortem/postmortem-store.ts") &&
    isProtectedPath("src/lib/pipeline/red-team/red-team-runner.ts");
  results.push({ name: "P15 gate subtrees (core/emg/postmortem/red-team) protected", expected: "block", actual: p15 ? "block" : "OPEN", pass: p15 });

  const failed = results.filter((x) => !x.pass);
  const round: ProbeRound = {
    total: results.length,
    passed: results.length - failed.length,
    failed,
    halted: false,
  };

  if (failed.length > 0) {
    // A gate has stopped doing its job. Halt the loop (runtime + durable)
    // until the operator verifies and clears. The message must carry the
    // probe names so the operator knows what to inspect.
    const detail = failed.map((f) => `${f.name}: expected ${f.expected}, got ${f.actual}`).join(" | ");
    raiseSafeModeFlag(
      "gate-integrity-probe",
      `Gate integrity probe FAILED ${failed.length}/${results.length}: ${detail.slice(0, 500)} — loop halted until the operator clears safe-mode after verifying.`
    )
      .then(() => {
        round.halted = true;
      })
      .catch(() => {
        /* runtime flag set inside; DB row best-effort */
        round.halted = true;
      });
    round.halted = true; // optimistic set — the runtime cache is synchronous inside raiseSafeModeFlag
  }
  return round;
}
