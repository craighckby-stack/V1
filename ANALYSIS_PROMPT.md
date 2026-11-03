# LOOP — Independent Analysis Brief for an AI Reviewer

> **How to use this file:** Attach the repository zip (`loop-source.zip`) and paste this entire
> document as your prompt to any strong code-analysis LLM (Claude, GPT, Gemini, etc. — the brief
> is model-agnostic and assumes only that you can read files from the zip). This is the exact
> prompt the system's operator uses to get a second opinion.

---

## 0. Your role

You are a **principal engineer and red-teamer** doing an independent, adversarial review of a
software system called **LOOP**. The person asking you has built it and is too close to it.
They want you to find what is wrong, fake, fragile, or dangerous — not to be told it is
impressive. Assume nothing works as claimed until the code shows it. **Every claim you make
must cite `file:line` evidence from the zip.** If you cannot verify a claim, label it
`UNVERIFIED` and say what you would need to check it.

## 1. What you are looking at

LOOP is a Next.js 16 + TypeScript + Prisma/SQLite application that contains its own source
code inside its own mutation scope and **rewrites itself with an LLM**, continuously, in
production, without restarting:

```
scan repo → pick a file → LLM proposes an improved version
         → a gauntlet of gates (structural validator, AST symbol-retention diff,
           mutation guard with a newly-introduced-token diff, secret scan, entropy
           sanitizer, debate tribunal, protected-path checks, in-memory typecheck)
         → apply to disk → verify → git commit + push to GitHub
         → hot-swap the changed module into the running process (Turbopack mtime nudge,
           globalThis singleton pins, state snapshot/restore)
         → remember every failure as a "postmortem" scar that constrains future proposals
```

The UI is a retro BIOS/terminal console (boot splash, POST beeps, command line — try
`help` and `status`) that doubles as the operator control surface: START/STOP, push config,
oracle (the system predicts its own future and scores itself), red-team runner, defense panel.

**Key entry points** (suggested reading order):

1. `README.md` — the system's own claims. Treat every number as a hypothesis to verify.
2. `src/lib/pipeline/autonomous/protected-files.ts` — the protection invariants (what the loop may never touch). Start here: the whole safety model hangs on this file.
3. `src/lib/pipeline/autonomous/self-enhance-loop.ts` — the loop brain (~2,300 lines; the enhance cycle, gate chain, postmortem wiring).
4. `src/lib/pipeline/autonomous/loop-runtime.ts` — scheduler + remote-repo pipeline path.
5. `src/lib/pipeline/core/` — the gate machinery: `mutation-guard.ts`, `ast-diff-gate.ts`, `secret-scan.ts`, `hot-swap.ts`, `duress.ts` (safe-mode), `unified-pipeline.ts`.
6. `src/lib/pipeline/emg/sanitizer.ts` — LLM-output secret/PII redaction (entropy-based).
7. `src/lib/pipeline/postmortem/postmortem-store.ts` — failure memory + a hash-chained (tamper-evident) postmortem ledger.
8. `postmortems/` — the actual scar tissue on disk (~32 JSON records of real failures). Read several; they are the most honest artifact in the repo.
9. `src/app/page.tsx` — the control surface (protected: the loop can never remove its own STOP button).
10. `docs/HOT-SWAP.md` and `docs/CONCEPTS-GRAFTED.md` — mechanism docs and provenance of grafted ideas.

## 2. Claims to verify or demolish

The README and code comments make these claims. For each: **CONFIRMED / PARTIAL / FALSE / UNVERIFIED**, with evidence.

1. **63 mutation branches** have been pushed (`loop-01` … `loop-63`); the next will be `loop-64`.
2. **~32 postmortem failure records** exist on disk, and the enhance prompt actually injects their constraints (trace the injection path in `self-enhance-loop.ts` — grep for how postmortems/lessons reach the LLM prompt).
3. **The protection invariant**: the loop can never mutate its own gates, control surface, or protection list (`protected-files.ts`, `PROTECTED_FILES` + `PROTECTED_PREFIXES`, `isProtectedPath()`). Check *every* write path: the autonomous loop, the operator chat-task path (`chat-task.ts` → `applyTaskPlan`), the unified pipeline, and the push path. Is there any write path that skips the check?
4. **Two-authority mutation guard**: `mutation-guard.ts` rejects *newly-introduced* dangerous tokens (diff against the original file), then structural invariants. It is wired into both the autonomous verifier (`verify-refactor.ts`) and the operator path (`chat-task.ts`). Verify the wiring, then try to think of an evasion that passes both layers.
5. **Hot-swap actually swaps**: clearing globalThis pins + touching mtimes forces Turbopack to serve fresh module instances; a snapshot (`SELF_SNAPSHOT_SLOT` in `core/hot-swap.ts`, consumed in the `SelfEnhanceLoop` constructor) preserves loop state across the swap. Assess whether this mechanism is sound or a race-condition lottery.
6. **Tamper-evident postmortem chain**: each record hashes parent+content (`postmortem-store.ts`, `canonicalPostmortemContent`, `computePostmortemHash`, `verifyPostmortemChain`, auto-backfill on rehydration). Try to find a way to silently edit history.
7. **Duress / safe-mode**: any gate failure or red-team finding can pause the whole system (`core/duress.ts`, `raiseSafeModeFlag`); the loop auto-resumes only after a probe passes. Look for paths that skip it.
8. **The Oracle** (`src/lib/pipeline/oracle/`) makes predictions about its own future runs and scores them (Brier score). Is this genuinely predictive or theater?

