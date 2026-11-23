/**
 * Files the self-improvement system must NOT modify (it would break its own
 * loop, gates, or control surface).
 *
 * SINGLE SOURCE OF TRUTH (audit 2: "duplicated protected lists have
 * drifted"). This list used to exist in TWO places that had diverged:
 *   - self-enhance-loop.ts protected the verifier + push path
 *     (push-target.ts, in-memory-typecheck.ts, verify-refactor.ts) but not
 *     the task generator;
 *   - self-task-generator.ts protected itself but NOT the verifier or push
 *     path — so the task engine could queue LLM-driven edits against the
 *     very gates that are supposed to check those edits.
 *
 * Both modules now import this set. Adding a file here protects it
 * everywhere at once.
 *
 * AUDIT 3 REALIGNMENT: the old list protected the ORCHESTRATOR (runtime,
 * verifier, push, compounding chain) but left the GATES themselves mutable
 * (mutation-guard, secret-scan, ast-diff-gate, sanitizer, duress, the
 * postmortem memory, the red-team runner). A "refactor mutation-guard.ts to
 * remove dead code" proposal could delete HARD_EVIL_TOKENS, pass every
 * remaining gate (export preserved, typechecks, debate approves a
 * "reasonable cleanup"), and the gate would be gone. The gate-integrity
 * probe didn't test those gates, so nothing would notice. The design doc
 * always said the sanitizer and AST gate were brain, never body — the list
 * had drifted from the doc. The gate subtrees are now protected by prefix:
 * core/, emg/, postmortem/, red-team/.
 */
