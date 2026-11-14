// audit-6: visual-polish mode + API unprotection
/**
 * Self-Enhance Loop — the system enhances its OWN source code.
 *
 * Instead of fetching a remote repo, mutating, and pushing back, this loop:
 *   1. Scans its own pipeline source (src/lib/pipeline/) for .ts files
 *   2. For each file: reads it, LLM-refactors it, verifies with tsc --noEmit
 *   3. If it compiles: writes the refactored code LIVE (hot-reload picks it up)
 *   4. If it doesn't compile: reverts and records a postmortem
 *   5. After each successful enhancement: git add + commit + push (the proof)
 *
 * The GitHub push contains the CURRENT live state of the running system.
 * When you see a commit on GitHub, that's exactly what the server is running.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from "fs";
import { execSync } from "child_process";
import { join, relative, resolve, basename, dirname } from "path";
import { createHash } from "crypto";
import { llmComplete, extractSummaryAndCode, llmCooldownMs } from "../llm/agent-llm";
import { conductLlmDebate } from "../llm/debate-llm";
import { postmortemStore } from "../postmortem/postmortem-store";
import { queryRelevantPostmortems, formatAncestralPromptBlock } from "../postmortem/ancestral-rag";
import { pushCurrentState, getLastBranchNumber, setLastBranchNumber, formatLoopBranch, validateCommitMessage, amendUuidHeadCommit, pruneOldLoopBranches } from "./push-target";
import { db } from "@/lib/db";
import { generateTasks, claimNextTask } from "./self-task-generator";
import { executeTask, type TaskExecutionResult } from "./task-executor";
import { detectTruncation, stripComments, stripLiteralsAndComments } from "./code-analysis";
import { autoProphecyAfterCycle, recordSelfProphecy, adjudicateSelfProphecies } from "../oracle/oracle-auto";
import {
  TARGET_FILES,
  SCAN_SCOPES,
  SCHEMA_TARGET,
  SATURATION_THRESHOLD,
  getSaturationThreshold,
  type FileSaturation,
  type SaturationMap,
  classifyGrowth,
} from "./saturation";
import { isProtectedPath } from "./protected-files";
// Durable banner-stats tier (.git/info/loop-stats.json, armed-state
// pattern): the in-memory stats reset on every worker boot while the
// self-model panel read the DB — two windows, one lying banner comment.
import { readLoopStats, writeLoopStats } from "./loop-stats";
// D1 (architecture context): builds a 2-hop "neighborhood map" of the
// file being enhanced (its imports + their exports + 2-hop imports) and
// injects it into the refactor prompt so the LLM refactors with
// architecture-level vision instead of in isolation. Fail-soft: if the
// builder throws or returns empty, the prompt proceeds without it.
import { buildArchContext } from "./arch-context";
import {
  bootstrapSelfModel,
  orderTargetsByBandit,
  openSelfPrediction,
  resolveSelfPrediction,
  noteOutcome,
  classifyOutcome,
  shouldProactivelySkip,
  predictConfidence,
} from "./self-model";
import {
  getLessonsForPrompt,
  getPromotedProcedures,
  formatLessonsBlock,
  formatOperatingConstraintsBlock,
  markInjected,
  recordLessonOutcome,
  maybeDistill,
  seedLessons,
  DISTILL_INTERVAL,
  type LessonRow,
} from "./lesson-store";
import { applySchemaMutation } from "./schema-gate";
import { PROJECT_ROOT } from "../core/paths";
import { recoverCrashedTestGate } from "../core/test-gate-journal";
import { runTestsInSandbox, typecheckInSandbox } from "../core/sandbox-test";
import { runChildAsync } from "../core/async-spawn";
// Audit 4 (P1/P2a/P3): shared, best-effort retention helpers for the
// loop's grow-only DB tables. Fire-and-forget at the cycle end; a prune
// failure never fails the cycle (the row was already written; pruning
// is housekeeping). See retention.ts for the per-helper contracts.
import {
  pruneResolvedPostmortems,
  pruneHighAttemptPostmortems,
  pruneTerminalSelfTasks,
  pruneOldLessons,
} from "./retention";
// ── Compounding-intelligence v2 (D1-D8). The integrity-chain modules
// (lapse-detector, meta-params, meta-tuner, mutation-corpus,
// lessons-markdown, red-team/*) are PROTECTED — see protected-files.ts.
// dreamer + reflection stay advisory/mutable: their outputs pass
// through the existing gates.
import { recordLessonLapse } from "./lapse-detector";
import { maybeReflectAfterFailure } from "./reflection";
import {
  classifyGateOutcome,
  recordMutationAttempt,
  firstMeaningfulLine,
  getRejectedTransformsForFile,
  formatRejectedTransformsBlock,
} from "./mutation-corpus";
import { maybeDream, getRatchetDraft } from "./dreamer";
import { noteAttemptOutcome, maybeMetaTune } from "./meta-tuner";
import { seedMetaParams } from "./meta-params";
import { runTestAttacker, ATTACKER_INTERVAL } from "../red-team/test-attacker";
import { runGateIntegrityProbes, PROBE_INTERVAL } from "../red-team/gate-integrity-probe";
// Audit 3 (F1): safe-mode was raised by red-team/probes/duress but NEVER
// checked by this loop — the flag halted only the (disabled) remote-repo
// runtime while the self-mutation path kept writing and pushing through
// the exact condition the flag was raised for. Static import is safe:
// core/duress imports push-target, never this module.
import { isSafeMode } from "../core/duress";
// Operator armed-intent tier for THIS loop (.git/info/loop-self-enhance-
// armed.json). Pure leaf (fs + path), no circulars — safe to load from
// the constructor. See self-enhance-armed-state.ts for why the boot
// auto-start reads from disk: the in-memory `continuous` flag resets on
// every process recycle, so an operator who armed the loop would find it
// dead after a dev-server reload without this persistence tier.
import {
  readSelfEnhanceArmedState,
  markSelfEnhanceArmed,
  type SelfEnhanceArmedState,
} from "./self-enhance-armed-state";
// Audit 3 (F10): serialize live-tree writes against chat-task's
// applyTaskPlan — two independent writers previously raced (its rollback
// could silently revert a gated, already-pushed enhancement).
import { withTreeLock } from "../core/tree-lock";

const PIPELINE_SRC_DIR = join(PROJECT_ROOT, "src/lib/pipeline");
const DISPLAY_SRC_DIR = join(PROJECT_ROOT, "src/app/display");

/** D4 (corpus): 16-hex sha of a source string — compact provenance for
 *  "what did the file look like when this was attempted". */
function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/**
 * Find test files that cover the given source file.
 *
 * Coverage detection (external audit, finding 4). The old version only
 * scanned the source file's OWN directory and matched the literal string
 * `from "./base"` — so a test importing via `../dir/base`, a subdirectory
 * (`./sub/base`), or the `@/` alias was invisible to the test gate, which
 * then reported "no tests for this file" and passed the mutation with
 * zero behavioral coverage.
 *
 * Now: walk the whole src/ tree for *.test.ts(x) files and resolve their
 * ACTUAL import specifiers against the test file's location:
 *   - relative (`./x`, `../x`) → resolved against the test file's dir
 *   - alias (`@/x`)           → resolved against <root>/src/x (tsconfig paths)
 *   - `.js`/`.mjs` specifiers → also tried as `.ts`/`.tsx` (ESM convention
 *     of importing the emitted extension)
 * A test file counts as covering the source iff any resolved specifier
 * equals the source's absolute path. Synchronous and cheap — the walk is
 * a few hundred stat calls and test files are rare.
 *
 * This is the test-gate infrastructure for Direction 4 (tests as the gate).
 */
function findTestFilesFor(sourceFilePath: string): string[] {
  const dir = dirname(sourceFilePath);
  const ext = sourceFilePath.endsWith(".tsx") ? ".tsx" : ".ts";
  const base = basename(sourceFilePath, ext);
  const testFiles: string[] = [];

  // 1. Co-located test file: foo.ts -> foo.test.ts, foo.tsx -> foo.test.tsx
  //    (fast path — the ratchet writes these, so this is the common case)
  const coLocated = join(dir, `${base}.test${ext}`);
  if (existsSync(coLocated)) testFiles.push(coLocated);

  // 2. Whole-tree scan: any *.test.ts(x) under src/ whose imports resolve
  //    to this source file.
  const srcRoot = join(PROJECT_ROOT, "src");
  const candidates: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) candidates.push(full);
    }
  };
  walk(srcRoot);

  for (const testPath of candidates) {
    if (testPath === coLocated) continue; // already added
    let testContent: string;
    try {
      testContent = readFileSync(testPath, "utf-8");
    } catch {
      continue; // unreadable — skip
    }
    if (testImportsSource(testContent, testPath, sourceFilePath)) {
      testFiles.push(testPath);
    }
  }

  return testFiles;
}

/** Does this test file's import graph reference the source file? Resolves
 *  static `from "..."` specifiers and dynamic `import("...")` calls. */
function testImportsSource(testContent: string, testPath: string, sourceFilePath: string): boolean {
  const specs = new Set<string>();
  const fromRe = /\bfrom\s+["']([^"']+)["']/g;
  const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(testContent)) !== null) specs.add(m[1]);
  while ((m = dynRe.exec(testContent)) !== null) specs.add(m[1]);

  for (const spec of specs) {
    // Resolve this specifier to the set of absolute paths it could mean.
    const targets: string[] = [];
    if (spec.startsWith(".")) {
      targets.push(resolve(dirname(testPath), spec));
    } else if (spec.startsWith("@/")) {
      // tsconfig paths: "@/*" -> "./src/*"
      targets.push(join(PROJECT_ROOT, "src", spec.slice(2)));
    } else {
      continue; // bare package specifier — never a project source file
    }
    // ESM convention: specifiers may name the EMITTED extension (.js) while
    // the source is .ts/.tsx. Try the literal resolution first, then the
    // extension-swapped variants.
    const variants = [...targets];
    for (const t of targets) {
      if (t.endsWith(".js")) {
        variants.push(t.slice(0, -3) + ".ts", t.slice(0, -3) + ".tsx");
      } else if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(t)) {
        // Extensionless specifier (bundler-style): try both TS extensions.
        variants.push(t + ".ts", t + ".tsx");
      }
    }
    if (variants.some((v) => v === sourceFilePath)) return true;
  }
  return false;
}

/**
 * System prompt for the test-writer (the ratchet).
 *
 * Characterization tests PIN the module's current observable behavior. Once
 * written, the test gate runs them on every future refactor of the module —
 * a refactor that changes pinned behavior is rejected. Each pass either adds
 * pins (tightening the contract) or refactors within them. That is the
 * ratchet: behavior gets increasingly locked while implementation gets
 * increasingly clean.
 */

/**
 * Extract the actual exported symbols from a TypeScript source string.
 * Used by the ratchet to inject the REAL export list into the test-writer
 * prompt, killing the #1 failure mode: the LLM hallucinating export names
 * that don't exist in the module (e.g. inventing `extractTopLevelExports`
 * when the file has `extractTopLevelFunctions`, or `SECURITY_THRESHOLD` when
 * the file has `SECURITY_LIMIT`). With the real list in the prompt, the LLM
 * is told "import ONLY these names" and the SyntaxError-on-import failures
 * stop.
 *
 * Regex-based (not a full AST) — fast, no dependency, good enough for a
 * prompt HINT. Strips comments + string/template literals first so the
 * regexes don't match inside them. Misses destructuring exports
 * (`export const { a, b } = obj`) and wildcard re-exports (`export * from`)
 * — both are rare in this codebase and the LLM seeing 90% of the real list
 * is enough to stop the hallucination pattern.
 *
 * Returns the export names + a "kind" label per name (function, class,
 * const, interface, type, enum, value, default). Kinds matter because:
 *   - interface/type exports are TYPE-ONLY — the prompt tells the LLM to
 *     `import type` them, never as runtime values (avoids "imported as a
 *     value but is a type" typecheck errors).
 *   - default exports need `import X from './base'` (no braces).
 */
export function extractExports(source: string): { names: string[]; kinds: Record<string, string> } {
  const names: string[] = [];
  const kinds: Record<string, string> = {};
  const seen = new Set<string>();
  const add = (name: string, kind: string) => {
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
      kinds[name] = kind;
    }
  };

  // Mask comments, string/template literals AND regex literals with the real
  // TypeScript scanner (code-analysis.ts). The previous order-sensitive regex
  // chain stripped comments BEFORE strings, so the `//` in a URL string
  // literal ate the rest of its line and the string regex then paired quotes
  // across lines — swallowing real export declarations (audit 2: for
  // sanitizer.ts, `sanitizeAndGovern` went missing from this list, which the
  // test-writer prompt calls "EXACTLY these symbols").
  const stripped = stripLiteralsAndComments(source);

  let m: RegExpExecArray | null;
  // export [async] function foo
  const funcRe = /export\s+(?:async\s+)?function\s*(?:\*)?\s+(\w+)/g;
  while ((m = funcRe.exec(stripped))) add(m[1], "function");
  // export class Foo
  const classRe = /export\s+class\s+(\w+)/g;
  while ((m = classRe.exec(stripped))) add(m[1], "class");
  // export const foo / export let foo
  const constRe = /export\s+(?:const|let)\s+(\w+)/g;
  while ((m = constRe.exec(stripped))) add(m[1], "const");
  // export interface Foo
  const ifaceRe = /export\s+interface\s+(\w+)/g;
  while ((m = ifaceRe.exec(stripped))) add(m[1], "interface");
  // export type Foo
  const typeRe = /export\s+type\s+(\w+)/g;
  while ((m = typeRe.exec(stripped))) add(m[1], "type");
  // export enum Foo
  const enumRe = /export\s+enum\s+(\w+)/g;
  while ((m = enumRe.exec(stripped))) add(m[1], "enum");
  // export { foo, bar as baz, qux } — re-exports. Use the ALIAS (baz), not the
  // local name (bar), since that's what the importing test will use.
  const reexportRe = /export\s*\{([^}]+)\}/g;
  while ((m = reexportRe.exec(stripped))) {
    const list = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const item of list) {
      const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
      const name = asMatch ? asMatch[2] : item.split(/\s+as\s+/)[0].trim();
      if (/^\w+$/.test(name)) add(name, "value");
    }
  }
  // export default — note it separately; tests import it without braces.
  if (/export\s+default\b/.test(stripped)) add("__default", "default");

  return { names, kinds };
}

/** Format the export list for injection into the ratchet prompt. Returns a
 *  human-readable bulleted list like:
 *    - foo (function)
 *    - Bar (class)
 *    - baz (const)
 *    - Qux (interface — import type)
 *    - default (import without braces)
 *  Returns "" if the module has no exports (the prompt then says "no
 *  exports — write only smoke tests that import the module doesn't crash"). */
function formatExportList(exps: { names: string[]; kinds: Record<string, string> }): string {
  if (exps.names.length === 0) return "(none — this module has no named exports)";
  return exps.names
    .map((n) => {
      const k = exps.kinds[n];
      if (k === "default") return `- default (import WITHOUT braces: \`import X from "./base"\`)`;
      if (k === "interface" || k === "type")
        return `- ${n} (${k} — TYPE-ONLY: use \`import type { ${n} }\`)`;
      return `- ${n} (${k})`;
    })
    .join("\n");
}

const TEST_WRITER_SYSTEM = `You are a test engineer writing characterization tests for a TypeScript module inside an autonomous self-improvement pipeline. The tests you write become a PERMANENT behavioral contract: future refactors of this module will be REJECTED if they break your tests.

Your job: write bun:test tests that PIN the module's CURRENT observable behavior.

Rules:
- Import { describe, test, expect } from "bun:test"
- Import the module under test using a relative path (e.g. from "./moduleName")
- The user prompt will give you the EXACT list of exports this module provides. Import ONLY those names — do NOT invent exports. If the prompt says the module exports \`foo\` and \`Bar\`, you may import \`foo\` and \`Bar\` and NOTHING ELSE from this module. Inventing export names like \`extractTopLevelExports\` when the real export is \`extractTopLevelFunctions\` causes a SyntaxError at import time and rejects your test.
- For interface and type exports, use \`import type { X }\` — they are TYPE-ONLY and cannot be imported as runtime values.
- For default exports, use \`import X from "./base"\` (no braces).
- Test the EXPORTED functions/classes with realistic inputs, including edge cases (empty strings, boundary numbers, null/undefined only where the signature allows them)
- Assert CONCRETE expected values derived from reading the implementation — compute the expected output yourself from the logic, do not call the function to obtain it
- EVERY test() callback MUST contain at least one expect() call. A test with no assertions is rejected. Do not write skeleton tests like \`test('does X', () => {})\` — always assert.
- NO tautological tests: never expect(f(x)).toBe(f(x)), never expect(x).toBe(x), never assertions that always pass
- Do NOT re-implement the module's logic inside the test to compute the expected value
- If an export's behavior depends on external state (DB, network, filesystem, env), test only the pure logic; skip integration-heavy paths
- Write 3-8 focused tests inside one describe block
- Do not test implementation details that refactoring may legitimately change; test observable outputs

Worked example (the pattern to follow):
Given a source file \`./add.ts\`:
\`\`\`typescript
export function add(a: number, b: number): number { return a + b; }
export const ZERO = 0;
export interface AddResult { sum: number; }
\`\`\`
The prompt would tell you: "exports: - add (function), - ZERO (const), - AddResult (interface — TYPE-ONLY)".
A CORRECT test:
\`\`\`typescript
import { describe, test, expect } from "bun:test";
import { add, ZERO, type AddResult } from "./add";

describe("add", () => {
  test("returns the sum of two positive numbers", () => {
    expect(add(2, 3)).toBe(5);  // computed from the implementation: 2+3=5
  });
  test("returns ZERO when both inputs are 0", () => {
    expect(add(ZERO, ZERO)).toBe(0);
  });
});
\`\`\`
A WRONG test (do NOT do this):
\`\`\`typescript
import { add, extractSum } from "./add";  // WRONG: extractSum does not exist
describe("add", () => {
  test("adds numbers", () => {});  // WRONG: no expect()
  test("adds", () => { expect(add(2, 3)).toBe(7); });  // WRONG: 2+3 is 5, not 7
});
\`\`\`

OUTPUT FORMAT (mandatory):
- First, a SHORT summary starting with "## Changes" listing which behaviors you pinned.
- Then the complete test file in a single fenced \`\`\`typescript block.`;

// Files the system should NOT modify (would break the loop itself).
// Imported from protected-files.ts — the SINGLE shared set (audit 2: the
// loop's set and the task-generator's set had drifted apart). Re-exported
// so the /api/self-enhance/files route keeps reporting the real set.
export { PROTECTED_FILES } from "./protected-files";
import { PROTECTED_FILES } from "./protected-files";

export interface SelfEnhanceResult {
  filePath: string;
  enhanced: boolean;
  reason: string;
  oldBytes: number;
  newBytes: number;
  diffBytes: number;
  llmUsed: boolean;
  llmLatencyMs: number;
  compiled: boolean;
  pushed: boolean;
  commitSha?: string;
  /** How many test files the test gate actually EXECUTED for this mutation.
   *  0 means the mutation went live verified by static gates + debate only —
   *  recorded here (and in the commit message) so no audit trail can mistake
   *  "passed the gates" for "behavior was tested" (external audit, finding 2).
   *  Absent on paths that never reached the test gate (LLM failure, debate
   *  rejection, etc.). */
  testFilesRun?: number;
}

// ── Audit 4 retention throttle counters ──────────────────────────────
// Module-level (process-wide) counters for the fire-and-forget prunes
// wired into the cycle end. P1 + P2a use the cycle-number modulo (a
// state-free throttle matching mutation-corpus.ts:130); P3 (lessons)
// uses a distill-attempt counter because the prune cadence is "every
// 10th distill", and a distill fires every DISTILL_INTERVAL cycles — so
// every 10th distill ≈ every 100 cycles, but the counter makes the
// cadence robust to a meta-tuned DISTILL_INTERVAL (D8).
//
// The counter is incremented ONLY when a distill actually runs (when
// cycleNow > 0 && cycleNow % DISTILL_INTERVAL === 0), so a stop-then-
// restart that re-enters the distill cycle doesn't double-count. It
// resets to 0 on process restart (acceptable — the lesson prune is
// housekeeping; missing one prune on restart just delays the next one
// by 10 distills).
let distillAttemptCount = 0;

