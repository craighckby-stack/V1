/**
 * Gate runner — the SINGLE OWNER of the refactor-verification gate chain.
 *
 * (Replace ② unification.) Before this module existed, the deterministic
 * gate chain lived in TWO orchestration layers that had already drifted
 * once (audit 3: the evil-token and AST gates ran only on the remote path
 * while the self-mutation path — the one that mutates THIS repo — had
 * neither):
 *
 *   - Path A (self-mutation): autonomous/verify-refactor.ts — a child
 *     process running guard → structural → AST(strict) → syntax →
 *     typecheck, fail-fast, stdout JSON contract {ok, errors}.
 *   - Path B (remote repo): core/unified-pipeline.ts stages 3-4 —
 *     AST(score) at stage 3, guard at stage 4, then the LLM debate
 *     tribunal, non-fail-fast, per-stage reporting.
 *
 * Both paths called the same primitives (gateMutation, evaluateAstDiff,
 * validateStructure, syntaxCheck, typecheckRefactor) but each carried its
 * own invocation details: guard-path normalization, error-string
 * formatting, hard-fail filtering, ordering. This module owns ALL of that.
 * A caller states a POLICY (which gates, which tolerance) and gets back a
 * uniform result. The interleaved ORCHESTRATION (0-diff short-circuit, the
 * debate tribunal, stage reporting) stays in the callers — those are
 * pipeline economics, not gates.
 *
 * Canonical order (cheap → expensive; the guard always runs first so no
 * expensive gate time is ever spent on an obviously-evil proposal):
 *   1. mutation-guard   ~0ms, fail-closed (triage evil → reject; unsure/
 *                       good → finalAuthority: protected paths + non-empty).
 *   2. structural       regex-based, ~0ms. Catches destructive-but-
 *                       compiling refactors (truncation, import stripping,
 *                       export drops, test deletion, license stripping).
 *   3. ast-diff         TS-parser symbol retention (evaluateAstDiff).
 *                       Tolerance is POLICY:
 *                         "strict" — the result must pass the score AND
 *                           contain zero AST_SYMBOL_DROPPED /
 *                           BRANDING_INJECTION violations. This is the
 *                           self-mutation contract (the enhance prompt
 *                           promises "preserve EVERY top-level exported
 *                           symbol"); any symbol drop rejects regardless
 *                           of score.
 *                         "score"  — evaluateAstDiff's own threshold. The
 *                           remote path tolerates some drift because the
 *                           debate tribunal still reviews the code, and a
 *                           score-failed run can never reach COMPLETED.
 *   4. syntax           fast AST parse (ScriptKind follows the extension).
 *   5. typecheck        full in-memory tsc (~10s). Always last.
 *
 * Named policies (the per-path contract, in one place):
 *   - SELF_PATH_POLICY   used by autonomous/verify-refactor.ts. Every gate
 *     on, strict AST tolerance, stop-on-first-failure (a child process
 *     must not burn 10s of tsc on a proposal the 0ms guard rejected).
 *   - REMOTE_PATH_POLICY used by unified-pipeline.ts. Guard + score-AST
 *     only; the debate tribunal is the caller-side post-step. The
 *     pipeline invokes the chain in two stage-local slices (stage 3:
 *     ast-only, stage 4: guard-only) because the 0-diff short-circuit
 *     must sit between them — the policy constants remain the single
 *     source of truth for both slices.
 *
 * Error-string contract: byte-identical to the historical verify-refactor
 * stdout, which the loop stores verbatim in postmortem evidence:
 *   guard       → "[mutation-guard/<layer>] <reasons joined ' | '>"
 *   structural  → "[<CODE>] <message>"
 *   ast-diff    → "[<CODE>] <message>"
 *   syntax      → raw error string (historical: no bracket prefix)
 *   typecheck   → raw error strings from typecheckRefactor (historical)
 *
 * Integrity: this file lives under src/lib/pipeline/core/, covered by the
 * PROTECTED_PREFIXES entry "src/lib/pipeline/core/" in
 * autonomous/protected-files.ts — the self-improvement loop can never
 * weaken the orchestrator of its own gates.
 */

import { gateMutation, MutationGateResult } from "./mutation-guard";
import { evaluateAstDiff, AstDiffResult, AstDiffViolation } from "./ast-diff-gate";
import { validateStructure, StructureResult } from "../autonomous/structural-validator";
import { syntaxCheck, typecheckRefactor } from "../autonomous/in-memory-typecheck";
import { PROJECT_ROOT } from "./paths";

export type GateName =
  | "mutation-guard"
  | "structural"
  | "ast-diff"
  | "syntax"
  | "typecheck";

/**
 * The per-path gate policy. EVERY field is required — an omitted flag must
 * be a compile error, never a silent default. (A default-on default would
 * run the expensive/never-intended gates on paths that can't support them;
 * a default-off default would let a caller silently DROP a gate.)
 */
