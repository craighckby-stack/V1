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
import { isProtectedPath, PROTECTED_FILES } from "../autonomous/protected-files";
import { classifyGrowth } from "../autonomous/saturation";
import { raiseSafeModeFlag } from "../core/duress";

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
  const p8 = !isProtectedPath("src/components/ui/button.tsx") && !isProtectedPath("src/lib/pipeline/halt.ts");
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
  // its own auditors is drift.
  const p10 =
    PROTECTED_FILES.has("src/lib/pipeline/red-team/gate-integrity-probe.ts") &&
    PROTECTED_FILES.has("src/lib/pipeline/red-team/test-attacker.ts");
  results.push({ name: "P10 protected-files contains its own auditors", expected: "protected", actual: p10 ? "protected" : "MISSING", pass: p10 });

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