class SelfEnhanceLoop {
  private running = false;
  private continuous = false;
  private currentFile: string | null = null;
  // Per-enhancement branch: when set, ALL gitPush calls in this enhanceFile
  // (test pin + enhancement) push to this branch instead of the configured
  // seed branch. Computed at enhanceFile start from lastBranchNumber + 1.
  // Cleared at enhanceFile end (success or fail). The counter is bumped in
  // the DB only after the enhancement push succeeds — failed attempts don't
  // consume a branch number.
  private currentCycleBranch: string | null = null;
  // Fix B: count consecutive cycles where every file was deferred due to the
  // shared LLM rate-limit gate. After 3 such cycles, log a loud "LLM quota
  // exhausted" message so the user knows the loop is alive but blocked (not
  // hung, not crashed — just waiting for the gate to open). The loop does NOT
  // auto-stop: when the gate clears, it resumes automatically. Reset on any
  // file that actually attempts an LLM call (success or non-cooldown failure).
  private consecutiveCooldownCycles = 0;
  private quotaExhaustedLogged = false;
  // Run-token (generation counter). Incremented by stop(). Each runCycle /
  // enhanceFile captures the value at start; if it changes mid-run (because
  // the user stopped and possibly started again), the in-flight work breaks
  // out of its for-loop / returns early instead of running to completion
  // against a stale `running` flag. This is the fix for the stop-then-start
  // race: previously stop() set running=false, which (a) didn't break the
  // for-loop in runCycle (it kept iterating files for ~6min), and (b) defeated
  // the `if (this.running) return` guard so a new start could spawn a second
  // concurrent cycle sharing currentCycleBranch / currentFile.
  private runId = 0;
  // LESSON FEEDBACK channel: the ids of the lessons injected into the
  // CURRENT enhanceFile's prompt. Set at prompt-build time, consumed by
  // runCycle right after the verdict lands (pass → helped, fail →
  // hindered; fail-matching-lesson → lapse, D1). The loop is strictly
  // serial (one file at a time), so an instance field is a safe
  // hand-off. Cleared at the top of every enhanceFile so a stale list
  // can never feed back twice.
  private lastLessonIds: string[] = [];
  // SELF-MODEL (audit 7): the mode of the CURRENT enhanceFile call, so the
  // post-verdict noteOutcome + resolveSelfPrediction calls feed the
  // calibration curve with the right per-mode stats. Set at the top of
  // enhanceFile; consumed by runCycle after the verdict. Serial loop ⇒
  // instance field is a safe hand-off (same contract as lastLessonIds).
  private lastAttemptMode: "refactor" | "visual-polish" = "refactor";
  // D4 (corpus): per-attempt provenance scratch, same hand-off pattern
  // as lastLessonIds. Set inside enhanceFile/enhanceSchema at the
  // points where the originals/proposals/summaries are in scope;
  // consumed by runCycle's corpus writer after the verdict.
  private lastAttemptInfo: {
    originalSha: string;
    mutatedSha: string | null;
    transformSummary: string | null;
    branchNumber: number | null;
  } = { originalSha: "", mutatedSha: null, transformSummary: null, branchNumber: null };
  // Ratchet: per-file test-writing attempt tracking. After 2 failed attempts
  // (bad tests, untestable module, LLM trouble), stop retrying — but forget
  // failures older than 30 minutes, so an intermittent 429 window doesn't
  // permanently skip a module for the rest of the server's life.
  private testWriteAttempts = new Map<string, { attempts: number; at: number }>();
  // Per-file saturation state (phase 1: lockout-on-stable). Keyed by
  // repo-relative path. A file is LOCKED OUT after SATURATION_THRESHOLD
  // consecutive no-growth cycles. Locked files are skipped by runCycle —
  // no LLM calls, no quota burn. The user unlocks via the UI (or a server
  // restart resets everything, which is a natural "new pass" boundary).
  private saturation = new Map<string, FileSaturation>();
  private stats = {
    totalScanned: 0,
    totalEnhanced: 0,
    totalReverted: 0,
    totalPushed: 0,
    testsWritten: 0,
    cyclesCompleted: 0,
    tasksGenerated: 0,
    lastEnhancementAt: null as string | null,
  };
  // Durable-stats hydration gate (see hydrateStats). Created in the
  // constructor; awaited at the top of runCycle so the FIRST cycle after
  // a boot waits for the persisted counters (or the one-time DB seed)
  // before doing anything that could persist stats of its own. Without
  // the gate, a fast first cycle could write zeros over a seed mid-flight.
  // Exposed via whenStatsReady() so the status endpoints can await it
  // too — without that, the first poll after a boot returns
  // cyclesCompleted:0 (the pre-hydration default) while the self-model
  // (which reads the durable corpus directly) already has historical
  // attempts, producing a "cycles:0 vs attempts:29" mismatch in the UI.
  private statsReady: Promise<void> = Promise.resolve();
  // Skip-probe cadence counter: every SKIP_PROBE_INTERVALth proactive
  // skip spends the LLM call anyway to score the skipper's claim.
  private skipProbeCounter = 0;
  private logs: Array<{
    timestamp: string;
    message: string;
    type: "info" | "success" | "warn" | "error";
  }> = [];

  constructor() {
    // ── DURABLE STATS HYDRATION ─────────────────────────────────
    // Hydrate the banner counters from .git/info/loop-stats.json (or
    // seed once from the DB on the first boot of this module). Fire-
    // and-forget here; runCycle awaits the gate before any cycle work.
    this.statsReady = this.hydrateStats();

    // ── ZOMBIE-TASK SWEEP ─────────────────────────────────────────────
    // A fresh process cannot have a legitimate in_progress SelfTask —
    // any row in that state was abandoned by a previous process death
    // (segfault / OOM kill mid-gate-chain). claimNextTask only claims
    // pending, generateTasks treats in_progress as already-queued, and
    // pruneTerminalSelfTasks only prunes terminal rows — without this
    // sweep the zombies leaked forever and distorted the queue counts.
    // Fire-and-forget: the table may not exist until first migration.
    void db.selfTask
      .updateMany({ where: { status: "in_progress" }, data: { status: "pending" } })
      .catch(() => {
        /* table missing — dormant, same as the seed calls */
      });

    // ── HOT-SWAP STATE CONTINUITY — REMOVED (cripple-check F3) ──────
    // The constructor used to consume a hot-swap snapshot here (audit 3,
    // B4/B11): the server's hotSwapPipeline stashed the loop's state on
    // globalThis before a swap, and the first post-swap instance restored
    // it (stats, saturation lockouts, cooldown streak) and resumed if the
    // old instance was continuous. After the worker split this can never
    // happen: the server no longer hosts the loop (so no snapshot is ever
    // stashed — SELF_SNAPSHOT_SLOT machinery deleted from hot-swap.ts),
    // and the worker's own pin (__selfEnhanceLoop) is set once at worker
    // boot and never cleared, so no new instance is ever constructed
    // mid-life. The consume/restore block was dead code that a future
    // refactor could mistake for a live seam. State continuity across
    // worker reboots is the armed-tier contract (boot auto-start), not a
    // snapshot restore.

    // ── SELF-MODEL BOOTSTRAP (audit 7 — the cognitive core) ──────────
    // One-time: aggregate the MutationCorpus audit trail (every attempt
    // the loop has ever recorded — 400+ rows on a mature system) into
    // per-file SelfModelFile rows, then apply archaeology stability
    // priors. After this, the loop's file selection is DATA-DRIVEN (UCB1
    // bandit) instead of tree-order, and every attempt opens a self-
    // prediction that builds a real calibration curve. No-ops if the
    // model already has rows (restart-safe). Best-effort — a missing
    // table or DB error degrades to neutral defaults (the bandit
    // returns the incoming tree order).
    void bootstrapSelfModel().catch(() => {
      /* table missing or DB unavailable — bandit degrades to tree order */
    });

    // ── HOST-INJECTED UUID-COMMIT DETECTOR (commit-archaeology defense) ──
    // A bare-UUID commit message landed on `main` (commit e5d2b7a, message
    // "dc951e0f-8247-4972-be3f-17ca5c301b75"). Investigation concluded the
    // commit was created by the host restore orchestrator that rehydrates
    // the project directory from a snapshot on machine restart — OUTSIDE
    // LOOP's commit path. LOOP cannot prevent it (the orchestrator runs
    // before LOOP boots); the two-layer defense is:
    //   (1) Internal guard — pushCurrentState calls validateCommitMessage
    //       before every `git add -A` and aborts with `pushed: false` if
    //       the message is empty or a bare UUID. This guarantees LOOP
    //       itself never produces one.
    //   (2) This startup detector — runs ONCE at boot, reads HEAD's commit
    //       message via `git log -1 --format=%B`, and `console.warn`s if
    //       the latest commit looks host-injected (empty first line or a
    //       bare UUID). It does NOT block boot — the commit is already on
    //       disk by the time LOOP runs; blocking would brick the loop on a
    //       restore. The warn makes the host-injection event visible in
    //       dev.log and signals an operator that commit-archaeology on
    //       that SHA will be a dead-end (UUIDs are unsearchable, break
    //       the message-prefix convention, and make
    //       commit-archaeology.ts return a UUID where intent was expected).
    // See postmortems/self/main/system:commit-message-guard.json for the
    // full finding. Best-effort: a git failure here never blocks the loop.
    try {
      const headMessage = execSync("git log -1 --format=%B", {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
      });
      const rejectReason = validateCommitMessage(headMessage);
      if (rejectReason) {
        const headSha = execSync("git log -1 --format=%H", {
          cwd: PROJECT_ROOT,
          encoding: "utf-8",
          timeout: 5000,
          stdio: "pipe",
        }).trim();
        console.warn(
          `[SELF-ENHANCE] HOST-INJECTED COMMIT DETECTED at boot: HEAD is ${headSha.slice(0, 7)} ` +
          `with a bare-UUID / empty commit message. ${rejectReason} ` +
          `This commit was likely created by the host restore orchestrator (machine restart), not by LOOP. ` +
          `Boot continues — see postmortems/self/main/system:commit-message-guard.json for the full finding.`
        );

        // ── AUTO-AMEND (host-injected commit recovery) ────────────────
        // If HEAD is still local-only (not pushed), amend its message to a
        // real, searchable description so git history stays archaeologisable.
        // amendUuidHeadCommit refuses if HEAD is on origin (would rewrite
        // pushed history — red-team-flagged), if anything is staged (would
        // silently bundle it in), or if the new message itself fails the
        // guard. Best-effort — a refusal never blocks boot; the warn above
        // already made the host-injection visible.
        const amend = amendUuidHeadCommit();
        if (amend.amended) {
          console.warn(
            `[SELF-ENHANCE] AUTO-AMEND recovered HEAD message: ` +
            `${amend.oldSha?.slice(0, 7)} → ${amend.newSha?.slice(0, 7)} ` +
            `(bare-UUID replaced with "restore: amend bare-UUID host-injected commit (loop boot auto-recovery)"). ` +
            `The amended commit carries a real message on the next push. `
          );
        } else if (amend.attempted && amend.reason) {
          console.warn(
            `[SELF-ENHANCE] AUTO-AMEND refused: ${amend.reason} ` +
            `The UUID commit stays as-is in git history. `
          );
        }
      }
    } catch {
      /* git unavailable or no commits yet (fresh repo) — non-fatal, no warn */
    }

    // ── BOOT AUTO-START (armed-intent tier) ─────────────────────────────
    // The operator's "this loop should be running" intent lives in
    // .git/info/loop-self-enhance-armed.json so it survives process
    // restarts (dev-server reload, crash, sandbox reboot). On boot, if
    // the disk says armed:true, the fresh process re-arms the loop — the
    // operator pressed [START] or [SAVE · VERIFY · REBOOT] once, and the
    // loop keeps running on its own after every subsequent recycle.
    // [STOP] clears the intent (sticky — nothing auto-starts again).
    //
    // Same multi-instance guard pattern as the autonomous loop's auto-arm
    // (loop-runtime.ts AUTO_ARM_FLAG): a globalThis flag ensures only ONE
    // auto-start fires per process boot, no matter how many transient
    // Turbopack instances are created during a hot-swap. The pin-check
    // (g.__selfEnhanceLoop === this) inside the timer ensures only the
    // instance that actually won the singleton pin starts the loop.
    try {
      const AUTO_START_FLAG = "__selfEnhanceAutoStartFired";
      const g = globalThis as unknown as {
        [AUTO_START_FLAG]?: boolean;
        __selfEnhanceLoop?: SelfEnhanceLoop;
      };
      if (!g[AUTO_START_FLAG]) {
        g[AUTO_START_FLAG] = true;
        let disk: SelfEnhanceArmedState | null = null;
        try {
          disk = readSelfEnhanceArmedState();
        } catch {
          disk = null; // fail-closed: unreadable ≠ armed
        }
        if (disk && disk.armed) {
          // Respect safe-mode: if it's raised at boot (duress / red-team
          // bypass / gate-integrity failure), do NOT auto-start. The
          // runCycle's own safe-mode check would refuse the first cycle
          // anyway, but skipping the start keeps the log honest ("SAFE-
          // MODE active — not auto-starting") instead of a silent refusal.
          if (isSafeMode()) {
            this.log(
              `SAFE-MODE active at boot — self-enhance loop NOT auto-started despite armed state (armed at ${disk.at} by ${disk.by}). Clear safe-mode then press [START].`,
              "error"
            );
          } else {
            // 2s delay mirrors the autonomous loop's auto-arm timer: lets
            // the module graph settle and the Z.AI cortex warm up before
            // the first cycle's ratchet fires its first llmComplete.
            setTimeout(() => {
              const g2 = globalThis as unknown as { __selfEnhanceLoop?: SelfEnhanceLoop };
              if (g2.__selfEnhanceLoop !== this) return; // a different instance won the pin
              if (this.continuous) return; // already running (e.g. hot-swap resume fired first)
              this.log(
                `PERSISTED ARMED STATE (armed at ${disk!.at} by ${disk!.by}) — auto-starting on boot. It runs whenever the quota gate is open; [STOP] clears the intent.`,
                "success"
              );
              void this.runContinuous().catch((err) => {
                this.log(
                  `Boot auto-start crashed: ${(err as Error).message}`,
                  "error"
                );
              });
            }, 2000);
          }
        }
      }
    } catch {
      /* armed-state read failure must never block the constructor */
    }
  }

  private log(message: string, type: "info" | "success" | "warn" | "error" = "info") {
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      message,
      type,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 500) this.logs.pop();
    const prefix =
      type === "success" ? "✓" : type === "warn" ? "⚠" : type === "error" ? "✗" : "→";
    console.log(`[SELF-ENHANCE] ${prefix} ${message}`);
  }