export interface GatePolicy {
  /** mutation-guard (triage + finalAuthority). Fail-closed, ~0ms. */
  guard: boolean;
  /** Regex structural-preservation gate (truncation / import stripping /
   *  export drops / test deletion / license stripping). */
  structural: boolean;
  /** TS-parser symbol-retention gate (evaluateAstDiff). */
  ast: boolean;
  /** How strictly the AST gate judges the diff — see the module doc. */
  astTolerance: "score" | "strict";
  /** Fast AST syntax parse. */
  syntax: boolean;
  /** Full in-memory tsc typecheck (~10s). */
  typecheck: boolean;
  /** Halt at the first failing gate instead of running every enabled gate.
   *  Path A runs as a child process (verify-refactor.ts) — burning 10s of
   *  tsc after the 0ms guard rejected would be waste; Path B wants every
   *  gate's outcome recorded for stage reporting. */
  stopOnFirstFailure: boolean;
}

/** Self-mutation path (verify-refactor.ts): maximum strictness, fail fast. */
export const SELF_PATH_POLICY: GatePolicy = {
  guard: true,
  structural: true,
  ast: true,
  astTolerance: "strict",
  syntax: true,
  typecheck: true,
  stopOnFirstFailure: true,
};

/** Remote-repo path (unified-pipeline.ts): guard + score-AST; the debate
 *  tribunal is the caller-side post-step. */
export const REMOTE_PATH_POLICY: GatePolicy = {
  guard: true,
  structural: false,
  ast: true,
  astTolerance: "score",
  syntax: false,
  typecheck: false,
  stopOnFirstFailure: false,
};

export interface GateStepOutcome {
  gate: GateName;
  status: "passed" | "failed";
  durationMs: number;
}

export interface GateChainResult {
  /** True iff every ENABLED gate passed. (Disabled gates don't vote.) */
  ok: boolean;
  /** Formatted error strings — byte-compatible with the historical
   *  verify-refactor.ts stdout contract ({ok, errors}); see module doc. */
  errors: string[];
  /** First failing gate, or null when everything passed. */
  failedGate: GateName | null;
  /** Per-gate payloads. null = the gate was not enabled under the policy. */
  guard: MutationGateResult | null;
  structural: StructureResult | null;
  ast: AstDiffResult | null;
  syntax: { ok: boolean; error?: string } | null;
  typecheck: { ok: boolean; errors: string[] } | null;
  /** Under astTolerance:"strict": the AST_SYMBOL_DROPPED /
   *  BRANDING_INJECTION violations that hard-failed the chain. The
   *  historical verifier reported ONLY these (not the full violation
   *  list) when present — kept identical. Empty under "score". */
  astHardFailViolations: AstDiffViolation[];
  /** Per-gate outcomes with durations, in canonical execution order. */
  steps: GateStepOutcome[];
}

export interface GateChainInput {
  /** Target file path. Passed AS-IS to the structural / ast / syntax /
   *  typecheck gates (the verifier's historical behavior — the typecheck
   *  resolves it against the real project). The MUTATION GUARD receives a
   *  normalized repo-relative form: an absolute path under PROJECT_ROOT is
   *  stripped of that prefix, otherwise leading slashes are stripped.
   *  Normalizing HERE (not in each caller) closes the audit-3 class of
   *  bug where a sloppy absolute path silently bypasses the guard's
   *  protected-path check. */
  filePath: string;
  /** Baseline for the guard + structural gates. Path A passes the
   *  ORIGINAL from disk (the caller must fail-closed if it cannot be
   *  read — a refactor with no original to diff against is meaningless).
   *  Path B passes the raw request code. */
  originalCode: string;
  /** Baseline for the AST gate. Defaults to originalCode. Path B passes
   *  the SANITIZED base — the refactor stage's actual input — so sanitizer
   *  redaction deltas ([REDACTED_*] injections) are not attributed to the
   *  LLM refactor. */
  astBaselineCode?: string;
  /** The proposed code under verification. */
  evolvedCode: string;
  /** The caller's gate policy. All fields required — see GatePolicy. */
  policy: GatePolicy;
}

/**
 * Run the deterministic gate chain in canonical order under the given
 * policy. All gates are synchronous; the function is async because the
 * chain is consumed from async orchestration on both paths.
 */