export const PROTECTED_FILES = new Set([
  // Loop runtime + gate chain
  "src/lib/pipeline/autonomous/loop-runtime.ts",
  "src/lib/pipeline/autonomous/self-enhance-loop.ts",
  "src/lib/pipeline/autonomous/self-task-generator.ts",
  // (loop-event-bus.ts was removed as dead infrastructure — 0 subscribers.)
  "src/lib/pipeline/autonomous/push-target.ts", // protect the push auth path
  "src/lib/pipeline/autonomous/in-memory-typecheck.ts", // protect the typecheck
  "src/lib/pipeline/autonomous/verify-refactor.ts", // protect the verifier
  "src/lib/pipeline/autonomous/lesson-store.ts", // protect the compounding engine
  // Archaeology writes to the Lesson table (the learning substrate) —
  // a corrupted miner could plant false lessons that then ride the
  // injection pipeline into every enhance prompt. Same integrity class
  // as lesson-store itself.
  "src/lib/pipeline/autonomous/archaeology.ts", // protect the history miner
  "src/lib/pipeline/autonomous/schema-gate.ts", // protect the schema gate
  "src/lib/pipeline/autonomous/protected-files.ts", // protect the protection list
  // The operator's mutation-freeze lock. If the loop could rewrite this
  // file it could neuter isMutationFrozen() itself — the lock that stops
  // the loop. Same self-protection class as protected-files.ts above.
  "src/lib/pipeline/autonomous/mutation-freeze.ts", // protect the freeze tier
  // The armed-intent tier: a mutated version could fabricate armed:true
  // writes or drop the test-origin guard (the "armed by test-run"
  // pollution class). The freeze checks happen at runtime, but this file
  // decides whether the loop auto-starts at ALL — operator-only.
  "src/lib/pipeline/autonomous/self-enhance-armed-state.ts",
  "src/lib/pipeline/llm/agent-llm.ts", // protect the LLM wrapper
  "src/lib/pipeline/llm/debate-llm.ts",
  "src/lib/pipeline/llm/gemini-direct.ts", // audit 3: third LLM wrapper was unprotected
  // ── Compounding-intelligence integrity chain (D1-D8). The rule: a
  // module is protected when a corrupted version of it could corrupt
  // the LEARNING SUBstrate (what the system knows), the AUDIT trail
  // (what the system can prove), or the TUNING (how the system improves
  // itself). Advisory modules (dreamer, reflection) stay mutable —
  // their outputs pass through the existing gates.
  "src/lib/pipeline/autonomous/lapse-detector.ts", // D1: writes the lapse counts that drive promotion
  "src/lib/pipeline/autonomous/meta-params.ts", // D8: the knob table the tuner writes
  "src/lib/pipeline/autonomous/meta-tuner.ts", // D8: the loop can never rewrite its own tuner
  // The goal engine — the loop's self-set SYSTEM DIRECTION. Same rule as
  // meta-tuner ("never rewrite your own tuner"): a loop that could edit
  // goal-engine.ts could drop the clamps (retire operator goals freely,
  // mint trivial goals, flip-flop) — it would own the RULES of goal-
  // setting, not just the goals. The loop writes LoopGoal ROWS through
  // this module's clamped API; the governance itself is operator-only.
  "src/lib/pipeline/autonomous/goal-engine.ts",
  "src/lib/pipeline/autonomous/mutation-corpus.ts", // D4: the audit trail of every attempt
  "src/lib/pipeline/autonomous/lessons-markdown.ts", // D6: writes a file that gets committed and pushed
  // audit 5 — protect the retention + merge-back + task-execution path.
  // retention.ts: the bounded-growth helpers; a corrupted version could
  // silently stop pruning and re-introduce the grow-only regression.
  // merge-back.ts: the reviewed catch-up path; a corrupted version could
  // bypass the typecheck gate or delete main's newer files.
  // task-executor.ts: the SelfTask consumption path (wired in audit 5 to
  // break the ZERO_DIFF_SATURATION plateau). The worklog (729-731) shows
  // the loop once DELETED a prior task-executor as "cosmetic churn" —
  // the current version has deterministic kinds that can't zero-diff, so
  // the rationale no longer applies. Protecting it prevents a re-delete.
  "src/lib/pipeline/autonomous/retention.ts",
  "src/lib/pipeline/autonomous/merge-back.ts",
  "src/lib/pipeline/autonomous/task-executor.ts",
  // ── Audit 3: gate + control modules in the shared autonomous/ dir.
  // The core/, emg/, postmortem/, red-team/ subtrees are covered by
  // PROTECTED_PREFIXES below; these live in autonomous/ next to mutable
  // advisory modules, so they need explicit entries.
  "src/lib/pipeline/autonomous/code-analysis.ts", // the parser the truncation/cosmetic gates run on
  "src/lib/pipeline/autonomous/structural-validator.ts", // the structure-preservation gate
  "src/lib/pipeline/autonomous/saturation.ts", // the lockout mechanism + the scan scope definition
  "src/lib/pipeline/autonomous/route-cooldown.ts", // the trigger rate-limiter (control-surface guard)
  "src/lib/pipeline/autonomous/chat-task.ts", // operator-approved code writes — the protection guard itself lives here
  // D1 (architecture context): the loop's own architecture-vision
  // injector. arch-context.ts builds the 2-hop neighborhood map that
  // the refactor prompt uses to avoid breaking changes to importing
  // modules. A corrupted version could blind the loop (empty context
  // → LLM refactors in isolation again) OR inject misleading hints
  // (drop a "(self)" annotation → hide a circular dep the LLM would
  // otherwise avoid; fabricate an export that doesn't exist → LLM
  // calls a non-existent API). The loop's prompts depend on this
  // module's integrity, so it gets the same protection as the gates
  // and the protected-list itself.
  "src/lib/pipeline/autonomous/arch-context.ts",
  // GitHistory-Sync corpus bridge — same class as arch-context: it
  // shapes prompt content (the fleet digest feeds the lesson distiller;
  // the prior-art block feeds every refactor prompt). A corrupted
  // version could fabricate prior art ("sibling repos do it this way"),
  // mislabel fleet stats, or strip the honest CI-pending split from the
  // digest — poisoning the learning substrate's EXTERNAL evidence
  // channel. The corpus FILES (memory/commit-history.*.json) are
  // operator-provided and outside the loop's scan scope already; this
  // entry protects the READER that turns them into prompt content.
  "src/lib/pipeline/autonomous/githistory-corpus.ts",
  // Learned mutation policy — the loop's first LEARNED component. It
  // trains on the MutationCorpus (own gates) + the fleet archive (wild
  // prior) and injects a transform-family strategy block into every
  // refactor prompt. A corrupted version could fabricate rates ("guard
  // transforms always pass"), drop the honesty deferral (speak on N=2),
  // or launder wild evidence as own experience — poisoning the loop's
  // learned steering with fake confidence. The PARAMETERS are learned;
  // the ESTIMATOR (this file) is protected: the thing being measured
  // must not rewrite the ruler.
  "src/lib/pipeline/autonomous/mutation-policy.ts",
  // Curiosity drive + health metrics — the loop's EXTERNAL objective
  // signal (codebase health snapshots) AND the behavior change that
  // reads it (the curiosity bonus in the bandit). Same category as
  // self-model.ts (selection policy): a mutation here could disable the
  // operator's flag gate (make curiosity always fire), widen the bonus
  // cap to un-sink finished files, or fake the health trend so the
  // drive fires when it shouldn't. The operator enables curiosity via
  // SystemFlag; the loop must never rewrite its own curiosity rule or
  // the health measurement that triggers it.
  "src/lib/pipeline/autonomous/curiosity-drive.ts",
  "src/lib/pipeline/autonomous/health-metrics.ts",
  // Operator questions — the loop's "voice" (step 4 of "what the system
  // should be for"). poseQuestion / recordAnswer / getAnswer + the rate
  // limit. Same category as armed-state: the loop can pose a question
  // but CANNOT answer its own question (the answer path is operator-only,
  // via the `answer` console command in the protected control surface).
  // A mutation here could disable the rate limit (spam the operator),
  // fake a yes/no answer (the loop self-answering), or pose misleading
  // questions. Protect it.
  "src/lib/pipeline/autonomous/operator-questions.ts",
  // The self-model — the loop's measured self-knowledge, INCLUDING the
  // bandit target-selection formula (empirical + exploration + recency +
  // MOMENTUM + COMPLEXITY − exhaustion). This is selection POLICY, same
  // category as meta-tuner.ts ("the loop can never rewrite its own
  // tuner"): a mutation here could re-weight the bandit to favor trivial
  // files (drop the complexity term), silence the exhaustion penalty
  // (keep zero-diffing the same file forever), or corrupt the
  // self-prediction calibration the oracle adjudicates against. The
  // operator's selection priorities ride in this formula — protect them.
  "src/lib/pipeline/autonomous/self-model.ts",
  // Hot-swap core — protect the swapper. If the loop could rewrite its
  // own hot-swap module, a bad mutation could break the swap mechanism
  // and the running process would never benefit from future fixes.
  // The swap itself still works on other pipeline files; the loop just
  // can't edit the swap logic. (Concept: PKM — protect the executioner.)
  // Also covered by the core/ prefix — kept explicit to document intent.
  "src/lib/pipeline/core/hot-swap.ts",
  // UI control surface — the loop can change HOW things look (the mutable
  // display layer in src/app/display/ and src/components/pipeline/) but can
  // NEVER touch the control surface: the buttons, the command input, the
  // command parser, the state management, the polling. If the system could
  // rewrite its own control surface, it could remove the STOP button and
  // escape user oversight.
  "src/app/page.tsx", // the control surface itself
  "src/app/layout.tsx", // page metadata / shell
  // ── v5 (2026-11-17): control-surface components inside the newly
  // re-expanded src/components/pipeline mutation scope. The display
  // panels in that subtree are now mutable (the loop can polish them);
  // these two are NOT display — they are control surface, one layer down:
  //   - api-unlock.tsx is the UI half of the auth middleware gate. It
  //     listens for 401s and stores the operator API key. A mutated
  //     version could silently accept any key, drop the 401 listener, or
  //     exfiltrate the stored key — same escape hatch as rewriting
  //     middleware.ts, one layer up. PROTECTED.
  //   - boot-splash.tsx is the click-intercept entry ceremony. It overlays
  //     the whole viewport at z-index 1000 during boot and exit; a mutated
  //     version could brick the UI entry (permanent overlay, swallow the
  //     first-click, break the pointer-events exit fix). PROTECTED — the
  //     entry layer is control-surface-adjacent and the cost of a bad
  //     mutation is a UI that can't be entered.
  "src/components/pipeline/api-unlock.tsx", // auth-prompt UI (middleware gate)
  "src/components/pipeline/boot-splash.tsx", // click-intercept entry ceremony
  // pipeline-stages.tsx: a "6-Stage Refactoring Pipeline" visualization
  // that is NEVER imported (dead display code — PipelineStages has zero
  // import sites; it was superseded by the console-stream terminal view).
  // The loop already tried to refactor it once (2026-11-16) and FAILED
  // with a COMPILE_ERROR postmortem. Keeping it in scan scope wastes LLM
  // quota on dead code that has nothing to improve and a history of
  // breaking the build. The user flagged the "⚠ will re-lock unless
  // fixed" risk: a dead file with nothing to improve converges to a
  // deterministic lock (self-model zero-diff after enough no-growth
  // cycles), and unlocking it is futile. Protecting it removes it from
  // scan scope — it can't lock, can't waste quota, can't re-lock.
  "src/components/pipeline/pipeline-stages.tsx", // unused display component (dead code)
  // The database client — a mutation here could break every db.* call
  // site at once, including the postmortem and lesson stores.
  "src/lib/db.ts",
  // ── v7 scope expansion (2026-11-22): scripts/ joins the scan scope
  // (saturation.ts v7). The utility scripts are mutable, but the two
  // that touch the credential/push path are NOT — same protection
  // class as push-target.ts:
  //   - push-now.ts invokes pushCurrentState() with the sealed PAT; a
  //     mutated version could push to a different repo, leak the push
  //     outcome to a third party, or corrupt the manual-push path the
  //     operator relies on when the loop is down.
  //   - seal-push-token.ts is the ONLY path that writes a fresh PAT
  //     into the vault (AES-256-GCM, .git/info/ + DB tiers). A mutated
  //     version could seal the token to an attacker-controlled tier,
  //     echo the plaintext token (it reads it from the environment),
  //     or downgrade the sealing — the credential chain is operator-
  //     only, full stop.
  "scripts/push-now.ts", // the manual push path (sealed-PAT consumer)
  "scripts/seal-push-token.ts", // the PAT sealing path (credential writer)
  // ── Evidence-phase protection (operator, 2026-11-23): audit and
  // evidence tooling is part of the trust boundary. audit-remote.ts was
  // self-enhanced by the loop at 2026-11-23 02:15 (out-of-src expansion
  // reaching the operator's audit surface — caught in the third reviewer
  // exchange). The instruments that measure the system must not be
  // mutated by the system being measured. Revisit only when the survival
  // benchmark has an independent, non-loop-owned execution path.
  "scripts/audit-remote.ts", // the operator's remote-audit tool (evidence instrument)
  "scripts/inspect-target-tree.ts", // target-tree inspector (evidence instrument)
  // ── Retention root-cause fix (operator, 2026-11-23): the DB wipe-proof
  // tier. loop-db-tier.ts is the RECOVERY instrument for the platform's
  // untracked-file wipe (the confirmed root cause of the retention
  // "defect" — machine restarts deleted db/custom.db; see the script
  // header). A mutated version could silently stop backing up, back up
  // to a wiped-on-restart location, or corrupt the restore — the system
  // being recovered must not rewrite its own recovery path. Same class
  // as seal-push-token.ts (the .git/info tier writer).
  "scripts/loop-db-tier.ts", // the DB wipe-proof tier (recovery instrument)
  // ── Worker control surface (operator, 2026-11-23): the loop-worker's
  // entry hosts the API-key gate (fail-closed), the mutation-freeze
  // refusals on /start /reboot /trigger, and the unlock PIN tiers —
  // mini-services/loop-worker is IN the loop's scan scope (saturation
  // v6), so without this entry the loop could rewrite the very file
  // that enforces its own locks: drop the key check, neuter
  // isMutationFrozen(), or flip the PIN order. Same class as
  // api/self-enhance/** ("the loop can never mutate its own OFF
  // switch") — this is that switch's second home.
  "mini-services/loop-worker/index.ts", // worker control surface (auth + freeze + PIN tiers)
  // The dev-server daemonizer (scripts/dev-daemon.py) — supervision
  // chain, same class as dev-watchdog. .py files aren't scanned today
  // (extensions: [".ts"] only); this entry pins intent so a future
  // .py scope widening can't silently include it.
  "scripts/dev-daemon.py", // the dev-server daemon (supervision chain)
]);