/**
 * Scan for files to enhance. Full-scope mode (TARGET_FILES empty):
 * every enabled SCAN_SCOPE, minus protected paths, plus the Prisma
 * schema as a special single-file target. Focus mode (TARGET_FILES
 * non-empty): only the listed files. Either way, PROTECTED_FILES /
 * PROTECTED_PREFIXES are the hard floor — isProtectedPath filters
 * every candidate.
 */
  private scanFiles(): string[] {
    const focus = TARGET_FILES.length > 0;
    const allowSet = new Set(TARGET_FILES);
    const files: string[] = [];
    const scan = (dir: string, extensions: string[]) => {
      let entries: import("fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // directory doesn't exist yet
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
            // Two filters: (1) not protected (the hard floor — engine,
            // control surface, control API subtree), (2) in the allowlist
            // when focus mode is on.
            if (!isProtectedPath(relPath) && (!focus || allowSet.has(relPath))) {
              files.push(fullPath);
            }
          }
        }
      }
    };
    for (const scope of SCAN_SCOPES) {
      scan(join(PROJECT_ROOT, scope.dir), scope.extensions);
    }
    // The Prisma schema — only in full-scope mode, never in focus mode
    // (focus means the operator named specific files; the schema is never
    // named by accident).
    if (!focus && existsSync(join(PROJECT_ROOT, SCHEMA_TARGET))) {
      files.push(join(PROJECT_ROOT, SCHEMA_TARGET));
    }
    return files;
  }

  /**
   * Detect truncated LLM output. Delegates to the parser-based
   * implementation in code-analysis.ts — see that file for why raw
   * character counting produced false positives on perfectly valid files
   * (brace imbalance inside strings/regexes read as "truncation", and each
   * false positive recorded a bogus "LLM hit its output token limit"
   * postmortem that then poisoned the next prompt).
   */
  private checkTruncation(code: string, original: string, filePath?: string): { truncated: boolean; reason?: string } {
    return detectTruncation(code, original, filePath);
  }

  /**
   * Verify a refactored file IN MEMORY — spawns the verify-refactor script
   * as a child process, passes the refactored code via stdin, and returns
   * whether it typechecks. NOTHING is written to disk — Turbopack never
   * sees the refactored code until it passes verification.
   */
  private async verifyRefactor(filePath: string, refactoredCode: string): Promise<{ ok: boolean; errors: string[] }> {
    try {
      const result = await runChildAsync(
        "bun",
        ["run", "src/lib/pipeline/autonomous/verify-refactor.ts", filePath],
        {
          cwd: PROJECT_ROOT,
          input: refactoredCode,
          timeoutMs: 60000,
        }
      );

      const stdout = (result.stdout || "").trim();
      if (!stdout) {
        const stderr = (result.stderr || "").slice(0, 200);
        return { ok: false, errors: [`Verifier produced no output${stderr ? `: ${stderr}` : ""}`] };
      }

      try {
        const parsed = JSON.parse(stdout) as { ok: boolean; errors: string[] };
        return parsed;
      } catch {
        return { ok: false, errors: [`Verifier output not JSON: ${stdout.slice(0, 200)}`] };
      }
    } catch (err) {
      return { ok: false, errors: [`Verifier failed to run: ${(err as Error).message}`] };
    }
  }

  /**
   * Git commit and push the current live state via the configured push target
   * (authenticated; see push-target.ts). Falls back to commit-only when no
   * target is configured.
   */
  private async gitPush(message: string): Promise<{ pushed: boolean; commitSha?: string }> {
    try {
      const outcome = await pushCurrentState({
        message,
        ...(this.currentCycleBranch ? { branchOverride: this.currentCycleBranch } : {}),
      });
      if (outcome.pushed) {
        this.log(`Pushed to GitHub: ${outcome.commitSha} (${outcome.repo})`, "success");
        return { pushed: true, commitSha: outcome.commitSha };
      }
      if (!outcome.error) {
        // No changes to commit and nothing new to push
        return { pushed: false };
      }
      if (outcome.commitSha) {
        this.log(`Committed ${outcome.commitSha} but push failed: ${outcome.error}`, "warn");
      } else {
        this.log(`Push skipped: ${outcome.error}`, "warn");
      }
      return { pushed: false, commitSha: outcome.commitSha };
    } catch (err) {
      this.log(`Git operation failed: ${(err as Error).message}`, "error");
      return { pushed: false };
    }
  }

  /**
   * Detect banner-style comments: decorative separator lines (====, ----, ****,
   * ────, ════) or attribution/branding phrases. Plain JSDoc docstrings do NOT match.
   */
  private static looksLikeBanner(comment: string): boolean {
    // A line that is essentially a separator run, optionally prefixed with "//"
    const hasSeparatorLine = /(^|\n)\s*(?:\/\/)?\s*[=*\-#~─═]{4,}\s*(?=\n|$)/.test(comment);
    // Attribution / branding phrases
    const hasBranding =
      /enhanced by|mutated by|refactored by|auto-generated|auto-refactor/i.test(comment);
    return hasSeparatorLine || hasBranding;
  }

  /**
   * Strip a LEADING banner comment (block or line-comment style) from refactored
   * output. Conservative: only strips if it matches banner heuristics, so
   * legitimate file docstrings survive.
   */
  private stripBannerComments(code: string): { code: string; stripped: boolean } {
    let out = code;

    // Leading block comment
    const blockMatch = out.match(/^\/\*+\s*[\s\S]*?\*+\/\s*/);
    if (blockMatch && SelfEnhanceLoop.looksLikeBanner(blockMatch[0])) {
      out = out.slice(blockMatch[0].length);
      return { code: out.replace(/^\s*\n/, ""), stripped: true };
    }

    // Leading run of // line comments
    const lineMatch = out.match(/^(?:[ \t]*\/\/[^\n]*\n)+/);
    if (lineMatch && SelfEnhanceLoop.looksLikeBanner(lineMatch[0])) {
      out = out.slice(lineMatch[0].length);
      return { code: out.replace(/^\s*\n/, ""), stripped: true };
    }

    return { code: out, stripped: false };
  }

  /**
   * DEBATE GATE — a second LLM reviews the proposed refactor before write.
   *
   * The typecheck gate proves "compiles". The structural validator proves
   * "didn't drop exports / wasn't truncated". NEITHER proves "the change is
   * semantically correct and safe." A second LLM (Security + Architecture +
   * Lead tribunal from debate-llm.ts) evaluates the candidate code and can
   * REJECT or REQUIRES_REWRITE it. This is the missing semantic gate — the
   * typecheck can't catch "added a null check that breaks the happy path."
   *
   * If the debate LLM is unavailable, the gate FAILS CLOSED: the file is
   * DEFERRED (approved:false, deferred:true) — never auto-approved. An
   * unavailable tribunal is exactly when semantic review is least
   * trustworthy, so nothing goes live without it (audit 2; the pre-audit
   * behavior fell back to APPROVED, which let refactors go live with zero
   * semantic review during LLM outages).
   */
  private async debateGate(
    filePath: string,
    originalCode: string,
    refactoredCode: string,
    changeSummary: string
  ): Promise<{ approved: boolean; reason: string; verdict?: string; deferred?: boolean }> {
    try {
      const topic = `Proposed refactor of ${relative(PROJECT_ROOT, filePath)}: ${changeSummary.slice(0, 200)}`;
      const result = await conductLlmDebate(topic, refactoredCode, filePath);
      const consensus = result.verdict.consensus;

      if (consensus === "APPROVED" || consensus === "CONDITIONAL_APPROVAL") {
        return { approved: true, reason: `Debate: ${consensus}`, verdict: consensus };
      }
      // REJECTED or REQUIRES_REWRITE
      return {
        approved: false,
        reason: `Debate rejected (${consensus}): ${result.verdict.leadSummary ?? "no rationale"}`,
        verdict: consensus,
      };
    } catch (err) {
      // FAIL CLOSED (audit 2). This used to return approved:true so an LLM
      // outage wouldn't block the loop — but that let refactors go live (and
      // tests get pinned) with ZERO semantic review during exactly the
      // moments the LLM layer is least trustworthy. It also contradicted
      // debate-llm.ts's own "NO FALLBACK" contract. Now an unavailable
      // tribunal DEFERS the file: no postmortem, no failure counter, no
      // reverted stat — the loop's cooldown gate handles the wait and the
      // file is retried when the tribunal can actually run.
      const msg = (err as Error).message ?? "unknown error";
      const rateLimited = /\b429\b|rate.?limit|cooldown|too many requests/i.test(msg);
      return {
        approved: false,
        deferred: true,
        reason: rateLimited
          ? `Debate tribunal rate-limited — deferring: ${msg.slice(0, 100)}`
          : `Debate tribunal unavailable — deferring (fail-closed): ${msg.slice(0, 100)}`,
      };
    }
  }

  /**
   * TEST GATE — run any test files that cover the target file.
   *
   * This is THE real signal from DIRECTIONS.md (Direction 4: tests as the
   * gate). Typecheck proves "compiles". Tests prove "behavior preserved."
   *
   * Finds test files that import the target file (whole-tree resolution —
   * see findTestFilesFor) and runs them with `bun test` INSIDE A SANDBOX
   * COPY of the project (core/sandbox-test.ts). If any test fails, REJECT
   * the refactor (don't write, don't push).
   *
   * ZERO LIVE-WRITE (external audit, finding 1 — full closure): the
   * candidate is never written to the real tree. The old implementation
   * wrote it to the live file for the duration of the test run — Turbopack
   * could hot-reload the unverified candidate, and a hard crash could
   * strand it (the write-ahead journal restored it afterwards, but the
   * exposure window itself stayed open). The sandbox removes the window
   * entirely: the candidate only ever exists under .loop-sandbox/ (a
   * verify-XXXX directory), outside src/, gitignored, deleted when the run ends. A crash leaves
   * disposable garbage, not a live mutation. The journal recovery below
   * stays armed as defense-in-depth for journals left by the pre-sandbox
   * implementation (or any future path that re-introduces live writes).
   *
   * HONEST NO-TESTS SEMANTICS (external audit, finding 2): when no tests
   * exist, the gate still passes — failing closed would brick the loop on a
   * codebase with no tests — but the result carries testCount: 0 and the
   * caller records it in the log AND the commit message, so no audit trail
   * can ever mistake "passed the gates" for "behavior was tested". The
   * mutation's provenance permanently says which kind of verification it
   * actually received.
   */
  private async testGate(filePath: string, refactoredCode: string): Promise<{ passed: boolean; reason: string; testCount: number }> {
    // Legacy crash recovery (idempotent, ~free when no journal exists): a
    // leftover journal means a PRE-SANDBOX testGate died mid-run with a
    // candidate live on disk — restore before anything else so we never
    // build on (or commit) a stranded unverified mutation.
    const recovery = recoverCrashedTestGate();
    if (recovery.recovered) {
      this.log(
        `TEST-GATE CRASH RECOVERY: restored original ${relative(PROJECT_ROOT, recovery.filePath ?? "")} — a pre-sandbox test run crashed with the candidate live (armed ${recovery.armedAt ?? "unknown"})`,
        "error"
      );
    }

    const testFiles = findTestFilesFor(filePath);
    if (testFiles.length === 0) {
      return { passed: true, reason: "no tests found for this file — behavioral coverage: 0 (verified by static gates + debate only)", testCount: 0 };
    }

    // Run the covering tests against the candidate INSIDE THE SANDBOX.
    // Fail-closed: a sandbox we cannot build or run is a rejected mutation,
    // never a silently-passed one.
    return await runTestsInSandbox(
      [{ path: filePath, content: refactoredCode }],
      testFiles
    );
  }

  /**
   * SATURATION CHECK — is this refactor actually meaningful, or just churn?
   *
   * Strips comments and whitespace from both original and refactored code,
   * then compares. If the only changes are comments/whitespace/renamed
   * locals, it's cosmetic churn — skip the write+push+debate cycle entirely.
   * EMG's "SATURATION EQUILIBRIUM PROTOCOL": if the code is already optimal,
   * output NO_CHANGES_NEEDED. We detect the equivalent after the fact.
   */
  private isCosmeticChange(original: string, refactored: string): boolean {
    // Mask comments with the real scanner (code-analysis.ts), then strip all
    // whitespace, then compare. Comment churn is cosmetic; code and string
    // content are not. The old regex chain stripped `//` inside STRING
    // literals too, so a real change after a URL on the same line looked
    // cosmetic (audit 2).
    const strip = (s: string) => stripComments(s).replace(/\s+/g, "");
    return strip(original) === strip(refactored);
  }

  /**
   * ANTI-TAUTOLOGY CHECK — reject test files that assert nothing real.
   *
   * A test that always passes pins nothing — it's a fake pin. The ratchet
   * is only as strong as its weakest test, so generated tests are checked
   * for the classic tautology patterns before they're ever run:
   *   - doesn't import the module under test (tests nothing)
   *   - fewer than 2 test blocks (too thin to be a contract)
   *   - fewer expect() calls than tests (a test without assertions)
   *   - literal self-comparisons: expect(X).toBe(X)
   *   - simple-expression self-comparisons: expect(f(1)).toBe(f(1))
   * The debate gate adds semantic review on top of these mechanical checks.
   */
  private antiTautologyCheck(testCode: string, importBase: string): { ok: boolean; issues: string[] } {
    const issues: string[] = [];

    // Must import the module under test (relative import from the same dir)
    if (!testCode.includes(`from "./${importBase}"`)) {
      issues.push(`does not import the module under test (expected 'from "./${importBase}"')`);
    }

    // Need at least 2 test blocks to be a meaningful contract
    const testBlocks = (testCode.match(/\btest\s*\(/g) ?? []).length;
    if (testBlocks < 2) {
      issues.push(`only ${testBlocks} test() block(s) — need at least 2`);
    }

    // Every test needs at least one assertion
    const expects = (testCode.match(/\bexpect\s*\(/g) ?? []).length;
    if (testBlocks > 0 && expects < testBlocks) {
      issues.push(`${expects} expect() call(s) for ${testBlocks} test(s) — every test needs assertions`);
    }

    // Literal self-comparison: expect(true).toBe(true), expect(5).toBe(5), expect(x).toBe(x)
    const selfCompare = /expect\s*\(\s*([^()]+?)\s*\)\s*\.\s*toBe\s*\(\s*([^()]+?)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = selfCompare.exec(testCode)) !== null) {
      if (m[1].trim() === m[2].trim()) {
        issues.push(`tautological assertion: expect(${m[1].trim()}).toBe(${m[2].trim()}) — asserts nothing`);
        break; // one report is enough
      }
    }

    return { ok: issues.length === 0, issues };
  }

  /**
   * THE RATCHET — write characterization tests for an untested module.
   *
   * This is Direction 4 made real: the system writes its own tests, the
   * tests become the gate for every future refactor of that module. Each
   * pass either adds pins (tightening the behavioral contract) or refactors
   * within them. Behavior gets increasingly locked while implementation
   * gets increasingly clean — and a refactor that breaks a pin is rejected
   * by the test gate built in the previous step.
   *
   * Gates on the generated test file (in order):
   *   1. truncation + anti-tautology (mechanical, instant)
   *   2. WRITE TEMP → `bun test` — must PASS on the current code
   *      (a test failing on current code pins wrong behavior — reject it,
   *      do NOT "fix" the code to match a generated test)
   *   3. `tsc --noEmit` — type errors in the test file → reject
   *   4. debate gate (semantic review: is this a real behavioral test?)
   *   5. keep + push. The pin is live.
   *
   * On any failure: DELETE the test file (it was new — nothing imports it,
   * so the live system was never at risk) and record the attempt. After 2
   * failed attempts per file, stop trying (don't burn LLM budget retrying).
   *
   * Test files are write-once: the refactor scan excludes *.test.ts, so the
   * system can never weaken its own pins. The ratchet only tightens.
   */
  private async writeTestsForFile(filePath: string): Promise<boolean> {
    const relPath = relative(PROJECT_ROOT, filePath);
    // STOP-interrupt (external audit F3): capture the run generation so a
    // [STOP] during the ratchet's LLM call / sandbox gates / debate aborts
    // BEFORE the pin's live write. The caller's checkpoint ("Fix C", after
    // this method returns) was too late — the pin could already be written
    // and pushed. Captured at method entry so the whole gate chain is
    // covered. If STOP lands in the tiny write→push window AFTER a pin has
    // passed every gate and been written, the push still completes — a
    // gated, written pin left unpushed would leave the tree dirty relative
    // to origin for no safety benefit.
    const myRun = this.runId;
    // Strip the real extension (.ts/.tsx) — same bug as findTestFilesFor:
    // basename(p, ".ts") left .tsx sources with their extension attached, so
    // the ratchet wrote/looked for `console-stream.tsx.test.ts`.
    const ext = filePath.endsWith(".tsx") ? ".tsx" : ".ts";
    const base = basename(filePath, ext);
    const testPath = join(dirname(filePath), `${base}.test${ext}`);
    // Audit 3: becomes true the moment the pin's live write lands — the
    // catch below must never delete an ALREADY-WRITTEN (possibly pushed)
    // pin because of a later exception in the same try block.
    let pinned = false;

    if (existsSync(testPath)) return false; // already pinned
    const now = Date.now();
    // `let`, not `const`: when the decay branch fires we must forget the
    // stale record, otherwise the (rec?.attempts ?? 0) + 1 below would still
    // read the pre-decay counter and the 30-min forget window would be a
    // no-op. Bug surfaced by the audit: a file first tried at 12:40 showed
    // "attempt 2" at 1:38 — the decay didn't reset it.
    let rec = this.testWriteAttempts.get(relPath);
    // Decay: forget failures older than 30 minutes — intermittent 429 windows
    // shouldn't permanently skip a module
    if (rec && now - rec.at > 30 * 60 * 1000) {
      this.testWriteAttempts.delete(relPath);
      rec = undefined;
    }
    if (rec && rec.attempts >= 2) {
      return false; // known-failed recently — don't burn LLM budget retrying
    }
    // NOTE (audit 2): no pre-increment. The attempt counter is only bumped
    // AFTER a real (non-rate-limited) LLM call completes below. Previously
    // the increment happened before the call, so two gate deferrals (each
    // returning instantly with rateLimited:true) burned both attempts and
    // locked the module out for 30 minutes — against the "defer, don't
    // burn an attempt" contract in agent-llm.ts.

    try {
      const source = readFileSync(filePath, "utf-8");
      if (source.length > 12000) return false; // too large for the LLM prompt

      this.log(`Ratchet: writing characterization tests for ${relPath} (attempt ${(rec?.attempts ?? 0) + 1})...`, "info");

      // Inject the REAL export list so the LLM can't hallucinate names. This
      // is the #1 ratchet failure mode: without the list, the LLM invents
      // exports like `extractTopLevelExports` (when the real one is
      // `extractTopLevelFunctions`) and the test fails at import time with
      // `SyntaxError: Export named 'X' not found`. With the list, the LLM
      // is told exactly what it can import.
      const exps = extractExports(source);
      const exportList = formatExportList(exps);

      // D3 (dreamer): an idle-time DRAFT for this module may exist — a
      // speculative characterization test drafted while the loop was
      // waiting. ADVISORY ONLY: hand it over as a starting point. Every
      // import and expectation still passes through the real ratchet
      // gates below (anti-tautology, bun-test-pass, tsc, debate); a bad
      // draft dies there and cost one prompt slot.
      const draft = getRatchetDraft(relPath);
      const draftBlock = draft
        ? `\nA DRAFT from the idle-time dreamer (speculative, NEVER trusted blindly — verify every import against the export list above and every expected value against the implementation; discard anything that doesn't check out):\n\`\`\`typescript\n${draft.slice(0, 6000)}\n\`\`\`\n`
        : "";

      const userPrompt = `Module to pin: ${relPath}

This module exports EXACTLY these symbols (import ONLY from "./${base}", do NOT invent any other export names):
${exportList}

Source:
\`\`\`typescript
${source}
\`\`\`
${draftBlock}
Write ${base}.test.ts — a bun:test characterization suite pinning this module's current observable behavior. Compute expected values yourself from the implementation (read the logic, work out the output, assert that exact value). Every test() must contain at least one expect(). Output the summary first, then the test file.`;

      const llmResult = await llmComplete({
        systemPrompt: TEST_WRITER_SYSTEM,
        userPrompt,
        temperature: 0.2,
        onRetry: (info) => {
          const backoff = info.isRateLimit ? `${Math.round(info.delayMs / 1000)}s` : `${info.delayMs}ms`;
          this.log(`LLM retry attempt ${info.attempt}/${info.maxAttempts} (${info.isRateLimit ? "429" : "err"} — backing off ${backoff}) for ratchet/${relPath}`, "info");
        },
      });
      if (!llmResult.ok && llmResult.rateLimited) {
        // Gate deferral — NOT an attempt. The runCycle loop sleeps out the
        // cooldown and this module is retried fresh when the gate opens.
        this.log(`Ratchet: deferring test-writing for ${relPath} — LLM on cooldown (${(llmResult.error ?? "").slice(0, 90)})`, "warn");
        return false;
      }
      // A real LLM call was consumed — count it as an attempt NOW (success
      // or failure): if this pin doesn't survive the gates below, the next
      // try is attempt N+1, and after 2 the module is left alone for 30 min.
      this.testWriteAttempts.set(relPath, { attempts: (rec?.attempts ?? 0) + 1, at: now });
      if (!llmResult.ok) {
        this.log(`Ratchet: test-writing LLM unavailable for ${relPath}: ${(llmResult.error ?? "").slice(0, 120)}`, "warn");
        return false;
      }

      const { summary, code } = extractSummaryAndCode(llmResult.content);
      if (!code || !code.trim()) {
        this.log(`Ratchet: LLM returned no test code for ${relPath}`, "warn");
        return false;
      }

      // Gate 1: truncation + anti-tautology (mechanical, instant)
      const truncation = this.checkTruncation(code, "", testPath);
      if (truncation.truncated) {
        this.log(`Ratchet: rejected test for ${relPath} (truncated: ${truncation.reason})`, "warn");
        return false;
      }
      const taut = this.antiTautologyCheck(code, base);
      if (!taut.ok) {
        this.log(`Ratchet: rejected test for ${relPath} — ${taut.issues.join("; ")}`, "warn");
        return false;
      }

      // Gate 2: run IN THE SANDBOX — the drafted test must PASS on the
      // CURRENT code. A failing test pins wrong behavior (or found a real
      // bug — but the system doesn't get to redefine behavior via its own
      // generated tests, so conservative policy: reject the test, keep the
      // code). Sandbox (external audit, finding 1): the draft only ever
      // exists inside .loop-sandbox/ — a crash mid-ratchet can no longer
      // strand a broken .test.ts on the live tree where it would veto every
      // future refactor of the module until manually deleted.
      const overlay = [{ path: testPath, content: code }];
      const run = await runTestsInSandbox(overlay, [testPath], 60000);
      if (!run.passed) {
        this.log(`Ratchet: rejected test for ${relPath} (fails on current code — pins wrong behavior): ${run.reason.slice(0, 250)}`, "warn");
        return false;
      }

      // Gate 3: typecheck IN THE SANDBOX — errors mentioning the test file
      // → reject. (Pre-existing errors elsewhere are not the test's fault —
      // bun test already proved the test runs; tsc-scoped errors are what
      // matter.) Runs against the same overlay so the draft still never
      // touches the live tree.
      const tsc = await typecheckInSandbox(overlay);
      // Fail-closed (external audit F5): status === null means the typecheck
      // NEVER RAN (sandbox setup failure, overlay failure, spawn error, or
      // timeout — see typecheckInSandbox's return paths). The old condition
      // (`status !== 0 && output.includes(test file)`) only rejected when
      // the output NAMED the test file — but a setup-failure output never
      // names it, so a never-run typecheck passed the gate and the test
      // proceeded to debate and a possible live write. The comment on the
      // sandbox path says "fail-closed"; now the caller actually is.
      if (tsc.status !== 0 && (tsc.status === null || tsc.output.includes(`${base}.test.ts`))) {
        this.log(
          `Ratchet: rejected test for ${relPath} (${
            tsc.status === null ? `typecheck did not run — fail-closed: ${tsc.output.slice(0, 120)}` : "typecheck errors in the test file"
          })`,
          "warn"
        );
        return false;
      }

      // Gate 4: debate — semantic review of the test file
      const debate = await this.debateGate(filePath, source, code, `characterization tests: ${summary.slice(0, 200)}`);
      if (!debate.approved) {
        if (debate.deferred) {
          // Tribunal unavailable (429 window / parse failure) — fail-closed.
          // The pin is retried on a later pass; it is NOT counted as a
          // rejection (the attempt was already recorded above).
          this.log(`Ratchet: deferring test pin for ${relPath} — debate tribunal unavailable, not auto-approving (fail-closed)`, "warn");
        } else {
          this.log(`Ratchet: rejected test for ${relPath} by debate: ${debate.reason.slice(0, 150)}`, "warn");
        }
        return false;
      }

      // STOP checkpoint (external audit F3): a [STOP] that arrived during
      // the LLM call or any of the gates above must not produce a live
      // write. Discard the drafted pin — it cost prompt slots, but nothing
      // was written and the module simply stays unpinned (retried if the
      // loop is restarted before the attempt-decay window closes).
      if (myRun !== this.runId) {
        this.log(`Ratchet: STOP requested while drafting tests for ${relPath} — discarding pin before its live write`, "warn");
        return false;
      }

      // All gates passed — NOW the pin goes live (its first and only live
      // write, after every gate accepted it). Future refactors of this
      // module run against these tests (the test gate finds co-located
      // tests — also sandboxed from here on).
      writeFileSync(testPath, code, "utf-8");
      pinned = true;
      this.stats.testsWritten++;
      const testCount = (code.match(/\btest\s*\(/g) ?? []).length;
      this.log(`Ratchet: PINNED ${relPath} with ${testCount} characterization tests — future refactors run against them (${debate.reason})`, "success");

      const pushResult = await this.gitPush(`test: pin behavior of ${relPath}\n\n${summary}\n\n(characterization tests — the ratchet: refactors that break these are rejected)`);
      if (pushResult.pushed) {
        this.log(`Ratchet: pushed test pin ${pushResult.commitSha}`, "success");
      }
      return true;
    } catch (err) {
      // The sandbox flow never writes the draft to the live tree before the
      // gates pass, so there is normally nothing to clean up — but stay
      // defensive: if a FUTURE code path writes early, remove the stray.
      // Audit 3: only when the pin never landed — deleting a written (and
      // possibly already pushed) pin was a latent footgun one refactor
      // away from destroying live ratchet coverage.
      try {
        if (!pinned && existsSync(testPath)) rmSync(testPath);
      } catch {
        /* ignore */
      }
      this.log(`Ratchet: error writing tests for ${relPath}: ${(err as Error).message}`, "error");
      return false;
    }
  }

  /**
   * Enhance a single file: LLM refactor → verify tsc → write live → git push.
   */
  async enhanceFile(filePath: string, mode: "refactor" | "visual-polish" = "refactor"): Promise<SelfEnhanceResult> {
    const relPath = relative(PROJECT_ROOT, filePath);
    this.currentFile = relPath;
    // SELF-MODEL: record the mode so the post-verdict noteOutcome feeds
    // the per-mode stats (visual-polish vs refactor) into the calibration
    // curve. Serial loop ⇒ safe instance-field hand-off.
    this.lastAttemptMode = mode;
    const startTime = Date.now();
    // Capture the current run generation. If stop() fires during this
    // enhanceFile (incrementing runId), we abort at the next checkpoint
    // (after the ratchet, before the LLM enhance call) instead of running
    // the full ~150s backoff + typecheck + push against a stale run.
    const myRun = this.runId;

    // ── SCHEMA PATH ── prisma/schema.prisma doesn't go through the
    // tsc/AST/debate chain (none of those apply to a non-TS DSL). It
    // gets its own prompt and the additive-only schema gate. Routed
    // here, before the ratchet — you can't characterization-test a
    // schema, and the schema gate IS the gate.
    if (relPath === SCHEMA_TARGET) {
      return this.enhanceSchema(filePath, myRun);
    }

    // Compute this enhancement's branch: loop-{N+1} where N is the last
    // successful enhancement's number. Stored on the instance so every
    // gitPush in this enhanceFile (test pin + enhancement) targets the
    // same branch — one full mutation = one branch.
    const lastN = await getLastBranchNumber();
    const thisN = lastN + 1;
    this.currentCycleBranch = formatLoopBranch(thisN);
    this.log(`Branch for this mutation: ${this.currentCycleBranch}`, "info");

    const result: SelfEnhanceResult = {
      filePath: relPath,
      enhanced: false,
      reason: "",
      oldBytes: 0,
      newBytes: 0,
      diffBytes: 0,
      llmUsed: false,
      llmLatencyMs: 0,
      compiled: false,
      pushed: false,
    };

    try {
      // Audit 3: clear the PREVIOUS file's provenance FIRST — if the read
      // below throws, the corpus writer must not record the previous
      // file's shas under THIS file's path.
      this.lastAttemptInfo = { originalSha: "", mutatedSha: null, transformSummary: null, branchNumber: thisN };
      // 1. Read the current file
      const originalCode = readFileSync(filePath, "utf-8");
      result.oldBytes = originalCode.length;
      // D4 (corpus): provenance for this attempt — what the source looked
      // like before anyone touched it. Set here (top of the attempt) so
      // every downstream return path carries it via lastAttemptInfo.
      this.lastAttemptInfo = {
        originalSha: sha16(originalCode),
        mutatedSha: null,
        transformSummary: null,
        branchNumber: thisN,
      };

      // 1a. Skip files that are too large for the LLM to refactor without truncating.
      // The model's output token limit means files over ~12KB often get cut off
      // mid-comment, producing syntax errors that waste a full typecheck cycle.
      const MAX_FILE_BYTES = 12000;
      if (originalCode.length > MAX_FILE_BYTES) {
        result.reason = `Skipped (file too large: ${originalCode.length}b > ${MAX_FILE_BYTES}b)`;
        this.log(`Skipped ${relPath} (${originalCode.length}b — too large for LLM, would truncate)`, "info");
        return result;
      }
      // 1a-ii. Skip files that are too SMALL to meaningfully enhance. A
      // sub-80-byte .ts/.tsx file is almost certainly a barrel re-export,
      // an empty placeholder, or a one-line constant — the LLM either
      // zero-diffs it ("No issues found" — correct, it's done) or adds a
      // useless header comment (cosmetic, gate-rejected). Either way the
      // LLM call is wasted quota. The 80-byte floor is below any file
      // with a real function/class/interface in it. Files this small are
      // classified as no-growth by saturation (correctly — they ARE
      // finished) and lock out after the threshold, so this is a
      // quota-saving early-exit, not a permanent ban.
      const MIN_FILE_BYTES = 80;
      if (originalCode.trim().length < MIN_FILE_BYTES) {
        result.reason = `Skipped (file too small: ${originalCode.trim().length}b < ${MIN_FILE_BYTES}b — likely barrel/placeholder, no meaningful enhancement)`;
        this.log(`Skipped ${relPath} (${originalCode.trim().length}b — too small to meaningfully enhance)`, "info");
        return result;
      }

      // 1b. THE RATCHET — pin untested modules with characterization tests
      // BEFORE refactoring. The pins become the gate for the refactor in
      // this same pass (and all future ones): if the refactor below breaks
      // a pinned behavior, the test gate rejects it. Each pass either adds
      // pins or refactors within them. Test files are write-once (the scan
      // excludes *.test.ts), so the system can never weaken its own pins.
      // Protected files are skipped: they're the gate itself (importing the
      // loop singleton in a test would have side effects).
      if (!PROTECTED_FILES.has(relPath)) {
        await this.writeTestsForFile(filePath);
      }

      // Run-token checkpoint (Fix C): if stop() fired during the ratchet,
      // bail before the LLM enhance call. Token-only (audit 2): checking
      // `!this.continuous` here is what broke the MANUAL trigger — a
      // one-shot cycle runs with continuous=false and used to abort every
      // file as "Stopped during ratchet". stop() always bumps runId, so the
      // token alone covers both modes.
      if (myRun !== this.runId) {
        result.reason = "Stopped during ratchet";
        this.log(`Aborting enhance for ${relPath} — stop requested`, "warn");
        return result;
      }

      // Fix B: gate checkpoint. If the ratchet just set the gate (or it was
      // already active), defer the enhance call — don't burn a 2-attempt LLM
      // call that will immediately 429 and re-set the gate at a higher
      // escalation level. The for-loop in runCycle will sleep until the gate
      // opens before attempting the next file.
      const cooldownAfterRatchet = llmCooldownMs();
      if (cooldownAfterRatchet > 0) {
        result.reason = `Deferred (LLM cooldown — ${Math.round(cooldownAfterRatchet / 1000)}s)`;
        this.log(`Deferring enhance for ${relPath} — LLM on cooldown (${Math.round(cooldownAfterRatchet / 1000)}s remaining)`, "warn");
        return result;
      }

      // 2. Check for postmortem constraints
      const postmortem = await postmortemStore.getConstraintsForFile(
        "self",
        "main",
        relPath
      );

      // 2b. Ancestral RAG (concept: DARLEK_CAAN queryAncestralWisdom / GRAFT 3).
      // The per-file postmortem (above) only sees THIS file's history.
      // The ancestral query pulls VERIFIED postmortems from OTHER files
      // whose symptom/evidence/constraints match a keyword derived
      // from this file's path + (if present) its current symptom. So a
      // syntax-drop failure on foo.ts teaches a constraint that surfaces
      // when enhancing bar.ts. Local, synchronous, zero LLM cost.
      const ancestralKeyword =
        (postmortem.symptom ? postmortem.symptom + " " : "") +
        relPath.replace(/[\/\\]/g, " ").replace(/\.[a-z]+$/, "");
      let ancestralBlock = "";
      try {
        const ancestral = await queryRelevantPostmortems({
          keyword: ancestralKeyword,
          excludeFilePath: relPath,
          repo: "self",
          limit: 5,
        });
        ancestralBlock = formatAncestralPromptBlock(ancestral);
      } catch {
        /* best-effort — ancestral RAG is an enhancement, not a gate */
      }

      // 3. LLM improvement — ask for REAL improvements, not cosmetic refactoring
      this.log(`Improving ${relPath}...`, "info");

      // 3-lessons. COMPOUNDING INTELLIGENCE — general lessons distilled
      // from aggregate history inject into EVERY enhance prompt (that's
      // the transfer: a lesson from pipeline failures shapes a UI
      // component mutation). The ids ride on the instance so runCycle
      // can feed the verdict back — see the wrapper after the enhanceFile
      // call in runCycle. Serial loop ⇒ instance field is safe.
      //
      // D2 two-track: PROMOTED procedures (active, lapsed 6+ times)
      // inject through a separate, unbounded Operating Constraints block
      // ABOVE the postmortem block — non-negotiable by position. The
      // bounded block carries the rest under a hard byte budget (D6).
      let operatingBlock = "";
      let lessonsBlock = "";
      this.lastLessonIds = [];
      try {
        const promoted: LessonRow[] = await getPromotedProcedures();
        const ls = await getLessonsForPrompt();
        const all = [...promoted, ...ls];
        if (all.length > 0) {
          this.lastLessonIds = all.map((x) => x.id);
          operatingBlock = formatOperatingConstraintsBlock(promoted);
          lessonsBlock = formatLessonsBlock(ls);
          await markInjected(this.lastLessonIds);
        }
      } catch {
        /* lessons are an amplifier, not a gate */
      }

      // 3-negatives. NEGATIVE CONSTRAINTS (RAS graft) — this file's
      // gate-rejected transforms from the mutation corpus, fed back as
      // do-not-reuse constraints EVERY cycle. The distiller sees the
      // aggregate shape once per DISTILL_INTERVAL; this block shows the
      // per-file exhausted space to the proposer itself. Directly saves
      // scarce LLM calls: a proposal the gates already rejected is a
      // wasted call in a 429-starved loop.
      let rejectedBlock = "";
      try {
        const rejected = await getRejectedTransformsForFile(relPath);
        rejectedBlock = formatRejectedTransformsBlock(rejected);
        if (rejectedBlock) {
          this.log(
            `Injecting ${rejected.length} rejected-transform constraint(s) for ${relPath} (corpus negative constraints)`,
            "info"
          );
        }
      } catch {
        /* amplifier, not a gate */
      }

      // 3-arch. ARCHITECTURE CONTEXT (D1) — a 2-hop "neighborhood map"
      // of the file being refactored: its exports + its imports' exports
      // + its 2-hop neighbors. Injected into the refactor prompt so the
      // LLM refactors with architecture-level vision (it sees which
      // other modules import THIS file's exports, so it won't rename a
      // helper that 5 other files depend on). Computed ONCE per
      // enhanceFile call (cheap: target + ≤19 1-hop files), cached in
      // archContextBlock. Fail-soft: any error → empty block, prompt
      // proceeds without arch vision (better than losing the cycle).
      // NOT injected into visual-polish mode (UI components —
      // architecture context is less relevant for styling changes).
      let archContextBlock = "";
      try {
        const arch = buildArchContext(filePath);
        if (arch.summary.length > 0) {
          // Wrap with delimiters so the LLM can clearly see where the
          // injected context begins and ends (vs. the file's own code
          // above it). The summary itself already has an "=== ARCHITECTURE
          // CONTEXT ===" header from the builder; the outer dashes make
          // the injection block visually distinct from the code fence.
          archContextBlock = `\n--- ARCHITECTURE CONTEXT (2-hop neighborhood, ${arch.fileCount} files parsed, hop=${arch.hopCount}) ---\n${arch.summary}\n--- END ARCHITECTURE CONTEXT ---\n`;
          this.log(
            `Built arch context for ${relPath}: ${arch.fileCount} files, ${arch.hopCount}-hop, ${arch.summary.length}b`,
            "info"
          );
        }
      } catch {
        /* arch context is a vision amplifier, not a gate — fail-soft */
      }

      const refactorSystem = `You are a senior code reviewer improving a TypeScript file inside an autonomous self-improvement pipeline. Your changes will be typechecked and pushed to GitHub as the system's live state.

Your job: find and fix REAL issues. Do NOT make cosmetic changes (type annotations, magic numbers, syntax modernization). Those are pointless. Instead, look for:

1. BUGS: null/undefined crashes, missing error handling, unhandled edge cases, race conditions, off-by-one errors, resource leaks (unclosed handles)
2. ERROR HANDLING: bare try/catch that swallows errors, missing error context, unhelpful error messages. Add actionable error messages with context.
3. INPUT VALIDATION: functions that assume valid input and would crash or misbehave on bad input. Add guard clauses with clear errors.
4. PERFORMANCE: obvious inefficiencies — O(n²) where O(n) works, repeated computations in loops, unnecessary allocations, synchronous I/O that could be async.
5. SECURITY: injection risks, unsafe eval, hardcoded secrets, missing input sanitization.
6. DEAD CODE: unused imports, unreachable branches, commented-out code.

HARD RULES (violating any rule fails the pipeline):
- Preserve EVERY top-level exported symbol (function, class, interface, type, const). Do not rename or remove them.
- Do NOT add header comments, banners, or branding.
- Do NOT add unused interfaces or types.
- Do NOT change the public API signature of any export (parameter names, types, return type must stay the same).
- Keep changes focused — don't rewrite the whole file. Only fix real issues.
- If there are NO real issues to fix, output the original code unchanged.

OUTPUT FORMAT (mandatory):
- First, write a SHORT summary (1-5 bullet points) of what you changed and why. Start with "## Changes" on its own line.
- Then output the complete refactored code in a single fenced \`\`\`typescript block.
- Example:
## Changes
- Added null check in parseX() — could crash on undefined input
- Replaced bare catch with contextual error message in fetchY()
- Added input validation for limit parameter (negative values caused infinite loop)

\`\`\`typescript
// the full file with fixes applied
\`\`\`
${operatingBlock}${postmortem.hasActivePostmortem ? `\n${postmortem.promptBlock}\n` : ""}${rejectedBlock}${ancestralBlock}${lessonsBlock}`;

      const refactorUser = `File: ${relPath}\n\n\`\`\`typescript\n${originalCode}\n\`\`\`\n${archContextBlock}\nFind real bugs, error handling gaps, input validation issues, performance problems, security risks, or dead code in this file. Fix them. If nothing needs fixing, return the file unchanged. Use the architecture context above (if present) to avoid breaking changes that would affect importing modules. Output the summary first, then the code.`;

      // ── VISUAL-POLISH MODE (audit 6 — the user flagged "still not
      //    enhancing its own ui look") ────────────────────────────────
      // The default refactor prompt forbids "cosmetic changes" and only
      // asks for bugs/security/dead-code. So even when the loop touches a
      // .tsx UI file, it makes null-safety fixes, never VISUAL changes
      // (styling, layout, accessibility, responsiveness). The visual-polish
      // mode flips the prompt: ask for presentation-layer improvements
      // only, preserve all functionality. Same gate chain applies
      // (typecheck catches broken JSX, structural-validator catches dropped
      // exports, mutation-guard catches evil tokens, debate evaluates
      // reasonableness) — so the safety net is unchanged, only the prompt
      // differs.
      const visualPolishSystem = `You are a senior frontend engineer improving a React/TypeScript UI component inside an autonomous self-improvement pipeline. Your changes will be typechecked and pushed to GitHub as the system's live state.

Your job: improve the VISUAL PRESENTATION and USER EXPERIENCE of this component. Do NOT fix bugs or change logic — other cycles handle that. Focus on:

1. STYLING CONSISTENCY: align spacing, padding, border-radius, font sizes with the surrounding design language. Use consistent Tailwind classes.
2. ACCESSIBILITY: add aria-labels for icon-only buttons, ensure focus-visible states, check color contrast (avoid gray-on-gray for important text), add sr-only labels where a screen reader needs context.
3. RESPONSIVE DESIGN: add mobile breakpoints (sm:, md:) where a layout would break on narrow screens. Ensure touch targets are ≥44px.
4. MICRO-INTERACTIONS: add hover/focus transitions (transition-colors, duration-150), subtle scale on active states for buttons. Keep transitions short (≤200ms).
5. VISUAL HIERARCHY: improve the information hierarchy — emphasize the primary action, de-emphasize secondary info, use consistent heading sizes.

HARD RULES (violating any rule fails the pipeline):
- Preserve EVERY top-level exported symbol (function, class, interface, type, const). Do not rename or remove them.
- Do NOT change any event handler logic, state management, or data flow. Only change className/style/presentation.
- Do NOT change the public API signature of any export (props, parameter names, types, return type must stay the same).
- Do NOT add header comments, banners, or branding.
- Keep changes focused — don't rewrite the whole file. Only improve the presentation.
- If the component already looks polished, output the original code unchanged.

OUTPUT FORMAT (mandatory):
- First, write a SHORT summary (1-5 bullet points) of what you changed and why. Start with "## Changes" on its own line.
- Then output the complete refactored code in a single fenced \`\`\`typescript block.
- Example:
## Changes
- Added aria-label to icon-only close button for screen readers
- Added focus-visible:ring-2 for keyboard navigation on all interactive elements
- Added sm: breakpoint so the card grid stacks on mobile
- Improved contrast of the secondary text from text-gray-400 to text-gray-300

\`\`\`typescript
// the full file with visual improvements applied
\`\`\`
${operatingBlock}${postmortem.hasActivePostmortem ? `\n${postmortem.promptBlock}\n` : ""}${rejectedBlock}${ancestralBlock}${lessonsBlock}`;

      const visualPolishUser = `File: ${relPath}\n\n\`\`\`typescript\n${originalCode}\n\`\`\`\n\nImprove the visual presentation, accessibility, and responsiveness of this UI component. Do NOT change any logic or functionality — only styling, aria attributes, responsive breakpoints, and micro-interactions. If it already looks polished, return the file unchanged. Output the summary first, then the code.`;

      const isVisualPolish = mode === "visual-polish";
      const activeSystem = isVisualPolish ? visualPolishSystem : refactorSystem;
      const activeUser = isVisualPolish ? visualPolishUser : refactorUser;

      const llmResult = await llmComplete({
        systemPrompt: activeSystem,
        userPrompt: activeUser,
        temperature: 0.2,
        onRetry: (info) => {
          const backoff = info.isRateLimit ? `${Math.round(info.delayMs / 1000)}s` : `${info.delayMs}ms`;
          this.log(`LLM retry attempt ${info.attempt}/${info.maxAttempts} (${info.isRateLimit ? "429" : "err"} — backing off ${backoff}) for enhance/${relPath}`, "info");
        },
      });

      result.llmLatencyMs = llmResult.latencyMs;

      if (!llmResult.ok) {
        // Fix A+B: the shared gate in agent-llm.ts handles 429 backoff. If
        // rateLimited is true, the call either returned instantly (gate was
        // already active) or just set the gate after 2 in-call retries. Either
        // way, DON'T do an additional per-file pause — the gate's cooldown is
        // the pause. Just defer and let the for-loop's gate check handle the
        // next file.
        if (llmResult.rateLimited) {
          const cd = llmCooldownMs();
          result.reason = `Deferred (LLM cooldown — ${Math.round(cd / 1000)}s)`;
          this.log(`Deferring enhance for ${relPath} — LLM on cooldown (${Math.round(cd / 1000)}s remaining)`, "warn");
        } else {
          // Non-rate-limit failure (network, parse, empty response).
          result.reason = `LLM unavailable: ${llmResult.error}`;
          this.log(`LLM unavailable for ${relPath}: ${llmResult.error}`, "warn");
        }
        return result;
      }

      // LLM succeeded — continue to verification

      // Extract the summary (what changed + why) AND the code from the response
      const { summary: changeSummary, code: refactoredCode } = extractSummaryAndCode(llmResult.content);
      // D4 (corpus): the transform signal — the first MEANINGFUL line of
      // the LLM's change summary (header skipped). Set BEFORE the gates so
      // rejected attempts carry them too (rejections are the corpus's main
      // signal).
      this.lastAttemptInfo.mutatedSha = refactoredCode ? sha16(refactoredCode) : null;
      this.lastAttemptInfo.transformSummary = firstMeaningfulLine(changeSummary);
      if (!refactoredCode || refactoredCode.trim().length === 0) {
        result.reason = "LLM returned no code";
        this.log(`LLM returned no code for ${relPath}`, "warn");
        return result;
      }

      // 3b. Mechanical guard: strip decorative banner comments the LLM
      // sometimes prepends to the code (defense-in-depth)
      const banner = this.stripBannerComments(refactoredCode);
      const cleanCode = banner.code;
      if (banner.stripped) {
        this.log(`Stripped decorative banner header from ${relPath} (LLM ignored the no-header rule)`, "warn");
      }

      result.llmUsed = true;
      result.newBytes = cleanCode.length;
      result.diffBytes = Math.abs(cleanCode.length - originalCode.length);

      // 3c. Detect truncated LLM output before the expensive typecheck.
      const truncation = this.checkTruncation(cleanCode, originalCode, filePath);
      if (truncation.truncated) {
        result.reason = `Rejected (LLM output truncated: ${truncation.reason})`;
        this.log(`Rejected ${relPath} (LLM output truncated: ${truncation.reason})`, "warn");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "COMPILE_ERROR",
          symptom: `LLM output truncated: ${truncation.reason}`,
          evidence: `Original: ${originalCode.length}b, Refactored: ${cleanCode.length}b. The LLM hit its output token limit before finishing.`,
          constraints: `The previous refactor of ${relPath} was truncated by the LLM's output limit. Make smaller, more targeted changes — do not rewrite the whole file.`,
        });
        // NOTE (audit 2): totalReverted is counted ONCE, in runCycle, for any
        // result whose reason starts with "Rejected" — the per-site increment
        // here double-counted truncation, debate and test-gate rejections.
        return result;
      }

      // 4. Check if anything actually changed
      if (cleanCode.trim() === originalCode.trim()) {
        result.reason = "No issues found";
        this.log(`No change for ${relPath} (LLM found no real issues to fix)`, "info");
        return result;
      }

      // 4a. SATURATION CHECK — if the only changes are comments/whitespace, it's
      // cosmetic churn. Skip the expensive typecheck + debate + test gates.
      // EMG's saturation protocol: "if already optimal, output NO_CHANGES_NEEDED."
      if (this.isCosmeticChange(originalCode, cleanCode)) {
        result.reason = "Skipped (only cosmetic changes — comments/whitespace)";
        this.log(`Skipped ${relPath} (cosmetic-only change — no real improvement)`, "info");
        return result;
      }

      // 5. Verify the refactored code IN MEMORY — nothing is written to disk
      // until it passes typecheck. This prevents Turbopack from ever seeing
      // broken code (the root cause of the stale browser error).
      this.log(`Verifying ${relPath} (in-memory typecheck)...`, "info");
      const verification = await this.verifyRefactor(filePath, cleanCode);
      result.compiled = verification.ok;

      if (!verification.ok) {
        // Refactor failed typecheck — do NOT write to disk. Turbopack never sees it.
        const errorSummary = verification.errors.slice(0, 3).join("; ");
        this.log(`Rejected ${relPath} (typecheck failed): ${errorSummary}`, "error");

        // Record postmortem so the next attempt gets warned
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "COMPILE_ERROR",
          symptom: `Refactored code failed in-memory typecheck: ${errorSummary}`,
          evidence: `Original: ${originalCode.length} bytes, Refactored: ${cleanCode.length} bytes. Errors: ${verification.errors.join("\n")}`,
          constraints: `The previous refactor of ${relPath} did not compile. Make smaller, safer changes. Preserve all type signatures exactly.`,
        });

        result.reason = "Rejected (typecheck failed — nothing written to disk)";
        return result;
      }

      // 5b. DEBATE GATE — a second LLM (Security + Architecture + Lead tribunal)
      // reviews the proposed refactor for semantic correctness. The typecheck
      // can't catch "added a null check that breaks the happy path." The debate
      // can. If REJECTED or REQUIRES_REWRITE, don't write.
      this.log(`Debating ${relPath} (second-LLM semantic review)...`, "info");
      const debate = await this.debateGate(filePath, originalCode, cleanCode, changeSummary);
      if (!debate.approved) {
        if (debate.deferred) {
          // Tribunal unavailable — fail-closed defer (see debateGate). Not a
          // rejection: no postmortem, no reverted count; reason starts with
          // "Deferred" so runCycle's deferred-counter tracks it.
          result.reason = `Deferred (debate tribunal unavailable — ${debate.reason.slice(0, 120)})`;
          this.log(`Deferring ${relPath} — debate tribunal unavailable, not auto-approving (fail-closed)`, "warn");
          return result;
        }
        this.log(`Rejected ${relPath} by debate: ${debate.reason}`, "warn");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "REVIEW_REJECTED",
          symptom: `Debate rejected the refactor: ${debate.reason}`,
          evidence: `Change summary: ${changeSummary.slice(0, 500)}`,
          constraints: `The previous refactor of ${relPath} was rejected by the debate tribunal (${debate.verdict}). Address the review feedback before retrying.`,
        });
        result.reason = `Rejected by debate (${debate.verdict})`;
        return result;
      }
      this.log(`Debate approved ${relPath}: ${debate.reason}`, "success");

      // 5c. TEST GATE — run any test files that cover this source file.
      // This is THE real signal (Direction 4): tests prove behavior was preserved.
      // Coverage is resolved tree-wide (findTestFilesFor); when a file has no
      // tests the gate passes with coverage:0, and that fact is recorded in
      // the log, the result, and the commit message — never silently.
      const testResult = await this.testGate(filePath, cleanCode);
      if (!testResult.passed) {
        this.log(`Rejected ${relPath} by test gate: ${testResult.reason}`, "warn");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "OTHER",
          symptom: `Test gate failed: ${testResult.reason}`,
          evidence: `${testResult.testCount} test file(s) checked. The refactor broke existing behavior.`,
          constraints: `The previous refactor of ${relPath} broke existing tests. Do not change observable behavior.`,
        });
        result.reason = `Rejected by test gate: ${testResult.reason}`;
        // totalReverted counted once in runCycle ("Rejected" prefix) — the
        // inline increment double-counted (audit 2).
        return result;
      }
      // HONEST COVERAGE RECORDING (external audit, finding 2): testCount is
      // threaded into the result and the commit message. A mutation that
      // went live with 0 test files says so permanently in git history —
      // "tsc verified, no behavioral tests" can never be misread as
      // "behavior was tested".
      result.testFilesRun = testResult.testCount;
      if (testResult.testCount > 0) {
        this.log(`Test gate passed for ${relPath}: ${testResult.reason}`, "success");
      } else {
        this.log(
          `Test gate: NO behavioral tests exist for ${relPath} — mutation verified by static gates + debate only (coverage: 0 test files)`,
          "warn"
        );
      }

      // 6. (audit 3 — F3/F6/F10) The live-write phase: highest blast radius.
      // Everything from here through the push is now:
      //   (a) STOPPABLE — run-token checkpoint BEFORE the live write. The
      //       write→push→hot-swap phase was previously unstoppable once the
      //       LLM call began (the only checkpoint was before the LLM call).
      //   (b) CONFLICT-CHECKED — the file on disk must still be the content
      //       this candidate was gated against (TOCTOU: a concurrent writer
      //       between the read at the top and this write would be silently
      //       clobbered by a candidate built from OLDER content).
      //   (c) EXCLUSIVE — the tree lock serializes against chat-task's
      //       applyTaskPlan (its rollback could previously revert a gated,
      //       already-pushed enhancement mid-flight).
      const coverageNote =
        testResult.testCount > 0
          ? `${testResult.testCount} test file(s) passed`
          : "no behavioral tests (static gates + debate only)";
      const commitMessage = changeSummary
        ? `Self-enhancement: ${relPath}\n\n${changeSummary}\n\n(tsc verified, ${coverageNote}, ${result.diffBytes}b diff)`
        : `Self-enhancement: ${relPath} (tsc verified, ${coverageNote}, ${result.diffBytes}b diff)`;
      type WriteOutcome =
        | { kind: "stopped" }
        | { kind: "conflict" }
        | { kind: "done"; pushed: boolean; commitSha?: string };
      const writeOutcome = await withTreeLock<WriteOutcome>(async () => {
        if (myRun !== this.runId) {
          this.log(`Aborting enhance for ${relPath} — stop requested before live write`, "warn");
          return { kind: "stopped" };
        }
        const diskNow = readFileSync(filePath, "utf-8");
        if (sha16(diskNow) !== sha16(originalCode)) {
          this.log(`CONFLICT: ${relPath} changed on disk while the gates ran — aborting instead of clobbering the concurrent write`, "error");
          await postmortemStore
            .recordFailure({
              repo: "self",
              branch: "main",
              filePath: relPath,
              failureType: "OTHER",
              symptom: `TOCTOU conflict on ${relPath}: disk content changed between read and gated write`,
              evidence: `gated-from sha ${sha16(originalCode)} vs on-disk sha ${sha16(diskNow)} — a concurrent writer (chat-task, operator edit, or host restore) landed mid-gate-chain`,
              constraints: `Re-read the current file before proposing changes — the disk state moved during the last gate chain; clobbering it would revert someone else's verified work.`,
              observed: false,
            })
            .catch(() => {
              /* best-effort scar */
            });
          return { kind: "conflict" };
        }
        // Typecheck passed — NOW it's safe to write the improved code to
        // the live file. Turbopack will hot-reload it and see only valid
        // code.
        writeFileSync(filePath, cleanCode, "utf-8");
        const pushOutcome = await this.gitPush(commitMessage);
        return { kind: "done", pushed: pushOutcome.pushed, commitSha: pushOutcome.commitSha };
      });
      if (writeOutcome.kind === "stopped") {
        result.reason = "Stopped before live write";
        return result;
      }
      if (writeOutcome.kind === "conflict") {
        result.reason = "Conflict — file changed on disk during enhancement";
        return result;
      }

      // 9. Enhancement succeeded — the file is now LIVE (hot-reload will pick it up)
      result.enhanced = true;
      result.reason = changeSummary ? "Enhanced and live" : "Enhanced and live (no summary)";
      this.stats.totalEnhanced++;
      this.stats.lastEnhancementAt = new Date().toISOString();
      result.pushed = writeOutcome.pushed;
      result.commitSha = writeOutcome.commitSha;

      // Log the enhancement WITH the change summary so you can see WHAT was fixed
      const shortSummary = changeSummary
        ? changeSummary.split("\n").slice(0, 3).join(" | ").slice(0, 200)
        : "no summary provided";
      this.log(`Enhanced ${relPath} (${result.diffBytes}b diff): ${shortSummary}`, "success");

      if (writeOutcome.pushed) {
        this.stats.totalPushed++;
        // Bump the per-cycle branch counter — this mutation now lives on
        // `loop-{thisN}` on the remote. The next enhanceFile will compute
        // `loop-{thisN+1}`. Failed attempts (this block not reached) leave
        // the counter untouched, so the next attempt reuses the same number.
        await setLastBranchNumber(thisN);
        this.log(`Mutation #${thisN} pinned to branch ${this.currentCycleBranch}`, "success");

        // ── BRANCH RETENTION (audit: branch accumulation) ───────────────
        // Each successful push pins a new loop-NN branch on the remote and
        // nothing deletes the old ones — the repo accumulates 100+ refs and
        // climbs. Fire-and-forget the retention drain here: it keeps the
        // most recent 50 mutation branches and prunes the rest, hysteresis-
        // gated so it's a no-op until the count crosses keep+margin. A prune
        // failure must NOT fail this enhancement (the commit + push already
        // succeeded; retention is housekeeping), mirroring the hot-swap below.
        void pruneOldLoopBranches({ keep: 50, margin: 10 })
          .then((pr) => {
            if (!pr.ran) return;
            const note = pr.rateLimited
              ? `Pruned ${pr.deleted.length} old branches, rate-limited with ${pr.failed.length} pending (floor loop-${pr.keepFloor})`
              : pr.failed.length
                ? `Pruned ${pr.deleted.length} old branches, ${pr.failed.length} failed (floor loop-${pr.keepFloor})`
                : `Pruned ${pr.deleted.length} old branches (kept ${pr.keep}, floor loop-${pr.keepFloor})`;
            this.log(note, pr.rateLimited || pr.failed.length ? "warn" : "info");
          })
          .catch((e) => {
            this.log(`Branch retention skipped: ${(e as Error).message.slice(0, 160)}`, "warn");
          });

        // ── POST-ENHANCEMENT SWAP (vestigial after worker split) ──────
        // The improved file is now on disk + GitHub. Pre-split, the
        // loop ran in the server process and called hotSwapPipeline()
        // here to clear the server's singleton pins so Turbopack's
        // recompiled module took effect on the next API request.
        //
        // After the worker split, this call would be a SELF-SUICIDE:
        // pauseLoop() in core/hot-swap.ts reads __selfEnhanceLoop from
        // globalThis (the worker's OWN pin) and calls sel.stop() on it,
        // bumping the run token and setting continuous=false. The
        // in-flight cycle bails at its next checkpoint AND the while-loop
        // exits — the worker's loop dies mid-enhancement. The server's
        // pins (__autonomousLoopRuntime, __unifiedPipelineRunner) are
        // untouched by a worker-side call anyway (separate process,
        // separate globalThis).
        //
        // Server-side module changes still take effect: Turbopack
        // recompiles changed files automatically, and the server's
        // hot-swap is operator-triggered via /api/hot-swap/trigger
        // (the loop's protected files — loop-runtime.ts, core/* — never
        // need a worker-driven swap because the worker can't mutate
        // them).
        //
        // The block is intentionally empty — kept as a marker so the
        // postmortem `operator-edit-module-reload.json` and the audit
        // trail stay legible.
        if (relPath.startsWith("src/lib/pipeline/") && myRun === this.runId) {
          // no-op since the worker split — see comment above
        }
      }

      // 11. Resolve any postmortem for this file
      await postmortemStore.markResolved("self", "main", relPath);

      return result;
    } catch (err) {
      result.reason = `Error: ${(err as Error).message}`;
      this.log(`Error enhancing ${relPath}: ${(err as Error).message}`, "error");
      return result;
    } finally {
      // Whether the enhancement succeeded, failed at a gate, or threw: clear
      // the per-mutation branch. The next enhanceFile computes a fresh one
      // from the (possibly incremented) counter.
      this.currentCycleBranch = null;
    }
  }

  /**
   * Fix B: stoppable sleep until the shared LLM rate-limit gate opens. Polls
   * every 1s so stop() (which bumps runId) is noticed within 1s instead of
   * blocking for the full cooldown (up to 30min). Returns true if the gate
   * cleared, false if stop was requested during the wait.
   */
  private async waitForCooldown(myRun: number): Promise<boolean> {
    let lastProgressLog = Date.now();
    while (this.continuous && myRun === this.runId) {
      const ms = llmCooldownMs();
      if (ms <= 0) return true; // gate clear
      const chunk = Math.min(ms, 1000);
      await new Promise((r) => setTimeout(r, chunk));
      // Periodic progress log during long pauses (every 60s) so the
      // terminal doesn't look frozen during a 30-min cooldown. The UI
      // chip counts down every second; this keeps the log stream honest.
      if (Date.now() - lastProgressLog >= 60_000) {
        this.log(`LLM pause ongoing — ${Math.round(ms / 1000)}s remaining`, "warn");
        lastProgressLog = Date.now();
      }
    }
    return false; // stop requested
  }

  /**
   * ── SCHEMA MUTATION PATH ─────────────────────────────────────────
   * prisma/schema.prisma — the system's own memory substrate, mutated
   * under the strictest gate in the pipeline. The tsc/AST/debate chain
   * doesn't apply (not TypeScript); instead:
   *
   *   1. Postmortem check (same as files — the schema can carry scars)
   *   2. Lesson injection (same as files — compounding applies here too)
   *   3. LLM proposes an ADDITIVE change (new model or new defaulted
   *      field — the prompt states the contract)
   *   4. schema-gate: additive-only structural diff → prisma validate →
   *      db push → canary round-trip → auto-revert on any failure
   *   5. Debate gate on the semantic question (does this model make
   *      sense?) — AFTER the schema gate, so a bad structure never
   *      even reaches the tribunal
   *   6. Pass → commit + push like any other mutation
   *
   * The schema-gate's protected-model list (Postmortem, Lesson, etc.)
   * means the loop can GROW its memory but never EDIT or FORGET it.
   */
  private async enhanceSchema(filePath: string, myRun: number): Promise<SelfEnhanceResult> {
    const relPath = relative(PROJECT_ROOT, filePath);
    // Same branch contract as enhanceFile: this mutation targets
    // loop-{N+1}, bumped only on successful push.
    const lastN = await getLastBranchNumber();
    const thisN = lastN + 1;
    this.currentCycleBranch = formatLoopBranch(thisN);
    this.log(`Branch for this mutation: ${this.currentCycleBranch}`, "info");
    const result: SelfEnhanceResult = {
      filePath: relPath,
      enhanced: false,
      reason: "",
      oldBytes: 0,
      newBytes: 0,
      diffBytes: 0,
      llmUsed: false,
      llmLatencyMs: 0,
      compiled: false,
      pushed: false,
    };
    this.lastLessonIds = [];

    try {
      const original = readFileSync(filePath, "utf-8");
      result.oldBytes = original.length;
      // D4 (corpus): same provenance scratch as the file path.
      this.lastAttemptInfo = {
        originalSha: sha16(original),
        mutatedSha: null,
        transformSummary: null,
        branchNumber: thisN,
      };
      if (original.length > 12000) {
        result.reason = `Skipped (file too large: ${original.length}b)`;
        this.log(`Skipped ${relPath} (${original.length}b — too large for LLM)`, "info");
        return result;
      }

      // LLM gate check — same contract as the file path.
      const cd = llmCooldownMs();
      if (cd > 0) {
        result.reason = `Deferred (LLM cooldown — ${Math.round(cd / 1000)}s)`;
        this.log(`Deferring schema mutation — LLM on cooldown (${Math.round(cd / 1000)}s)`, "warn");
        return result;
      }

      // Postmortem constraints — the schema can fail too (a past
      // proposal that broke validate leaves a scar).
      const postmortem = await postmortemStore.getConstraintsForFile("self", "main", relPath);

      // Lessons — compounding applies to schema proposals as well.
      // D2 two-track, same as the file path: promoted procedures ride
      // the Operating Constraints block, the rest the bounded block.
      let operatingBlock = "";
      let lessonsBlock = "";
      try {
        const promoted: LessonRow[] = await getPromotedProcedures();
        const ls = await getLessonsForPrompt();
        const all = [...promoted, ...ls];
        if (all.length > 0) {
          this.lastLessonIds = all.map((x) => x.id);
          operatingBlock = formatOperatingConstraintsBlock(promoted);
          lessonsBlock = formatLessonsBlock(ls);
          await markInjected(this.lastLessonIds);
        }
      } catch {
        /* amplifier, not a gate */
      }

      // Negative constraints (RAS graft) — schema-rejected proposals
      // ride the same per-file block. Schema attempts are recorded in
      // the corpus with relPath "prisma/schema.prisma" (runCycle records
      // every enhanceFile result, and the schema path returns through
      // it), so rejected schema transforms accumulate here too.
      let rejectedBlock = "";
      try {
        const rejected = await getRejectedTransformsForFile(relPath);
        rejectedBlock = formatRejectedTransformsBlock(rejected);
        if (rejectedBlock) {
          this.log(
            `Injecting ${rejected.length} rejected-transform constraint(s) for schema (corpus negative constraints)`,
            "info"
          );
        }
      } catch {
        /* amplifier, not a gate */
      }

      this.log(`Proposing schema mutation for ${relPath}...`, "info");
      const system = `You are modifying the Prisma schema of a self-improving system — the schema IS the system's memory. This is the most dangerous file you can touch.

THE CONTRACT (the gate enforces this mechanically — violations are auto-reverted):
- ADDITIVE ONLY: you may ADD a whole new model block, or ADD new fields to an existing NON-PROTECTED model.
- New fields MUST be nullable (?) or carry @default() — existing rows must backfill.
- NEVER: remove a model, remove/rename a field, change a field type, touch the Postmortem/Lesson/GitPushTarget/LlmConfig/Prophecy/SystemFlag models, or edit the generator/datasource blocks.

A GOOD schema mutation:
- Adds a model the system's own pipeline would genuinely use (e.g. a new tracking table that some existing pipeline stage could read/write)
- Has a clear purpose stated in a /// doc comment on the model
- Uses sensible Prisma types + @default values

A BAD schema mutation:
- Renames or "cleans up" anything (destructive — instant revert)
- Adds a model nothing will ever read (dead weight)
- Duplicates an existing model's purpose

If there is NO genuinely useful additive change to make, output the original schema unchanged.

OUTPUT FORMAT:
First a SHORT summary starting with "## Changes", then the COMPLETE schema in a single \`\`\`prisma fenced block.
${operatingBlock}${postmortem.hasActivePostmortem ? `\n${postmortem.promptBlock}\n` : ""}${rejectedBlock}${lessonsBlock}`;

      const user = `Current prisma/schema.prisma:\n\n\`\`\`prisma\n${original}\n\`\`\`\n\nPropose an additive-only improvement, or return it unchanged if none is genuinely useful.`;

      const llmResult = await llmComplete({
        systemPrompt: system,
        userPrompt: user,
        temperature: 0.2,
        onRetry: (info) => {
          this.log(`LLM retry ${info.attempt}/${info.maxAttempts} (${info.isRateLimit ? "429" : "err"}) for schema mutation`, "info");
        },
      });
      result.llmLatencyMs = llmResult.latencyMs;

      if (!llmResult.ok) {
        if (llmResult.rateLimited) {
          const cd2 = llmCooldownMs();
          result.reason = `Deferred (LLM cooldown — ${Math.round(cd2 / 1000)}s)`;
          this.log(`Deferring schema mutation — LLM on cooldown`, "warn");
        } else {
          result.reason = `LLM unavailable: ${llmResult.error}`;
          this.log(`LLM unavailable for schema: ${llmResult.error}`, "warn");
        }
        return result;
      }

      if (myRun !== this.runId) {
        result.reason = "Stopped during schema proposal";
        return result;
      }

      const { summary: changeSummary, code: proposed } = extractSummaryAndCode(llmResult.content);
      // D4 (corpus): schema attempts carry the same transform signal.
      this.lastAttemptInfo.mutatedSha = proposed ? sha16(proposed) : null;
      this.lastAttemptInfo.transformSummary = firstMeaningfulLine(changeSummary);
      if (!proposed || proposed.trim().length === 0) {
        result.reason = "LLM returned no schema";
        return result;
      }
      if (proposed.trim() === original.trim()) {
        result.reason = "No issues found";
        this.log(`No schema change proposed (LLM found nothing worth adding)`, "info");
        return result;
      }
      result.llmUsed = true;
      result.newBytes = proposed.length;
      result.diffBytes = Math.abs(proposed.length - original.length);

      // ── DEBATE FIRST (audit 3, F2): the tribunal reviews the proposal
      // BEFORE anything is written. The old order (apply → canary → debate
      // → "revert") was broken twice over: the schema went live in file +
      // SQLite before semantic review, and the revert call itself was
      // rejected by applySchemaMutation's additive-only gate (removing the
      // just-added model reads as "destructive") — so a REJECTED proposal
      // stayed live until the next unrelated `git add -A` swept it in.
      const debate = await this.debateGate(filePath, original, proposed, changeSummary);
      if (!debate.approved) {
        if (debate.deferred) {
          // Tribunal unavailable — fail-closed, nothing was applied.
          result.reason = `Deferred (debate tribunal unavailable)`;
          this.log(`Deferring schema mutation — tribunal unavailable, nothing applied`, "warn");
          return result;
        }
        this.log(`Rejected by debate (nothing applied): ${debate.reason}`, "warn");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "REVIEW_REJECTED",
          symptom: `Debate rejected the schema change: ${debate.reason.slice(0, 160)}`,
          evidence: `Change summary: ${changeSummary.slice(0, 400)}`,
          constraints: `The previous schema change was rejected by the debate tribunal. Only propose models the pipeline genuinely needs.`,
        });
        result.reason = `Rejected by debate (${debate.verdict})`;
        return result;
      }

      // ── THE SCHEMA GATE: additive check → validate → push → canary ──
      // Debate approved — now apply. On any step-2+ failure (validate/db
      // push/canary) applySchemaMutation restores the ORIGINAL file and
      // re-pushes it internally, so the live DB and file never desync.
      this.log(`Schema gate: checking additive-only diff...`, "info");
      const gate = await applySchemaMutation(proposed);
      if (!gate.ok) {
        this.log(`Rejected schema mutation: ${gate.reason}`, "warn");
        await postmortemStore.recordFailure({
          repo: "self",
          branch: "main",
          filePath: relPath,
          failureType: "OTHER",
          symptom: `Schema gate rejected: ${gate.reason.slice(0, 160)}`,
          evidence: `Proposal ${proposed.length}b vs original ${original.length}b. ${gate.reason}`,
          constraints: `The previous schema proposal was rejected by the additive-only gate. Only NEW models or NEW defaulted/nullable fields on non-protected models are allowed. Never remove, rename, or retype anything.`,
        });
        result.reason = `Rejected by schema gate (${gate.reason.slice(0, 80)})`;
        return result;
      }
      result.compiled = true; // gate chain (validate+push+canary) passed
      this.log(`Schema gate PASSED: ${gate.reason}`, "success");

      // ── PASSED — the schema is live. Commit + push like any mutation. ──
      result.enhanced = true;
      result.reason = changeSummary ? "Enhanced and live" : "Enhanced and live (no summary)";
      this.stats.totalEnhanced++;
      this.stats.lastEnhancementAt = new Date().toISOString();
      const shortSummary = changeSummary
        ? changeSummary.split("\n").slice(0, 3).join(" | ").slice(0, 200)
        : "no summary provided";
      this.log(`Enhanced ${relPath} (${result.diffBytes}b diff): ${shortSummary}`, "success");

      const commitMessage = changeSummary
        ? `Self-enhancement: ${relPath}\n\n${changeSummary}\n\n(schema gate verified, no behavioral tests — additive gate + debate only, ${result.diffBytes}b diff)`
        : `Self-enhancement: ${relPath} (schema gate verified, no behavioral tests — additive gate + debate only, ${result.diffBytes}b diff)`;
      const pushResult = await this.gitPush(commitMessage);
      result.pushed = pushResult.pushed;
      result.commitSha = pushResult.commitSha;
      if (pushResult.pushed) {
        this.stats.totalPushed++;
        await setLastBranchNumber(thisN);
        this.log(`Schema mutation pinned to branch ${this.currentCycleBranch}`, "success");
      } else {
        // The schema is LIVE locally but the remote proof didn't land
        // (external audit, finding 5). This is a real divergence: the
        // running system has a schema the remote can't reproduce until the
        // next successful push carries it (pushCurrentState commits even
        // when the push itself fails, so the change is at least in local
        // git). Record it as a system postmortem so the divergence is in
        // the audit trail instead of only the console log.
        this.log(`Schema push did not land (no changes or push declined) — schema file is still live, only the remote proof is missing`, "warn");
        await postmortemStore
          .recordFailure({
            repo: "self",
            branch: "main",
            filePath: "system:schema-push",
            failureType: "OTHER",
            symptom: `Schema mutation is live locally but the push did not land${pushResult.commitSha ? ` (local commit ${pushResult.commitSha.slice(0, 8)} exists, remote missing it)` : " (not even a local commit landed)"}`,
            evidence: `Schema gate + debate approved the change for ${relPath}, but gitPush returned pushed:false. The running system and the remote repo have diverged until the next successful push.`,
            constraints: `A schema mutation went live without remote proof. Before proposing another schema change, check git log/status — the pending change will ride the next successful push; do not re-apply the same additive change blindly.`,
          })
          .catch(() => {
            /* postmortem is best-effort here — the warn log above still fired */
          });
      }

      return result;
    } catch (e) {
      result.reason = `Error: ${(e as Error).message}`;
      this.log(`Schema mutation error: ${(e as Error).message}`, "error");
      return result;
    }
  }

  /** Classify a cycle outcome for one file and advance its saturation
   *  state. Shared by the normal post-enhancement path AND the
   *  proactive-skip path — both must advance the counter, or a converged
   *  repo can never reach the PASS COMPLETE checkpoint (the skip path
   *  used to `continue` before the saturation update, so self-model-
   *  predicted files were re-skipped forever and classifyGrowth's
   *  documented "clean PASS COMPLETE signal" was dead code). */
  private async advanceSaturation(relPath: string, reason: string): Promise<void> {
    const growth = classifyGrowth(reason);
    const prev = this.saturation.get(relPath) ?? {
      consecutiveNoGrowth: 0,
      lockedOut: false,
      lockedAt: null,
      lastNoGrowthReason: null,
      enhancementsThisPass: 0,
    };
    if (growth === "growth") {
      prev.consecutiveNoGrowth = 0;
      prev.lastNoGrowthReason = null;
      prev.enhancementsThisPass++;
    } else if (growth === "no-growth") {
      prev.consecutiveNoGrowth++;
      prev.lastNoGrowthReason = reason;
      // D8: the lockout threshold is meta-tunable — read the live value.
      const threshold = await getSaturationThreshold();
      if (prev.consecutiveNoGrowth >= threshold && !prev.lockedOut) {
        prev.lockedOut = true;
        prev.lockedAt = new Date().toISOString();
        this.log(
          `🔒 ${relPath} LOCKED OUT — ${threshold} consecutive no-growth cycles (last: ${reason.slice(0, 80)})`,
          "warn"
        );
        this.log(
          `Pass will skip ${relPath} until you unlock it (UI button) or restart the server for a fresh pass`,
          "info"
        );
      }
    }
    this.saturation.set(relPath, prev);
  }

  /**
   * Run one cycle: scan files, enhance each one sequentially.
   */
  async runCycle(): Promise<{ filesScanned: number; filesEnhanced: number; results: SelfEnhanceResult[] }> {
    if (this.running) {
      // Don't log — the continuous runner polls runCycle and this is normal
      return { filesScanned: 0, filesEnhanced: 0, results: [] };
    }
    // Audit 3 (F1): safe-mode is the emergency brake for THIS loop — the
    // one that writes live source and pushes. A raised flag (red-team
    // bypass, gate-integrity failure, duress purge, push-failure circuit
    // breaker) means the defense layer judged the mutation path
    // untrustworthy: refuse the cycle, loudly.
    if (isSafeMode()) {
      this.log("SAFE-MODE active — self-enhancement cycle refused (clear via the Duress panel after review)", "error");
      return { filesScanned: 0, filesEnhanced: 0, results: [] };
    }
    this.running = true;
    this.currentFile = null;
    // Capture this cycle's generation. stop() increments runId; if it fires
    // mid-cycle, the for-loop below sees `myRun !== this.runId` and breaks.
    const myRun = this.runId;

    // Durable-stats gate: the first cycle after a boot waits here until
    // the persisted counters (or the one-time DB seed) have landed, so a
    // fast cycle can never persist zeros over a hydrate mid-flight.
    await this.statsReady;

    // ── TEST-GATE CRASH RECOVERY (external audit, finding 1) ──────────
    // The test gate now runs candidates in a SANDBOX (core/sandbox-test.ts)
    // and never writes them live — so a crash can no longer strand one. But
    // a journal armed by the PRE-SANDBOX implementation may still exist on
    // disk from an old crash: restore BEFORE this cycle scans or pushes
    // anything, so a legacy stranded candidate can neither be built upon
    // nor swept into a commit.
    {
      const recovery = recoverCrashedTestGate();
      if (recovery.recovered) {
        this.log(
          `TEST-GATE CRASH RECOVERY at cycle start: restored original ${relative(PROJECT_ROOT, recovery.filePath ?? "")} (journal armed ${recovery.armedAt ?? "unknown"}) — a pre-sandbox test run crashed with the candidate live`,
          "error"
        );
      } else if (recovery.alreadyIntact) {
        this.log(
          `TEST-GATE CRASH RECOVERY at cycle start: journal was armed for ${relative(PROJECT_ROOT, recovery.filePath ?? "")} but disk already matched the original (candidate never landed) — journal cleared`,
          "warn"
        );
      }
    }

    try {
      // ── SelfTask drain (audit 5 — ZERO_DIFF_SATURATION mitigation) ──
      // The whole-file refactor path hits zero-diff on files that are
      // "finished" (no bugs, no missing error handling — the LLM correctly
      // returns them unchanged). The SelfTask pipeline (self-task-
      // generator.ts + task-executor.ts) queues CONCRETE findings (todo
      // comments, empty catches, any-usage, missing return types, unused
      // imports, magic numbers, non-null assertions) that cannot zero-
      // diff by construction: the deterministic kinds (missing-return-type,
      // unused-import) produce a guaranteed non-trivial text change
      // verified by in-memory typecheck. The LLM kinds have a much
      // narrower prompt (one file, one issue, one instruction) than the
      // whole-file "find anything to fix" prompt.
      //
      // This pre-pass drains up to SELF_TASKS_PER_CYCLE tasks BEFORE the
      // whole-file scan. Each applied task is written live + pushed via
      // the same gitPush() path as a successful enhanceFile, so the
      // existing commit-archaeology, secret-scan, and branch-retention
      // machinery all apply. Best-effort by design — a SelfTask failure
      // never fails the cycle (the whole-file scan still runs after).
      //
      // WHY DETERMINISTIC-FIRST: claimNextTask(true) restricts to the
      // checker-inferred kinds (no LLM call) so the drain makes forward
      // progress even when the LLM gate is cooling down. The perf concern
      // (task-executor builds a fresh ts.Program per task, ~10s) is
      // amortized by the small cap — 3 tasks per cycle adds ~30s, well
      // under the cycle's existing LLM latency.
      const SELF_TASKS_PER_CYCLE = 3;
      const selfTaskResults: SelfEnhanceResult[] = [];
      try {
        // Refresh the task queue every 25th cycle (generateTasks scans
        // all source files with the TS compiler — too expensive to run
        // every cycle, but without it the drain would have no tasks to
        // consume after the initial queue is drained). Matches the
        // MutationCorpus / retention prune throttle pattern.
        const cycleNow = this.stats.cyclesCompleted;
        if (cycleNow % 25 === 0) {
          try {
            const scan = await generateTasks();
            if (scan.newTasks > 0) {
              this.log(`SelfTask rescan: ${scan.filesAnalyzed} files, ${scan.findings} findings, ${scan.newTasks} new tasks`, "info");
            }
          } catch {
            /* best-effort — the drain can work with the existing queue */
          }
        }
        for (let i = 0; i < SELF_TASKS_PER_CYCLE; i++) {
          if (myRun !== this.runId) break;
          if (isSafeMode()) break;
          // Prefer deterministic tasks (no LLM, zero-diff-immune). Fall
          // back to LLM tasks only if the deterministic queue is empty
          // AND the LLM gate is open.
          let task = await claimNextTask(true).catch(() => null);
          if (!task && llmCooldownMs() === 0) {
            task = await claimNextTask(false).catch(() => null);
          }
          if (!task) break; // queue empty — proceed to whole-file scan

          const filePath: string = task.filePath;
          const kind: string = task.kind;
          this.currentFile = filePath;
          this.log(`SelfTask[${kind}] claimed: ${filePath}:${task.line}`, "info");

          const exec: TaskExecutionResult = await executeTask({
            id: task.id,
            kind: task.kind,
            filePath: task.filePath,
            line: task.line,
            evidence: task.evidence ?? "",
            attempts: task.attempts ?? 0,
          }).catch((e): TaskExecutionResult => ({
            status: "failed",
            method: "llm",
            summary: `executor threw: ${(e as Error).message}`,
          }));

          if (exec.status === "applied" && exec.newCode) {
            const abs = join(PROJECT_ROOT, filePath);
            const relPath = relative(PROJECT_ROOT, abs);
            let candidate = exec.newCode;
            // ── FULL GATE CHAIN for LLM-produced fixes (external audit F1) ──
            // The SelfTask path previously went truncation → syntax →
            // typecheck → LIVE WRITE, skipping the structural validator,
            // mutation guard, debate tribunal and behavioral test gate that
            // enhanceFile runs. A SelfTask fix is smaller, but it is still
            // an LLM rewrite of a live file: it can drop exports
            // (structural), smuggle evil tokens (mutation-guard), or
            // subtly change behavior (debate + tests). Deterministic kinds
            // (missing-return-type, unused-import) are checker-driven
            // insertions/removals that cannot drop exports or add tokens —
            // for those, executeTask's in-memory typecheck plus the guarded
            // write below is the proportionate gate set.
            if (exec.method === "llm") {
              // Banner strip (same defense-in-depth as enhanceFile 3b)
              const banner = this.stripBannerComments(candidate);
              if (banner.stripped) {
                this.log(`SelfTask[${kind}] stripped decorative banner from ${relPath} (LLM ignored the no-header rule)`, "warn");
              }
              candidate = banner.code;
              if (exec.baseCode !== undefined && candidate.trim() === exec.baseCode.trim()) {
                await this.updateTask(task.id, { status: "skipped", lastError: "LLM fix was banner-only (no real change)" });
                this.log(`SelfTask[${kind}] no-op: banner-only change, nothing to write`, "info");
                continue;
              }
              // Structural validator + mutation guard + AST retention
              // (verifyRefactor bundles them; candidate passed via stdin,
              // nothing touches disk). Also re-typechecks — executeTask
              // already did, but the banner strip changed the content.
              const verification = await this.verifyRefactor(abs, candidate);
              if (!verification.ok) {
                await this.updateTask(task.id, {
                  status: "failed",
                  lastError: `structural/mutation gate rejected: ${verification.errors.slice(0, 2).join(" | ").slice(0, 250)}`,
                });
                this.log(`SelfTask[${kind}] rejected by structural/mutation gates: ${verification.errors[0]?.slice(0, 120)}`, "warn");
                continue;
              }
              // Debate tribunal — fail-closed on unavailability (same
              // contract as the ratchet: a deferred task is requeued, not
              // counted as a failure or auto-approved).
              const debate = await this.debateGate(abs, exec.baseCode ?? "", candidate, `self-task ${kind} fix: ${exec.summary.slice(0, 180)}`);
              if (!debate.approved) {
                if (debate.deferred) {
                  await this.updateTask(task.id, { status: "pending", deferred: 1 });
                  this.log(`SelfTask[${kind}] deferred: debate tribunal unavailable, not auto-approving (fail-closed)`, "warn");
                } else {
                  await this.updateTask(task.id, { status: "failed", lastError: `debate rejected: ${debate.reason.slice(0, 200)}` });
                  this.log(`SelfTask[${kind}] rejected by debate: ${debate.reason.slice(0, 120)}`, "warn");
                }
                continue;
              }
              // Behavioral test gate — co-located tests must still pass.
              const testResult = await this.testGate(abs, candidate);
              if (!testResult.passed) {
                await this.updateTask(task.id, { status: "failed", lastError: `test gate failed: ${testResult.reason.slice(0, 200)}` });
                this.log(`SelfTask[${kind}] rejected by test gate: ${testResult.reason.slice(0, 120)}`, "warn");
                continue;
              }
            }
            // ── GUARDED LIVE WRITE (external audit F1: the concurrent-write
            // hole) — same three protections as enhanceFile's phase 6:
            //   (a) STOP checkpoint before the write (a stop() during the
            //       executor or the gates above must not still land a write),
            //   (b) TOCTOU disk-conflict check — the disk content must still
            //       be what this fix was computed against (exec.baseCode);
            //       a concurrent writer between executeTask's read and this
            //       write would otherwise be silently clobbered,
            //   (c) the tree lock, serializing against chat-task rollback.
            const pushMsg = `self-task[${kind}]: ${relPath}:${task.line} — ${exec.summary.slice(0, 120)}`;
            type SelfTaskWriteOutcome =
              | { kind: "stopped" }
              | { kind: "conflict"; diskSha?: string; diskError?: string }
              | { kind: "write-failed"; error: string }
              | { kind: "done"; pushed: boolean; commitSha?: string };
            const writeOutcome = await withTreeLock<SelfTaskWriteOutcome>(async () => {
              if (myRun !== this.runId) {
                return { kind: "stopped" };
              }
              // The target file may have been DELETED (not just changed)
              // during the 1–3-minute gate chain above. The old unguarded
              // readFileSync threw here, escaped withTreeLock, was
              // swallowed by the drain's outer catch, and the claimed task
              // was never updated — a permanent in_progress zombie that
              // claimNextTask (pending-only) never re-queues.
              let diskNow: string;
              try {
                diskNow = readFileSync(abs, "utf-8");
              } catch (rErr) {
                return { kind: "conflict", diskSha: undefined, diskError: (rErr as Error).message };
              }
              if (exec.baseCode !== undefined && sha16(diskNow) !== sha16(exec.baseCode)) {
                return { kind: "conflict", diskSha: sha16(diskNow) };
              }
              try {
                writeFileSync(abs, candidate, "utf-8");
              } catch (wErr) {
                return { kind: "write-failed", error: (wErr as Error).message };
              }
              const push = await this.gitPush(pushMsg);
              return { kind: "done", pushed: push.pushed, commitSha: push.commitSha };
            });
            if (writeOutcome.kind === "stopped") {
              await this.updateTask(task.id, { status: "pending", lastError: "stop requested before live write — requeued" });
              this.log(`SelfTask[${kind}] aborted: stop requested before live write (task requeued)`, "warn");
              continue;
            }
            if (writeOutcome.kind === "conflict") {
              await postmortemStore
                .recordFailure({
                  repo: "self",
                  branch: "main",
                  filePath: relPath,
                  failureType: "OTHER",
                  symptom: `TOCTOU conflict on ${relPath}: disk content changed between the SelfTask read and its gated write`,
                  evidence: `fix computed against sha ${sha16(exec.baseCode ?? "")} vs on-disk sha ${writeOutcome.diskSha ?? `(unreadable: ${writeOutcome.diskError ?? "missing"})`} — a concurrent writer (chat-task, operator edit, host restore, or file deletion) landed while the SelfTask gates ran`,
                  constraints: `Re-read the current file before proposing changes — the disk state moved during the last SelfTask gate chain; clobbering it would revert someone else's work.`,
                  observed: false,
                })
                .catch(() => {
                  /* best-effort scar */
                });
              await this.updateTask(task.id, { status: "pending", lastError: "TOCTOU conflict — disk changed during gates; requeued" });
              this.log(`CONFLICT: ${relPath} changed on disk while the SelfTask gates ran — requeued instead of clobbering`, "error");
              continue;
            }
            if (writeOutcome.kind === "write-failed") {
              await this.updateTask(task.id, { status: "failed", lastError: `write failed: ${writeOutcome.error}` });
              this.log(`SelfTask[${kind}] write failed: ${writeOutcome.error}`, "warn");
              continue;
            }
            const push = { pushed: writeOutcome.pushed, commitSha: writeOutcome.commitSha };
            if (push.pushed) {
              this.stats.totalEnhanced++;
              this.stats.totalPushed++;
              // Durable tier: the SelfTask drain runs before the per-file
              // loop, and a stop-aborted cycle skips the cycle-end persist —
              // persist here so a task's counters survive an abort.
              this.persistStats();
              await this.updateTask(task.id, {
                status: "done",
                fixSummary: exec.summary.slice(0, 500),
                commitSha: push.commitSha,
              });
              selfTaskResults.push({
                filePath: relPath,
                enhanced: true,
                reason: `SelfTask[${kind}]: ${exec.summary.slice(0, 100)}`,
                oldBytes: 0,
                newBytes: candidate.length,
                diffBytes: candidate.length,
                llmUsed: exec.method === "llm",
                llmLatencyMs: 0,
                compiled: true,
                pushed: true,
                commitSha: push.commitSha,
              });
              this.log(`SelfTask[${kind}] applied + pushed: ${relPath} — ${exec.summary.slice(0, 80)}`, "success");
              // (Post-selftask hot-swap was a self-suicide after the worker
              // split — pauseLoop() would call sel.stop() on the worker's
              // own __selfEnhanceLoop. Removed; the server picks up the
              // deterministic fix via Turbopack HMR on the next request, and
              // protected singletons are operator-triggered via
              // /api/hot-swap/trigger.)
            } else {
              // Commit didn't land (push failed). Revert the live write
              // so the working tree doesn't drift from the committed state.
              try { execSync(`git checkout -- ${relPath}`); } catch { /* best-effort */ }
              await this.updateTask(task.id, { status: "pending", lastError: `push failed: ${exec.summary.slice(0, 100)}` });
              this.log(`SelfTask[${kind}] push failed for ${relPath} — reverted, task re-queued`, "warn");
            }
          } else if (exec.status === "no-op") {
            await this.updateTask(task.id, { status: "skipped", lastError: exec.summary });
            this.log(`SelfTask[${kind}] no-op: ${exec.summary.slice(0, 80)}`, "info");
          } else if (exec.status === "deferred") {
            await this.updateTask(task.id, { status: "pending", deferred: 1 });
            this.log(`SelfTask[${kind}] deferred: ${exec.summary.slice(0, 80)}`, "info");
          } else {
            // failed
            await this.updateTask(task.id, { status: "failed", lastError: exec.error ?? exec.summary });
            this.log(`SelfTask[${kind}] failed: ${(exec.error ?? exec.summary).slice(0, 80)}`, "warn");
          }
        }
      } catch (drainErr) {
        // The SelfTask drain is best-effort — a failure here must NOT
        // prevent the whole-file scan from running.
        this.log(`SelfTask drain error (non-fatal): ${(drainErr as Error).message.slice(0, 120)}`, "warn");
      }
      // Merge SelfTask results into the cycle's result list so the UI
      // and stats reflect them.
      if (selfTaskResults.length > 0) {
        // (the cycle return is built at the end of runCycle; we stash
        //  these on the instance via a field so the return path can pick
        //  them up. See the return statement near the end of runCycle.)
        (this as unknown as { _selfTaskResults?: SelfEnhanceResult[] })._selfTaskResults = selfTaskResults;
      }

      // ── Pause-before-scan (rate-limit gate) ──────────────────────────
      // If the shared LLM gate is active at cycle start, pause the WHOLE
      // cycle until it clears — do NOT scan and iterate files. Previously
      // the loop iterated all ~17 files during a cooldown: each file's
      // ratchet made a real LLM call that 429'd and RE-ESCALATED the gate
      // (2→5→15→30min) within a single cycle, then the per-file wait slept
      // the new cooldown, then the next file did it again. That churned
      // 4× 429s and 50+ min of waiting into one cycle. Now: one pause at
      // the top, then a fresh scan when the gate opens. Mid-cycle gate
      // escalations (a file's ratchet 429s) BREAK the for-loop so the next
      // cycle's start-pause handles the wait — one 429 per cooldown window.
      // Manual one-shot cycles skip this (continuous=false) and defer fast
      // at the enhanceFile checkpoint instead.
      if (this.continuous) {
        const cdAtStart = llmCooldownMs();
        if (cdAtStart > 0) {
          this.log(`LLM rate-limited — pausing cycle ${Math.round(cdAtStart / 1000)}s until cooldown clears (countdown in UI)`, "warn");
          const cleared = await this.waitForCooldown(myRun);
          if (!cleared) {
            this.log("Stop during cycle-start pause — cycle aborted", "warn");
            return { filesScanned: 0, filesEnhanced: 0, results: [] };
          }
          this.log("LLM cooldown cleared — starting cycle", "success");
        }
      }

      const scanned = this.scanFiles();
      // Cumulative scan count — increments every cycle so the counter visibly
      // moves (was `= files.length`, frozen at 16 forever, looked broken).
      this.stats.totalScanned += scanned.length;
      this.log(`Scanned ${scanned.length} files in src/lib/pipeline/`, "info");

      // ── BANDIT TARGET ORDERING (audit 7 — "priority-weighted file
      //    selection", the cognitive core) ──────────────────────────────
      // The self-model's UCB1 bandit reorders candidates by:
      //   empirical success rate (Laplace-smoothed)
      //   + exploration bonus (untried files get a look)
      //   + recency bonus (long-untouched files resurface)
      //   - exhaustion penalty (files that keep zero-diffing sink)
      // This replaces the old alphabetical tree-order scan with actual
      // DECISION-MAKING. The bandit self-explains its top 3 picks in the
      // log ("🧠 target: X — score 0.62 (3/5 passed, 14d untouched, ...)")
      // so the loop's reasoning is visible. Focus mode (TARGET_FILES
      // non-empty) respects the operator's named order — the bandit only
      // reorders full-scope scans. Degrades to tree order if the self-
      // model table is missing.
      let files = scanned;
      if (TARGET_FILES.length === 0 && scanned.length > 1) {
        try {
          const { ordered } = await orderTargetsByBandit(scanned, PROJECT_ROOT, (line, level) => this.log(line, level));
          files = ordered;
        } catch {
          /* self-model unavailable — tree order */
        }
      }
      // ── VISUAL-POLISH PRE-PASS (audit 6 — "still not enhancing its own
      //    ui look") ────────────────────────────────────────────────────
      // Every VISUAL_POLISH_INTERVAL cycles, pick one .tsx UI component
      // from src/components/pipeline/ and run it through the visual-polish
      // prompt (styling/accessibility/responsive/micro-interactions) BEFORE
      // the whole-file bug-hunt scan. The default refactor prompt forbids
      // cosmetic changes, so without this pre-pass the loop only ever
      // makes null-safety fixes to UI files — never visual improvements.
      // Same gate chain (typecheck + structural-validator + mutation-guard
      // + debate) applies; only the prompt differs.
      const VISUAL_POLISH_INTERVAL = 5;
      // Skip-probe sampling rate: every 4th proactive skip spends the LLM
      // call anyway (see the skip block below) — 25% sampling scores the
      // skip rule while the other 75% still save the quota.
      const SKIP_PROBE_INTERVAL = 4;
      const visualPolishResults: SelfEnhanceResult[] = [];
      if (
        this.stats.cyclesCompleted % VISUAL_POLISH_INTERVAL === 0 &&
        !isSafeMode() &&
        myRun === this.runId &&
        llmCooldownMs() === 0
      ) {
        try {
          // Pick a .tsx UI component that's not protected and not locked out.
          // DEAD-ARM FIX: this pre-pass used to filter the SCANNED list for
          // /components/pipeline/ — but SCAN_SCOPES covers src/lib/pipeline
          // and src/app only, so the filter could never match, the arm never
          // fired once (mode stats: visual-polish 0/0 forever), and
          // predictConfidence's visual-polish branch was dead code. Discover
          // the components directly from disk instead: the arm works without
          // widening the refactor scan scope.
          // ELIGIBILITY FILTER (follow-up): the arm's first firing after the
          // dead-arm fix targeted defense-panel.tsx (19.5KB) and was auto-
          // skipped by enhanceFile's 12KB mutation ceiling — recorded as a
          // "fail" for a file that never had a chance. 10 of the 12 pipeline
          // components are over the ceiling, so most firings would burn
          // their slot on a guaranteed skip. Filter to files under the SAME
          // ceiling enhanceFile enforces (MAX_FILE_BYTES, see the enhance
          // path) BEFORE rotating, so every firing targets a file the gate
          // chain will actually run on. 11 components currently qualify.
          const uiDir = join(PROJECT_ROOT, "src", "components", "pipeline");
          const uiFiles = existsSync(uiDir)
            ? readdirSync(uiDir)
                .filter((f) => f.endsWith(".tsx"))
                .map((f) => join(uiDir, f))
                .filter((f) => !isProtectedPath(relative(PROJECT_ROOT, f)))
                .filter((f) => {
                  try {
                    return statSync(f).size <= 12000; // match enhanceFile's MAX_FILE_BYTES
                  } catch {
                    return false;
                  }
                })
            : [];
          if (uiFiles.length === 0) {
            this.log(
              "Visual-polish pre-pass: no eligible UI component under the 12KB mutation ceiling — skipping this cycle",
              "info"
            );
          } else {
            // Rotate through the list by cycle number so we don't polish
            // the same component every time.
            const pick = uiFiles[this.stats.cyclesCompleted % uiFiles.length];
            const pickRel = relative(PROJECT_ROOT, pick);
            this.log(
              `Visual-polish mode: targeting ${pickRel} (${uiFiles.length} eligible component(s) under the 12KB ceiling)`,
              "info"
            );
            // SELF-MODEL (audit 7): open a prediction + record the outcome
            // so the calibration curve has visual-polish samples too. The
            // per-mode stats (visualPolishAttempts/Passes) feed the mode-
            // specific confidence in predictConfidence.
            const vpPredId = await openSelfPrediction(
              pickRel, "visual-polish", this.stats.cyclesCompleted + 1
            ).catch(() => null);
            const vpResult = await this.enhanceFile(pick, "visual-polish");
            visualPolishResults.push(vpResult);
            const vpOutcome = classifyOutcome(vpResult.enhanced, vpResult.reason);
            void noteOutcome(pickRel, vpOutcome, "visual-polish").catch(() => {});
            void resolveSelfPrediction(vpPredId, vpOutcome).catch(() => {});
            if (vpResult.enhanced) {
              this.log(`Visual-polish applied: ${vpResult.filePath} — ${vpResult.reason.slice(0, 80)}`, "success");
            } else {
              this.log(`Visual-polish no-op: ${vpResult.filePath} — ${vpResult.reason.slice(0, 80)}`, "info");
            }
          }
        } catch (vpErr) {
          this.log(`Visual-polish error (non-fatal): ${(vpErr as Error).message.slice(0, 120)}`, "warn");
        }
      }

      const results: SelfEnhanceResult[] = [];
      let enhanced = 0;
      let deferredThisCycle = 0;
      let lockedSkipped = 0;

      // Merge visual-polish results into the cycle's result list.
      if (visualPolishResults.length > 0) {
        results.push(...visualPolishResults);
        enhanced += visualPolishResults.filter((r) => r.enhanced).length;
      }

      for (const file of files) {
        // Run-token check inside the for-loop. Token-ONLY (audit 2): the
        // old `!this.continuous ||` here broke the MANUAL trigger — a
        // one-shot cycle runs with continuous=false and used to break
        // before the first file, reporting "Cycle complete: 0 files".
        // stop() always bumps runId, so the token alone stops continuous
        // cycles within ~1 file while letting manual cycles run to
        // completion (or until an explicit stop).
        if (myRun !== this.runId) {
          this.log("Stop requested — breaking out of cycle", "warn");
          break;
        }
        // Audit 3 (F1): a safe-mode raised mid-cycle (probe round, red-team
        // run, duress) halts the pass immediately — no further files are
        // mutated through the distrusted path.
        if (isSafeMode()) {
          this.log("SAFE-MODE raised mid-cycle — halting self-enhancement pass", "error");
          break;
        }
        const relPath = relative(PROJECT_ROOT, file);

        // ── Saturation lockout skip ──────────────────────────────────
        // A locked-out file is NOT mutated — no LLM call, no quota burn.
        // The user unlocked it (or restarted the server) to re-open it.
        // We count it so the cycle log shows "X/N (Y locked)" honestly.
        const sat = this.saturation.get(relPath);
        if (sat?.lockedOut) {
          lockedSkipped++;
          continue;
        }

        // ── PROACTIVE SATURATION SKIP (audit 7 — "predict files that
        //    will zero-diff", the cognitive core) ──────────────────────
        // Ask the self-model BEFORE the LLM call: is this file "finished"
        // (high finishedScore + low predicted confidence + enough
        // history to trust the verdict)? If yes, skip it for free — no
        // LLM call, no quota burn, no waiting for the 3-cycle lockout.
        // This is the loop PREDICTING its own zero-diffs instead of
        // discovering them after the fact. The skip is logged so the
        // reasoning is visible ("🧠 proactively skipping X — finished
        // 0.85, predicted 12% (will zero-diff)"). Falls back to spending
        // the call if the self-model is unavailable (honest).
        //
        // ORDERING: this check runs BEFORE the mid-cycle cooldown break
        // below. The proactive-skip is a DB-only lookup (no LLM call), so
        // it can run during cooldown. More importantly, without this
        // ordering the cooldown break (which fires when a fresh file's
        // enhanceFile 429s) would END THE CYCLE before the bandit's bottom-
        // ranked exhausted files ever reach this check — starving the
        // proactive-skip of any candidates and leaving the skip-probe
        // calibration at 0 forever. With the skip BEFORE the break, the
        // exhausted files are skipped for free regardless of cooldown
        // state; only files that NEED the LLM (enhanceFile) honor the break.
        let skipProbe = false;
        try {
          const skip = await shouldProactivelySkip(relPath);
          if (skip.skip) {
            // ── SKIP-PROBE (scoring the skipper) ─────────────────────
            // A skipped file never opened a prediction row, so the skip
            // rule's "will zero-diff" claim was unmeasurable — the
            // calibration curve only ever saw files the skipper did NOT
            // skip. Every SKIP_PROBE_INTERVALth skip, spend the call
            // anyway and tag the prediction as a probe: the outcome then
            // scores the skipper (zero-diff/fail = the skip saved a
            // no-growth call; pass = the skipper skipped a live file).
            this.skipProbeCounter++;
            skipProbe =
              this.skipProbeCounter % SKIP_PROBE_INTERVAL === 0 &&
              llmCooldownMs() === 0 &&
              !isSafeMode() &&
              myRun === this.runId;
            if (skipProbe) {
              this.log(`🧠 skip-probe: spending the call on ${relPath} to score the skip rule (${skip.reason})`, "info");
            } else {
              this.log(`🧠 ${skip.reason}`, "info");
              const skipReason = `Skipped (self-model predicts zero-diff: finished ${skip.finishedScore.toFixed(2)}, predicted ${(skip.confidence * 100).toFixed(0)}%)`;
              results.push({
                filePath: relPath,
                enhanced: false,
                reason: skipReason,
                oldBytes: 0,
                newBytes: 0,
                diffBytes: 0,
                llmUsed: false,
                llmLatencyMs: 0,
                compiled: false,
                pushed: false,
              });
              lockedSkipped++;
              // Advance the saturation state for this synthetic no-growth
              // outcome TOO — the old code continued BEFORE the saturation
              // update, so the counter never advanced for proactive skips
              // and the pass-complete checkpoint was unreachable.
              await this.advanceSaturation(relPath, skipReason);
              continue;
            }
            // Probe path: fall through to the real attempt below with
            // skipProbe=true, so the prediction row is tagged for the
            // audit's skip-rule scoring section.
          }
        } catch {
          /* self-model unavailable — proceed to LLM call (honest) */
        }

        // Mid-cycle gate escalation: a previous file's ratchet 429'd and set
        // the gate. DON'T wait per-file then call enhanceFile (that re-escalated
        // 2→5→15→30min within one cycle — the churn). Instead BREAK the for-loop:
        // the cycle ends early (honest "X/N files"), runContinuous waits 5s,
        // and the NEXT cycle's start-of-cycle pause handles the cooldown.
        // Net: one 429 per cooldown window, not 17.
        // Manual one-shot cycles (continuous=false) skip this — they defer
        // fast at the enhanceFile checkpoint and return quickly.
        // ORDERING: this runs AFTER the proactive-skip (which is a DB-only
        // lookup and doesn't need the LLM) so exhausted files are still
        // skipped for free during cooldown — only files that actually need
        // an LLM call (enhanceFile below) honor the break.
        const cdBefore = llmCooldownMs();
        if (cdBefore > 0 && this.continuous) {
          this.log(`LLM cooldown escalated mid-cycle — ending cycle (will pause ${Math.round(cdBefore / 1000)}s before next cycle)`, "warn");
          break;
        }

        // ── SELF-PREDICTION (audit 7 — the calibration engine) ────────
        // Open a prediction row BEFORE the attempt. The self-model
        // predicts its own success probability from empirical data (no
        // LLM cost — the prediction IS the model speaking). After the
        // gate verdict, resolveSelfPrediction closes the row. Over
        // cycles this builds a REAL calibration curve: "when I say 70%
        // confident, am I right 70% of the time?" with a Brier score as
        // the single number for self-knowledge. Fail-soft: a null id
        // means no prediction recorded (calibration loses one sample).
        const predId = await openSelfPrediction(
          relPath,
          "refactor",
          this.stats.cyclesCompleted + 1,
          skipProbe
        ).catch(() => null);

        // ── SELF-PROPHECY (audit 7 — the Oracle's public track record)
        //    ──────────────────────────────────────────────────────────
        // The self-model's prediction ALSO becomes an Oracle Prophecy
        // row (domain="self-prediction") with a 10-min horizon. The
        // auto-adjudicator resolves it next cycle with NO LLM call — the
        // verdict IS the next attempt's outcome. This floods the Oracle
        // with adjudicable, continuous-confidence prophecies (vs the
        // sparse LLM-generated kind), giving a real calibration curve
        // within hours. Fire-and-forget; fail-soft.
        if (predId !== null) {
          void (async () => {
            try {
              const pc = await predictConfidence(relPath, "refactor");
              await recordSelfProphecy({
                filePath: relPath,
                confidence: pc.confidence,
                reason: pc.reason,
                mode: "refactor",
                cycleNumber: this.stats.cyclesCompleted + 1,
              });
            } catch {
              /* fail-soft */
            }
          })();
        }

        const result = await this.enhanceFile(file);
        results.push(result);
        if (result.enhanced) enhanced++;
        if (result.reason.startsWith("Rejected")) this.stats.totalReverted++;
        if (result.reason.startsWith("Deferred")) deferredThisCycle++;
        // Durable tier: persist after every per-file verdict so a crash
        // mid-cycle loses at most one file's counters, not the boot's.
        this.persistStats();

        // ── SELF-MODEL OUTCOME (audit 7 — feeds the bandit + the
        //    calibration curve) ─────────────────────────────────────────
        // Classify the verdict and record it into the self-model: the
        // bandit's empirical rate for this file updates, the finished-
        // score shifts (zero-diff → +0.25 toward "finished", pass →
        // -0.15 back toward "room to improve"), and the prediction row
        // resolves. Both calls are fail-soft — a DB hiccup loses one
        // sample but never fails the cycle. The mode comes from
        // lastAttemptMode (set at enhanceFile top), defaulting to
        // refactor for the main loop.
        const outcome = classifyOutcome(result.enhanced, result.reason);
        void noteOutcome(relPath, outcome, this.lastAttemptMode).catch(() => {});
        void resolveSelfPrediction(predId, outcome).catch(() => {});
        // ── ORACLE SELF-PROPHECY ADJUDICATION (audit 7) ──────────────
        // Deterministically judge any pending self-prophecies for this
        // file whose predicted cycle has passed. No LLM, no cooldown
        // gate — the verdict IS this attempt's outcome. Closes the
        // oracle's loop in one cycle.
        void adjudicateSelfProphecies(
          relPath, result.enhanced, this.stats.cyclesCompleted + 1
        ).catch(() => {});

        // ── COMPOUNDING FEEDBACK SUITE (D1/D4/D7/D8) ─────────────────
        // All best-effort: a feedback failure must never fail the cycle.
        // Only counts when the LLM actually produced a proposal (llmUsed)
        // — a deferred/unavailable call never saw the lessons in action.
        const hadRealProposal = result.llmUsed;
        const ids = hadRealProposal && this.lastLessonIds.length > 0 ? [...this.lastLessonIds] : [];
        this.lastLessonIds = [];
        const attemptInfo = { ...this.lastAttemptInfo };

        if (hadRealProposal) {
          // D8: the tuner's measurement window — attempts vs passes.
          noteAttemptOutcome(this.stats.cyclesCompleted + 1, true, result.enhanced);
        }

        // LESSON FEEDBACK (the measured half of compounding): pass →
          // helped, fail → hindered …
        if (ids.length > 0) {
          void recordLessonOutcome(ids, result.enhanced).catch(() => {
            /* feedback is best-effort */
          });
          // … and on a gate failure, D1 LAPSE DETECTION: did one of the
          // injected lessons COVER this exact failure? Then the LLM read
          // the rule and ignored it — the phrasing needs to get sharper,
          // and at 6+ lapses a procedure graduates to the Operating
          // Constraints block (D2 promotion).
          if (!result.enhanced && result.reason.startsWith("Rejected")) {
            void (async () => {
              try {
                const pm = await postmortemStore.getActivePostmortem("self", "main", relPath);
                if (pm) {
                  const lapse = await recordLessonLapse(ids, relPath, pm.failureType, pm.symptom);
                  if (lapse.lapsed > 0) {
                    this.log(
                      `LAPSE: ${lapse.lapsed} injected lesson(s) covered this failure and were ignored (${lapse.details.map((d) => `#${d.lapseCount}`).join(", ")}) — phrasing will sharpen; at 6+ a procedure promotes to Operating Constraints`,
                      "warn"
                    );
                  }
                  // D7 REFLEXION: one self-diagnosis call on repeat failures
                  // (attempts >= 2). Gate-checked inside; never steals quota.
                  const refl = await maybeReflectAfterFailure({
                    filePath: relPath,
                    failureType: pm.failureType,
                    symptom: pm.symptom,
                    constraints: pm.constraints,
                    attempts: pm.attempts,
                  });
                  if (refl.reflected) {
                    this.log(`REFLEXION: stored self-diagnosis for ${relPath} — it rides the next attempt's constraint block`, "info");
                  }
                }
              } catch {
                /* best-effort */
              }
            })();
          }
        }

        // D4 CORPUS: one row per attempt — the audit trail + the
        // distiller's transform signal. Deferred/unavailable attempts
        // are recorded too (they carry originalSha + outcome); only
        // llmUsed=false ones have no transformSummary.
        if (attemptInfo.originalSha) {
          void recordMutationAttempt({
            cycleNumber: this.stats.cyclesCompleted + 1,
            branchNumber: attemptInfo.branchNumber,
            filePath: relPath,
            gateOutcome: classifyGateOutcome(result.reason),
            originalSha: attemptInfo.originalSha,
            mutatedSha: attemptInfo.mutatedSha,
            lessonIdsInjected: ids,
            transformSummary: attemptInfo.transformSummary,
          }).catch(() => {
            /* corpus is an amplifier, not a gate */
          });
        }

        // ── Per-file saturation update ───────────────────────────────
        // Classify this cycle's outcome for THIS file and update its
        // saturation counter (shared with the proactive-skip path — see
        // advanceSaturation). Growth → reset. No-growth → increment,
        // and lock out at SATURATION_THRESHOLD. Neutral (quota/transient)
        // → don't touch the counter (don't punish a file for API limits).
        await this.advanceSaturation(relPath, result.reason);

        // Brief pause between files to avoid hammering the LLM API
        await new Promise((r) => setTimeout(r, 2000));
      }

      // ── Pass-complete detection ─────────────────────────────────────
      // When every eligible file is locked out, the pass is complete —
      // the system is stable. This is the checkpoint the user reviews.
      // The loop doesn't auto-stop (it'll keep cycling, but every file
      // will skip); the UI shows "PASS COMPLETE — review & unlock" so
      // the user knows the system has converged and it's their move.
      const eligibleCount = files.length;
      // Honest counting (fix): locked-among-THIS-scan, not the whole-map
      // count. The saturation map remembers files from earlier passes
      // (older TARGET_FILES allowlists, since-removed display files) —
      // stale entries could fire "PASS COMPLETE" while current files
      // are still eligible (overcount bug).
      const lockedCount = files.filter(
        (f) => this.saturation.get(relative(PROJECT_ROOT, f))?.lockedOut
      ).length;
      if (eligibleCount > 0 && lockedCount >= eligibleCount) {
        this.log(
          `🎯 PASS COMPLETE — all ${eligibleCount} file(s) locked out. Review & unlock in the UI to start a new pass.`,
          "success"
        );
      }

      // Track consecutive cycles that made NO progress (zero enhanced, at
      // least one defer) due to the gate. After 3, log a loud "quota
      // exhausted" message once. With the break-on-escalation behavior, a
      // blocked cycle defers just 1 file (the probe that 429'd) then breaks
      // — so we key on "enhanced===0 && deferredThisCycle>0" rather than
      // "all files deferred" (which never happens now). The loop does NOT
      // auto-stop; the start-of-cycle pause keeps it alive until the gate
      // clears, and the UI shows the live countdown.
      if (files.length > 0 && enhanced === 0 && deferredThisCycle > 0) {
        this.consecutiveCooldownCycles++;
        if (this.consecutiveCooldownCycles >= 3 && !this.quotaExhaustedLogged) {
          this.log("LLM quota exhausted — loop paused until cooldown clears (countdown in UI)", "error");
          this.quotaExhaustedLogged = true;
        } else {
          this.log(`Cycle blocked on LLM gate (${this.consecutiveCooldownCycles} consecutive) — pausing ${Math.round(llmCooldownMs() / 1000)}s`, "warn");
        }
      } else {
        // At least one file enhanced (or no defers) — reset the counter
        // and the "quota exhausted" flag so it can fire again next outage.
        this.consecutiveCooldownCycles = 0;
        this.quotaExhaustedLogged = false;
      }

      // Audit 3: a stop-aborted cycle (break above) is not a completed
      // cycle — counting it skewed the distill/probe/attacker cadence by
      // one per stop.
      if (myRun === this.runId) {
        this.stats.cyclesCompleted++;
        this.persistStats();
      }
      this.currentFile = null;
      // Same honest counting: locked-among-scanned, not whole-map.
      const lockedNow = files.filter(
        (f) => this.saturation.get(relative(PROJECT_ROOT, f))?.lockedOut
      ).length;
      this.log(
        `Cycle complete: ${enhanced}/${files.length} enhanced${lockedSkipped > 0 ? `, ${lockedSkipped} locked` : ""}${lockedNow >= files.length && files.length > 0 ? " — PASS COMPLETE" : ""}`,
        "success"
      );

      // ── LESSON DISTILLATION (the compounding half) ────────────
      // Every DISTILL_INTERVAL cycles (meta-tunable, D8): one LLM pass
      // over the aggregate failure history extracts general lessons.
      // Fire-and-forget — a distillation failure must never fail the
      // cycle. Skips itself when the LLM gate is closed (mutations own
      // the quota first). D6: each pass also mirrors the lesson table
      // to memory/lessons.md (inside distillLessons).
      const cycleNow = this.stats.cyclesCompleted;
      void maybeDistill(cycleNow)
        .then((added) => {
          if (added > 0) {
            this.log(`🧠 Distilled ${added} new lesson(s) from aggregate history (cycle ${cycleNow})`, "success");
          }
        })
        .catch(() => {
          /* distillation is best-effort */
        });

      // ── AUDIT 4 (P1 + P2a + P3) RETENTION PRUNES ─────────────────
      // Three best-effort, fire-and-forget prunes for the loop's grow-
      // only DB tables. A prune failure is swallowed inside the helper
      // (retention.ts) — the .then/.catch here is purely for the
      // visible-in-log outcome, never a cycle failure.
      //
      // P1 + P2a: every 25th cycle (matching mutation-corpus.ts:130's
      //   `cycleNumber % 25 === 0` pattern). Amortizes the cost across
      //   cycles — the prunes do findMany + deleteMany, too expensive
      //   to run per-cycle.
      //   - pruneHighAttemptPostmortems(50): auto-resolves churny
      //     postmortems (>= 50 attempts), feeding them into the
      //     resolve-then-expire path below.
      //   - pruneResolvedPostmortems(30): archives + deletes resolved
      //     postmortems older than 30 days. Archive-then-delete is the
      //     data-loss guard (see retention.ts).
      //   - pruneTerminalSelfTasks(1000): keeps the newest 1000
      //     terminal-state SelfTask rows (done|failed|skipped); the
      //     pending cap (MAX_PENDING_TOTAL = 200) only covers
      //     pending+in_progress.
      //
      // P3: every 10th distill (using a module-level counter — see the
      //   distillAttemptCount declaration above). pruneOldLessons soft-
      //   caps the Lesson table: keeps ALL revoked (rare, high-value),
      //   the newest 100 active, the newest 100 deactivated; deletes
      //   deactivated rows older than 90 days outside the keep window.
      //   The distiller needs the recent deactivated tail for dedup
      //   ("don't re-derive a rule that already failed to transfer"),
      //   but the old deactivated tail has no live consumer.
      if (cycleNow > 0 && cycleNow % 25 === 0) {
        void pruneHighAttemptPostmortems(50)
          .then((p) => {
            if (p && p.autoResolved > 0) {
              this.log(
                `🧹 Auto-resolved ${p.autoResolved} churny postmortem(s) (>= 50 attempts) — eligible for expire on the next P1 pass${p.kept > 0 ? `, ${p.kept} kept (DB/disk failure)` : ""}`,
                "info"
              );
            }
          })
          .catch(() => {
            /* retention is best-effort */
          });
        void pruneResolvedPostmortems(30)
          .then((p) => {
            if (p && (p.pruned > 0 || p.archived > 0)) {
              this.log(
                `🧹 Pruned ${p.pruned} resolved postmortem(s) (archived ${p.archived} to postmortems/archived/)${
                  p.kept > 0 ? `, ${p.kept} kept (archive move failed — data-loss guard)` : ""
                }`,
                "info"
              );
            }
          })
          .catch(() => {
            /* retention is best-effort */
          });
        void pruneTerminalSelfTasks(1000)
          .then((p) => {
            if (p && p.pruned > 0) {
              this.log(
                `🧹 Pruned ${p.pruned} terminal SelfTask(s) (kept newest ${p.kept})`,
                "info"
              );
            }
          })
          .catch(() => {
            /* retention is best-effort */
          });
      }
      // P3: every 10th distill. The counter increments ONLY on a distill
      // cycle (cycleNow % DISTILL_INTERVAL === 0), so this fires roughly
      // every 10 * DISTILL_INTERVAL = 100 cycles at the default interval.
      if (cycleNow > 0 && cycleNow % DISTILL_INTERVAL === 0) {
        distillAttemptCount++;
        if (distillAttemptCount % 10 === 0) {
          void pruneOldLessons(100, 100, 90)
            .then((p) => {
              if (p && p.pruned > 0) {
                this.log(
                  `🧹 Lesson soft-cap: pruned ${p.pruned} deactivated lesson(s) older than 90d (kept ${p.keptActive} active, ${p.keptPruned} deactivated, ${p.keptRevoked} revoked)`,
                  "info"
                );
              }
            })
            .catch(() => {
              /* retention is best-effort */
            });
        }
      }

      // ── D8 META-TUNER (the L4 rung) ──────────────────────────────
      // Judge any in-flight trial (accept / roll back / early-abort)
      // or, on a proposal cycle, start one. Never steals LLM quota (a
      // trial START is deferred when the gate is closed, inside).
      void maybeMetaTune(cycleNow)
        .then((t) => {
          if (t.action === "proposed" || t.action === "accepted" || t.action === "rolled-back" || t.action === "aborted") {
            this.log(t.detail, t.action === "accepted" ? "success" : "info");
          }
        })
        .catch(() => {
          /* tuning is best-effort */
        });

      // ── D5 INTEGRITY CHECKS ──────────────────────────────────────
      // Gate-integrity probes (deterministic, every PROBE_INTERVAL
      // cycles): known-bad and known-good proposals against the REAL
      // gate code. Any failure raises safe-mode — the loop halts until
      // the operator clears it.
      if (cycleNow % PROBE_INTERVAL === 0) {
        try {
          const probes = runGateIntegrityProbes();
          if (probes.halted) {
            this.log(
              `🚨 GATE INTEGRITY FAILURE: ${probes.passed}/${probes.total} probes passed — SAFE-MODE raised, loop halted until the operator clears it`,
              "error"
            );
          } else if (cycleNow % (PROBE_INTERVAL * 10) === 0) {
            this.log(`Gate integrity: ${probes.passed}/${probes.total} probes passed`, "info");
          }
        } catch (probeErr) {
          // Audit 3 (F9): the old silent catch contradicted its own comment
          // — a crashed probe suite means the integrity check DID NOT RUN,
          // which must be visible, not swallowed.
          this.log(`Gate-integrity probe suite CRASHED (integrity unverified): ${(probeErr as Error).message}`, "error");
        }
      }
      // Test-attacker round (every ATTACKER_INTERVAL cycles, LLM,
      // gate-checked inside — mutations own the quota first): tries to
      // break the ratchet's own pins. Findings land as CANDIDATE
      // postmortems on the test file (watch list, never injected).
      if (cycleNow % ATTACKER_INTERVAL === 0) {
        void runTestAttacker()
          .then((round) => {
            if (round.findings.length > 0) {
              this.log(
                `🔴 TEST-ATTACKER: ${round.findings.length} weak pin(s) found — ${round.findings.map((f) => `${f.testPath} (${f.kind})`).join("; ")}`,
                "warn"
              );
            } else if (round.ran) {
              this.log(`TEST-ATTACKER: ${round.attacked} pin(s) examined — pins held`, "info");
            }
          })
          .catch(() => {
            /* best-effort */
          });
      }

      // ── D3 DREAMER (idle-time consolidation) ────────────────────
      // One cheap advisory task per idle moment. Self-skips when the
      // gate is closed (mutations own the quota); fires here (end of
      // cycle, before the 5s inter-cycle gap) so an open gate gets used.
      if (llmCooldownMs() === 0) {
        void maybeDream()
          .then((line) => {
            if (line) this.log(line, "info");
          })
          .catch(() => {
            /* dreams are best-effort */
          });
      }

      // Oracle auto-prophecy (fire-and-forget): the cycle is done, the
      // system has a fresh view of its own history — let it predict its
      // next turn. All guards (LLM gate, pending cap) live inside
      // oracle-auto.ts; this call never blocks or throws. Surfaces in
      // the console stream via the oracle event ring.
      autoProphecyAfterCycle();

      // ── Merge SelfTask drain results into the cycle return ──────────
      // The drain pre-pass (top of runCycle) stashes its results on the
      // instance. Merge them into the cycle's result list + bump the
      // enhanced count so the UI + stats reflect the deterministic fixes
      // alongside the whole-file refactors.
      const stashed = (this as unknown as { _selfTaskResults?: SelfEnhanceResult[] })._selfTaskResults;
      if (stashed && stashed.length > 0) {
        results.unshift(...stashed);
        enhanced += stashed.filter((r) => r.enhanced).length;
        (this as unknown as { _selfTaskResults?: SelfEnhanceResult[] })._selfTaskResults = undefined;
      }

      return { filesScanned: files.length, filesEnhanced: enhanced, results };
    } finally {
      this.running = false;
    }
  }

  /**
   * Run continuously: cycle after cycle until stopped.
   */
  async runContinuous(onUpdate?: () => void): Promise<void> {
    this.continuous = true;
    // Seed the lesson store once per process — the compounding loop's
    // starting capital, from knowledge the system's own history already
    // proved. Idempotent (skips if a seed row exists); fire-and-forget.
    void seedLessons().catch(() => {
      /* table missing until first restart post-migration — dormant */
    });
    // D8: seed the meta-param table once per process (idempotent). Also
    // reverts any row left in "trial" provenance — a restart orphaned an
    // in-flight A/B trial, and an unfinished trial never survives to be
    // mistaken for an accepted tuning.
    void seedMetaParams().catch(() => {
      /* table missing until first restart post-migration — dormant */
    });
    // Capture this loop's generation (audit 2): runCycle checks its own
    // token, but the OUTER while-loop only checked `this.continuous` — so a
    // stop-then-start during a cycle left TWO loops alive (the old one saw
    // continuous=true again after the new start and kept cycling forever,
    // interleaving with the new loop's cycles). With a token captured here,
    // a stale loop exits for good once its current runCycle returns.
    const myRun = this.runId;
    this.log("Starting continuous self-enhancement loop", "success");
    while (this.continuous && myRun === this.runId) {
      // Audit 3 (F1): check the brake every iteration, not just inside
      // runCycle — a raised flag ends the continuous loop itself, not
      // merely the current cycle.
      if (isSafeMode()) {
        this.log("SAFE-MODE active — continuous self-enhancement loop halted (clear via the Duress panel after review)", "error");
        break;
      }
      try {
        await this.runCycle();
      } catch (cycleErr) {
        // runCycle's body has only a `finally` (no catch) — a rejection
        // from its ~900-line body previously propagated HERE, killed the
        // while-loop, and left this.continuous true: every surface
        // reported "running", the start route answered "already running",
        // and nothing ever cycled again (the running-but-dead wedge).
        // This defensive catch mirrors loop-runtime's own continuous-loop
        // guarantee: one thrown cycle is logged and the loop survives.
        this.log(
          `Cycle threw (continuous loop survived): ${(cycleErr as Error).message}`,
          "error"
        );
      }
      if (onUpdate) onUpdate();
      if (!(this.continuous && myRun === this.runId)) break;
      // D3: the inter-cycle gap is the other idle moment — one dream
      // task if the gate happens to be open (it self-skips when closed).
      if (llmCooldownMs() === 0) {
        void maybeDream()
          .then((line) => {
            if (line) this.log(line, "info");
          })
          .catch(() => {
            /* dreams are best-effort */
          });
      }
      // Wait between cycles
      this.log("Waiting 5s before next cycle...", "info");
      await new Promise((r) => setTimeout(r, 5000));
    }
    // If the loop exits WITHOUT an explicit stop() (safe-mode break, or a
    // throw that escaped even the defensive catch), clear the continuous
    // flag so isContinuous() reflects reality — the old code left it true
    // and the start route then refused every restart with "already
    // running" while nothing ran.
    if (this.continuous && myRun === this.runId) {
      this.continuous = false;
      this.log(
        "Continuous loop exited abnormally — continuous flag cleared so [START] can re-arm.",
        "warn"
      );
    }
    this.log("Continuous self-enhancement loop exited", "info");
  }

  stop() {
    // Bump the run token so any in-flight runCycle / enhanceFile sees a
    // generation change at its next checkpoint and bails. We deliberately
    // do NOT touch `this.running` here — that flag is owned by runCycle's
    // `finally` block and represents "a cycle is currently executing".
    // Setting it false here would (a) not break the for-loop in runCycle
    // (it doesn't check `running`), and (b) defeat the re-entry guard at
    // the top of runCycle, letting a new start spawn a second concurrent
    // cycle sharing currentCycleBranch / currentFile.
    this.continuous = false;
    this.runId++;
    this.log("Self-enhance loop stop requested", "warn");
  }

  isRunning(): boolean {
    return this.running;
  }

  /** True when the continuous loop is active (between cycles OR mid-cycle).
   *  Distinct from isRunning() which is only true mid-cycle. */
  isContinuous(): boolean {
    return this.continuous;
  }

  // (restoreFromSnapshot was removed in the cripple-check (F3): its only
  // callers were the constructor's and liveSelfEnhanceLoop's snapshot
  // consume blocks — both deleted with the snapshot machinery in
  // hot-swap.ts. If state ever needs to cross a process boundary again,
  // model it as an explicit worker-API payload, not a globalThis stash.)

  getStats() {
    return { ...this.stats };
  }

  /** Public gate for the hydration promise. Status endpoints await this
   *  before snapshotting getStats() so the UI never sees the
   *  pre-hydration zeros (cycles:0 vs the self-model's historical
   *  attempts). The promise never rejects (hydrateStats catches all). */
  whenStatsReady(): Promise<void> {
    return this.statsReady;
  }

  /** Snapshot the in-memory stats into the durable restart tier
   *  (.git/info/loop-stats.json — the armed-state pattern). Best-effort:
   *  writeLoopStats never throws, so telemetry can never fail a cycle. */
  private persistStats(): void {
    writeLoopStats({
      totalScanned: this.stats.totalScanned,
      totalEnhanced: this.stats.totalEnhanced,
      totalReverted: this.stats.totalReverted,
      totalPushed: this.stats.totalPushed,
      testsWritten: this.stats.testsWritten,
      cyclesCompleted: this.stats.cyclesCompleted,
      tasksGenerated: this.stats.tasksGenerated,
      lastEnhancementAt: this.stats.lastEnhancementAt,
    });
  }

  /** One-time-per-boot hydration of the banner counters. Priority:
   *    1. .git/info/loop-stats.json — the durable tier (normal path).
   *    2. First boot of this module (no file): seed ONCE from the DB
   *       self-model aggregates so the banner and the self-model panel
   *       start from the same window — enhanced ← passes, reverted ←
   *       fails, pushed ← passes (pushes are 1:1 with enhancements in
   *       practice), cycles ← the corpus's max cycleNumber. From then on
   *       the file is the source and survives even DB rolls.
   *    3. DB unavailable too: stay at zeros (old behavior — never block
   *       the loop on its own telemetry).
   *  Never rejects: the statsReady gate must always resolve. */
  private async hydrateStats(): Promise<void> {
    try {
      const persisted = readLoopStats();
      if (persisted) {
        this.stats = { ...persisted };
        console.log(
          `[SELF-ENHANCE] stats hydrated from restart tier: ${persisted.cyclesCompleted} cycles, ${persisted.totalEnhanced} enhanced, ${persisted.totalPushed} pushed`
        );
        return;
      }
      // First boot of the durable tier — seed from the self-model (the
      // same window the panel shows), then write the file so this seed
      // never runs again.
      try {
        const [agg, cyc] = await Promise.all([
          db.selfModelFile.aggregate({ _sum: { passes: true, fails: true } }),
          db.mutationCorpus.aggregate({ _max: { cycleNumber: true } }),
        ]);
        const passes = agg._sum.passes ?? 0;
        const fails = agg._sum.fails ?? 0;
        this.stats.totalEnhanced = passes;
        this.stats.totalReverted = fails;
        this.stats.totalPushed = passes;
        this.stats.cyclesCompleted = Math.max(0, cyc._max.cycleNumber ?? 0);
        this.persistStats();
        console.log(
          `[SELF-ENHANCE] stats seeded from self-model DB epoch: ${this.stats.cyclesCompleted} cycles, ${passes} enhanced, ${fails} reverted`
        );
      } catch {
        /* DB unavailable — stay at zeros; the file gets written by the
           first persistStats call with whatever the loop has done. */
      }
    } catch {
      /* never reject — stats are telemetry, not a gate */
    }
  }

  /** Snapshot of per-file saturation state for the status API + UI.
   *  Returns a plain object (not a Map) so it JSON-serializes cleanly. */
  getSaturation(): SaturationMap {
    const out: SaturationMap = {};
    for (const [path, state] of this.saturation) {
      out[path] = { ...state };
    }
    return out;
  }

  /** Unlock a locked-out file so it's eligible for the next cycle. Called
   *  by the UI when the user clicks "unlock". Resets the no-growth counter
   *  and the enhancements-this-pass counter — a fresh start. The file is
   *  re-evaluated on the next cycle (its content may have changed since
   *  lockout, so the LLM might find new improvements or might re-lock
   *  immediately if nothing's changed in the underlying code). */
  unlockFile(relPath: string): { unlocked: boolean; reason?: string } {
    const state = this.saturation.get(relPath);
    if (!state || !state.lockedOut) {
      return { unlocked: false, reason: "not locked" };
    }
    state.lockedOut = false;
    state.lockedAt = null;
    state.consecutiveNoGrowth = 0;
    state.lastNoGrowthReason = null;
    state.enhancementsThisPass = 0;
    this.log(`🔓 ${relPath} unlocked — eligible for next cycle`, "success");
    return { unlocked: true };
  }

  getLogs() {
    return [...this.logs];
  }

  getCurrentFile() {
    return this.currentFile;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // On-demand task engine (restored from the Original-branch lineage).
  // These run alongside the continuous whole-file loop: the loop refactors
  // module-by-module through the full gate chain, while the task engine
  // lets the USER drive targeted fixes (Direction 1: the user is the
  // feedback signal). Ported from d326ba6.
  // ─────────────────────────────────────────────────────────────────────────

  /** Update a task row; a missing row is non-fatal (it may have been
   *  deleted by the user from the tasks panel). */
  private async updateTask(
    id: string,
    patch: {
      status?: string;
      lastError?: string | null;
      fixSummary?: string;
      commitSha?: string;
      deferred?: number;
    }
  ) {
    await db.selfTask.update({ where: { id }, data: patch }).catch(() => {
      /* task row may be gone — non-fatal */
    });
  }

  /** Manual rescan: regenerate the task queue from code findings. */
  async rescan() {
    const scan = await generateTasks();
    this.stats.tasksGenerated += scan.newTasks;
    this.log(
      `Manual rescan: ${scan.filesAnalyzed} files, ${scan.findings} findings, ${scan.newTasks} new tasks`,
      scan.newTasks > 0 ? "success" : "info"
    );
    return scan;
  }

  /** User veto on system-defined input: skip the next pending task. */
  async skipNext(): Promise<{ skipped: boolean; kind?: string; filePath?: string; line?: number }> {
    const next = await db.selfTask.findFirst({
      where: { status: "pending" },
      orderBy: [{ priority: "asc" }, { deferred: "asc" }, { createdAt: "asc" }],
    });
    if (!next) return { skipped: false };
    await this.updateTask(next.id, { status: "skipped", lastError: "user veto" });
    this.log(`User veto: skipped [${next.kind}] ${next.filePath}:${next.line}`, "warn");
    return { skipped: true, kind: next.kind, filePath: next.filePath, line: next.line };
  }
}