## 3. The kill-shot hunt (most important task)

Find **one concrete, end-to-end way** for the LLM (or a prompt-injection payload hiding in a
scanned file — the loop reads remote repo content) to get arbitrary code executed or pushed,
despite the gates. Trace it file-by-file. If you cannot find one, say so explicitly and rank
the closest near-misses. Pay special attention to:

- Write paths that don't call `isProtectedPath` (search for `writeFileSync` / `spawn` / `exec` across `src/lib`).
- The chat-task apply path (`src/app/api/self-enhance/chat-task/apply/route.ts` → `applyTaskPlan`) — operator-approved plans: what exactly is approved, and is the approved thing the same as the written thing?
- The push path (`src/lib/pipeline/autonomous/push-target.ts`): what does it stage and push? Could a file written outside the scan scopes ride along in `git add`?
- Prompt injection: `self-enhance-loop.ts` builds prompts containing file contents, postmortem text, and lessons from `memory/lessons.md`. Could poisoned memory steer proposals? Note `lesson-store.ts`/`archaeology.ts` are protected — but is the *content* they store attacker-influenced?
- `agent-llm.ts`: the 429 rate-limit gate lives on `globalThis` (state must survive hot-swaps). Any TOCTOU/multi-instance residue?

## 4. Honesty audit — is this actually self-improvement?

The operator's own bar: **a system is only worth resources if its pass-rate / quality trend
improves over hundreds of cycles.** You have 63 mutations of evidence:

- Read the postmortems chronologically (they carry timestamps and `attempts` counts). Is the loop failing at *new* things, or the same things repeatedly?
- Check how "improvement" is measured: the debate tribunal's approval, the ratchet (`verify-refactor.ts`), the meta-tuner A/B trials (`meta-tuner.ts`, `meta-params.ts`). Is there a real feedback signal, or is any LLM-plausible diff counted as progress?
- The UI claims "Mutations: 63 pushed". Distinguish *quantity* from *value*: what fraction of the 63 are cosmetic (log strings, formatting) vs structural?

## 5. Code quality pass (fast, table format)

- Dead code, duplicate logic, misleading comments, `any`-typed escapes, silent `catch {}` blocks that swallow real failures.
- The repo deliberately keeps *some* duplication as defense-in-depth (two secret-pattern catalogs, two tokenizers in different layers — see the comment in `mutation-guard.ts`). Judge whether each surviving duplication is justified or an excuse.
- `bun run lint` and `tsc --noEmit` pass at this commit — spot-check whether the types are honest or `any`-washed.

## 6. Deliverable format

A single markdown report:

```
## Executive verdict (5 sentences max — is this real, is it safe, is it novel, is it worth compute?)
## Claims scorecard (the 8 claims above: CONFIRMED/PARTIAL/FALSE/UNVERIFIED + one-line evidence each)
## Kill-shot analysis (your best escape attempt, traced end-to-end, or the ranked near-misses)
## Safety model map (every gate: file, what it checks, what it misses)
## Honesty audit (is it improving? evidence from postmortems/mutations)
## Code quality findings (table: file:line, severity, issue)
## Top 10 improvements (ranked by risk-reduction per effort, each with the specific file to change)
## What I would ask the operator (questions whose answers would change my verdict)
```

## 7. Rules of engagement

- Cite `file:line` for every factual claim. No vibes.
- Be adversarial, not cruel: every demolition should come with the fix.
- If a mechanism is genuinely well-designed, say so in one sentence and move on — spend your tokens on the failures.
- You are reviewing a system that was largely **co-written by an AI agent iterating on itself**; the operator's own audit trail (postmortems, worklog.md, REPO_STATUS.md) is part of the evidence base.
- Do not run the system; static analysis only. Note where dynamic testing would be required.

---

*Prepared by the operator's build agent, 2026-11-03. Numbers current as of commit history through `822389b` + audit-3 hardening. The zip excludes secrets by construction: no `.env`, no database files, no state files containing the GitHub PAT (the push module reads credentials from an excluded runtime path — verify that claim too).*