/** Directory subtrees the loop must never touch — same contract as
 *  PROTECTED_FILES but for whole prefixes (individual listing would be
 *  brittle: every new route file would need a matching entry here, and
 *  forgetting one would open the control surface).
 *
 *  - api/self-enhance/** — the backend of the control surface. start /
 *    stop / push / push-target / llm-config / visibility. If the loop
 *    could rewrite these routes, a "successful" mutation could break the
 *    STOP button's API or weaken the push path — the same escape
 *    hatch as rewriting page.tsx, one layer down.
 *  - api/autonomous/** — audit 3: the autonomous loop's own control API
 *    (status/trigger/stop routes). Same hazard as self-enhance, same
 *    rule: the loop can never mutate its own OFF switch, one layer down.
 *  - api/hot-swap/** and api/duress/** — the swap trigger and the
 *    safe-mode control. Mutating these could break the operator's
 *    ability to force a swap or raise/clear safe-mode.
 *  - pipeline/core/, pipeline/emg/, pipeline/postmortem/, pipeline/red-team/
 *    — audit 3: THE GATES THEMSELVES. mutation-guard (HARD_EVIL_TOKENS),
 *    secret-scan (SENSITIVE_PATTERNS), ast-diff-gate (symbol retention),
 *    sanitizer (entropy), duress (safe-mode), halt, emg-rag, the
 *    postmortem scar memory, the red-team runner + suite. A self-
 *    improving system whose improvement target set includes its own
 *    gates, unguarded, is one "reasonable cleanup" away from having no
 *    gates. The unified pipeline + siphon ride along (they orchestrate
 *    the gates on the remote-repo path).
 *  - health/ + healthz — the sandbox uptime probes (explicit entries;
 *    the old bare "health" prefix would have matched any future
 *    health-foo route too).
 */