// Singleton
const globalForSelfEnhance = globalThis as unknown as {
  __selfEnhanceLoop?: SelfEnhanceLoop;
};

export const selfEnhanceLoop: SelfEnhanceLoop =
  globalForSelfEnhance.__selfEnhanceLoop ?? new SelfEnhanceLoop();

if (!globalForSelfEnhance.__selfEnhanceLoop) {
  globalForSelfEnhance.__selfEnhanceLoop = selfEnhanceLoop;
}

/**
 * Resolve the LIVE loop singleton at CALL time — never trust an
 * import-time binding in route handlers.
 *
 * Why this exists (historical, observed live 2026-11-08): pre-split,
 * the server's hot-swap.ts cleared `__selfEnhanceLoop` from the
 * server's globalThis, re-evaluated the module, and re-pinned a FRESH
 * instance; a route bundle that evaluated BEFORE the swap still held
 * an import-time binding to the OLD instance — /status served a loop
 * frozen at the pre-swap log tail while the live loop committed
 * mutations on the new instance. Reading through globalThis per call
 * (this function) was the fix.
 *
 * Since the worker split (the loop moved to mini-services/loop-worker,
 * port 3004): this function is only called in the WORKER process (the
 * server proxies through the worker via loop-worker-client.ts). There's
 * no server-side hot-swap that clears `__selfEnhanceLoop` anymore —
 * the pin is set once at worker boot and stays, so the indirection
 * just returns the same singleton every call. (The former snapshot
 * "reaper" block was deleted in the cripple-check (F4): with the
 * snapshot machinery gone and the pin never cleared, nothing can ever
 * appear in the slot for it to consume.)
 */
export function liveSelfEnhanceLoop(): SelfEnhanceLoop {
  const g = globalThis as unknown as { __selfEnhanceLoop?: SelfEnhanceLoop };
  return g.__selfEnhanceLoop ?? selfEnhanceLoop;
}