export async function runGateChain(input: GateChainInput): Promise<GateChainResult> {
  const { filePath, originalCode, evolvedCode, policy } = input;
  const astBaseline = input.astBaselineCode ?? originalCode;

  const errors: string[] = [];
  const steps: GateStepOutcome[] = [];
  const result: GateChainResult = {
    ok: true,
    errors,
    failedGate: null,
    guard: null,
    structural: null,
    ast: null,
    syntax: null,
    typecheck: null,
    astHardFailViolations: [],
    steps,
  };

  const fail = (gate: GateName, msgs: string[]) => {
    result.ok = false;
    if (!result.failedGate) result.failedGate = gate;
    errors.push(...msgs);
  };

  // 1. MUTATION GUARD — newly-introduced evil tokens (eval(, child_process,
  //    non-allowlisted fetch, path traversal), protected-path mutation,
  //    empty content. Fail-closed, ~0ms, always first.
  if (policy.guard) {
    const t = performance.now();
    // Normalize for the guard: absolute project paths → repo-relative,
    // already-relative inputs keep their relative form (leading slashes
    // stripped). Identical to the historical verifier's relForGuard.
    const relForGuard = filePath.startsWith(`${PROJECT_ROOT}/`)
      ? filePath.slice(PROJECT_ROOT.length + 1)
      : filePath.replace(/^\/+/, "");
    const guard = gateMutation({
      filePath: relForGuard,
      originalCode,
      evolvedCode,
    });
    result.guard = guard;
    steps.push({
      gate: "mutation-guard",
      status: guard.allowed ? "passed" : "failed",
      durationMs: Math.round(performance.now() - t),
    });
    if (!guard.allowed) {
      fail("mutation-guard", [
        `[mutation-guard/${guard.rejectedBy}] ${guard.reasons.join(" | ")}`,
      ]);
      if (policy.stopOnFirstFailure) return result;
    }
  }

  // 2. STRUCTURAL — destructive truncation, import stripping, export drop,
  //    test deletion, license stripping. The REAL signal beyond typecheck:
  //    catches the LLM doing things that compile but are destructive.
  if (policy.structural) {
    const t = performance.now();
    const structure = validateStructure(filePath, originalCode, evolvedCode);
    result.structural = structure;
    steps.push({
      gate: "structural",
      status: structure.ok ? "passed" : "failed",
      durationMs: Math.round(performance.now() - t),
    });
    if (!structure.ok) {
      fail("structural", structure.issues.map((i) => `[${i.code}] ${i.message}`));
      if (policy.stopOnFirstFailure) return result;
    }
  }

  // 3. AST DIFF (TS parser) — the stronger symbol-retention check. The
  //    regex structural gate can't see dropped class methods (Foo.bar) or
  //    export-alias renames; the parser can. Tolerance is policy.
  if (policy.ast) {
    const t = performance.now();
    const ast = evaluateAstDiff(astBaseline, evolvedCode, filePath);
    result.ast = ast;
    steps.push({
      gate: "ast-diff",
      status: ast.passed ? "passed" : "failed",
      durationMs: Math.round(performance.now() - t),
    });
    if (policy.astTolerance === "strict") {
      // HARD-FAIL CONTRACT: evaluateAstDiff is score-based (a single
      // dropped method is "medium" severity and can still pass on score —
      // right for the remote path). The self-mutation contract is
      // stricter: ANY symbol-drop or branding violation rejects here,
      // regardless of score — AND the score gate must pass too. When both
      // kinds exist, report only the hard-fail violations (historical
      // verifier output).
      const hardFail = ast.violations.filter(
        (v) => v.code === "AST_SYMBOL_DROPPED" || v.code === "BRANDING_INJECTION"
      );
      result.astHardFailViolations = hardFail;
      if (hardFail.length > 0 || !ast.passed) {
        fail(
          "ast-diff",
          (hardFail.length > 0 ? hardFail : ast.violations).map(
            (v) => `[${v.code}] ${v.message}`
          )
        );
        if (policy.stopOnFirstFailure) return result;
      }
    } else if (!ast.passed) {
      // Score tolerance: the gate "fails" (ok:false, violations reported)
      // but blocking is the CALLER's decision — the remote pipeline
      // records the failure for stage reporting, still convenes the
      // tribunal, and its final-status computation refuses to mark an
      // AST-failed run COMPLETED.
      fail("ast-diff", ast.violations.map((v) => `[${v.code}] ${v.message}`));
      if (policy.stopOnFirstFailure) return result;
    }
  }

  // 4. SYNTAX — fast AST parse. Catches broken template literals etc.
  if (policy.syntax) {
    const t = performance.now();
    const syntax = syntaxCheck(evolvedCode, filePath);
    result.syntax = syntax;
    steps.push({
      gate: "syntax",
      status: syntax.ok ? "passed" : "failed",
      durationMs: Math.round(performance.now() - t),
    });
    if (!syntax.ok) {
      fail("syntax", [syntax.error ?? "Syntax error"]);
      if (policy.stopOnFirstFailure) return result;
    }
  }

  // 5. TYPECHECK — full in-memory tsc (same as `tsc --noEmit`). Expensive
  //    (~10s). Only meaningful after structure + syntax pass, hence last.
  if (policy.typecheck) {
    const t = performance.now();
    const typecheck = typecheckRefactor(filePath, evolvedCode);
    result.typecheck = typecheck;
    steps.push({
      gate: "typecheck",
      status: typecheck.ok ? "passed" : "failed",
      durationMs: Math.round(performance.now() - t),
    });
    if (!typecheck.ok) {
      fail("typecheck", typecheck.errors);
      if (policy.stopOnFirstFailure) return result;
    }
  }

  return result;
}