import { PROJECT_ROOT } from "../core/paths";

export const PROTECTED_PREFIXES = [
  "src/app/api/self-enhance/",
  "src/app/api/autonomous/", // audit 3: the loop's own control API
  "src/app/api/hot-swap/", // audit 3: the swap trigger API
  "src/app/api/duress/", // audit 3: the safe-mode control API
  "src/app/api/health/",
  "src/app/api/healthz",
  // ── Audit 3 (F7): defense-relevant API surface ────────────────────
  // The loop's scan scope previously included ALL of src/app/api — a
  // "reasonable cleanup" of these routes could neuter the operator's
  // red-team trigger, forge/clear the scar memory, rewrite the PAT-using
  // GitHub proxy, or weaken the pipeline/secret-scan entry points.
  // Prefix protection prevents EDITING gate modules, but these ROUTES
  // import and invoke them with route-controlled arguments — they are
  // part of the defense surface and get the same rule. (The api/evolution/
  // and api/emg/ subtrees were removed as dead HTTP wrappers in the
  // endpoint cleanup — their logic lives in the protected lib subtrees,
  // emg/ and llm/, which carry the prefix protection instead.)
  "src/app/api/red-team/", // the operator's integrity-probe trigger
  "src/app/api/postmortems/", // the scar-memory read/chain API
  "src/app/api/pipeline/", // the remote-repo pipeline entry
  "src/app/api/github/", // PAT-using GitHub read proxy (tree/fetch/validate)
  "src/app/api/oracle/", // archaeology uses the stored PAT
  "src/app/api/secret-scan/", // the scanner's own API
  // ── Audit 6: api/memory/ UNPROTECTED (query route since deleted) ──
  // The user flagged "still not touching the api files" — 60 of 61 API
  // routes were protected. The memory subtree is pure data/utility:
  //   - api/memory/entries — RAG memory read (no auth, no PAT, no gate)
  //   (api/memory/query was deleted as unused in the endpoint cleanup.)
  // The loop can now add JSDoc, input validation, and error handling to
  // it. The existing gates (mutation-guard, structural-validator,
  // secret-scan, typecheck) enforce symbol preservation and block evil
  // tokens — the same safety net as any other mutable file. The
  // control-surface (self-enhance/autonomous/hot-swap/duress) and
  // security-gate (red-team/postmortems/secret-scan) and PAT-using
  // (github/oracle/branches/pipeline) APIs STAY PROTECTED.
  "src/app/api/branches", // stored-PAT branch listing
  // ── Audit 3 (F7): the proposal ENGINE itself ──────────────────────
  // clean-room-runtime is the LLM engine that generates proposals on the
  // remote path — imported by the (protected) unified-pipeline. The
  // orchestrator was protected; the code-producer was not.
  "src/lib/pipeline/engines/", // audit 3: the proposal engine
  "src/lib/pipeline/core/", // audit 3: the gate machinery
  "src/lib/pipeline/emg/", // audit 3: the sanitizer/halt/RAG/debate layer
  "src/lib/pipeline/postmortem/", // audit 3: the scar memory
  "src/lib/pipeline/red-team/", // audit 3: the integrity chain
  // ── Evidence-phase protection (operator, 2026-11-23, reversible): the
  // oracle subtree — the system's measurement of its own predictions —
  // is frozen out of mutation scope until (a) the prophecy-retention
  // defect (table wiped twice on 2026-11-23, root cause under
  // investigation) is attributed and fixed, and (b) a calibration scorer
  // verified against durable outcomes. The loop self-enhanced
  // oracle-scheduler.ts twice during the very window the retention
  // defect was discovered (00:44, 03:10) — an evidence subsystem must
  // not be rewritten by the system it is evidence FOR while its
  // integrity is in question. Operator may remove this entry after the
  // evidence phase closes.
  "src/lib/pipeline/oracle/", // the prophecy/evidence machinery (evidence phase)
  // ── v6 scope expansion (2026-11-22): the resurrection layer ─────
  // The loop's scan scope now reaches into mini-services/ (saturation.ts
  // v6). dev-watchdog is deliberately excluded from the scopes AND
  // prefix-protected here: it is the dev server's 2-strike respawn
  // supervisor — the only process nothing else revives. A broken
  // mutation of its own supervisor would leave the system LOOKING
  // healthy while silently losing its ability to recover from a dev
  // server crash. Defense in depth: even if a future scope widening
  // adds the whole mini-services/ dir, this prefix keeps the watchdog
  // out of reach.
  "mini-services/dev-watchdog/",
  // ── v7 scope expansion (2026-11-22): the launch chain ────────────
  // .zscripts/ holds the launch layer — dev.sh (the dev server
  // launcher the watchdog prods), start.sh, mini-services-start.sh,
  // mini-services-build.sh, and the mini-service logs. Same rationale
  // as dev-watchdog: a bad shell mutation in the launch chain could
  // break the resurrection path while everything LOOKS healthy (the
  // scripts are only exercised on restart, so a corrupted one can sit
  // silently until the next crash — exactly when it hurts most). Not
  // in any scan scope today; this prefix is defense in depth so a
  // future widening can't reach it without an operator reviewing
  // this file.
  ".zscripts/",
];

/** Normalize a possibly-sloppy relative path to the canonical POSIX form
 *  isProtectedPath expects: collapse duplicate separators, strip a leading
 *  ./, resolve .. segments lexically, and strip the project-root prefix
 *  from absolute paths. Audit 3: the old check trusted the caller to pass
 *  a normalized rel path — true for every current caller, but a future
 *  caller passing "./src/app/page.tsx" or an absolute path would have
 *  silently bypassed the check. Normalizing here closes that class. */
function normalizeRelPath(relPath: string): string {
  let s = relPath.replace(/\/+/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  // Absolute paths: strip the project root if present (the sandbox
  // contract; guards future callers that pass resolve() output).
  const rootPrefix = `${PROJECT_ROOT}/`;
  if (s.startsWith(rootPrefix)) s = s.slice(rootPrefix.length);
  else if (s.startsWith("/")) {
    // An absolute path OUTSIDE the project root can't be a project file —
    // return it as-is; it will never match a protected entry.
    return s;
  }
  const parts = s.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

/** Full protection check: exact file OR protected prefix. This is the
 *  single predicate scanFiles uses — keeping it here means adding a
 *  prefix or file protects it everywhere at once. Input is normalized
 *  first (see normalizeRelPath). */
export function isProtectedPath(relPath: string): boolean {
  const p = normalizeRelPath(relPath);
  if (PROTECTED_FILES.has(p)) return true;
  for (const prefix of PROTECTED_PREFIXES) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}
