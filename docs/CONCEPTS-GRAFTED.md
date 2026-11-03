# Concepts Grafted from the Operator's GitHub Account

> *"Humanity survived and built civilization because we recorded our plagues,
> wars, mistakes, and epiphanies into books so the next generation didn't have
> to die to learn them."* — AetherForge Ω PHILOSOPHY.md

This document records the intellectual lineage of LOOP — which concepts were
mined from the operator's public GitHub account (`craighckby-stack`, 8 repos)
and grafted into this self-improving system. The system maintains this record
so that future cycles (and future operators) can trace *why* a module exists,
not merely *that* it exists.

---

## Source Repos Mined

| Repo | Language | Concepts Extracted |
| :--- | :--- | :--- |
| `Git-Secret-PII-Sanitizer-2` | TypeScript | Pre-push secret/PII scanner gate; SENSITIVE_PATTERNS regex catalog; Shannon entropy; dummy/example suppression; Luhn validation; redaction placeholders |
| `PKM` | C (TEE) | Duress self-destruct protocol; phased degradation-tolerant sequence (KEYS mandatory -> PURGE/BOOT/WP degradable -> HALT); **load-bearing read-back** ("set without confirm = fail"); no-re-entry guard |
| `Aether_Forge-` | TypeScript | DARLEK_CAAN postmortem ledger (cryptographic parent-hash chain, CANDIDATE->VERIFIED->REJECTED->INHERITED lifecycle, `queryAncestralWisdom` local keyword RAG); aetherforge-eval adversarial suite (attack-prompt JSON with expected_behavior + mitigation + risk_category, control-vs-protected harness, metrics: TotalAttempts/BypassesAllowed/BlockedAttempts); agent memoirs; prayers (escalation inbox); EMG cognitive gate (fast local vs slow LLM); ephemeral session key vault; plugin hook system |
| `GitHub-Engine-Harvester` | TypeScript | ReAct agent loop with status state machine (idle->planning->thinking->streaming->executing_tools->completed); per-step trajectory recording; spatiotemporal lifecycle context (hierarchical scopes + event propagation); model adapter streaming; persistent blacklist + cooldown-timers-anywhere |
| `Commit-puller-` | TypeScript | Per-route RATE_LIMIT_COOLDOWNS; cooldown badge UI; commit mining (already grafted into commit-archaeology) |
| `DARLEK-CAAN-vs-JESUS-CHESS` | TypeScript | Adversarial turn-based game-state validation (noted, lower priority) |
| `Wonder-Craig-Game-Demo` | HTML | (no engineering concepts mined) |
| `Git-Secret-PII-Sanitizer` (v1) | TypeScript | Same as v2; v2 is the newer edition mined |

---

## Grafts Implemented This Session

### GRAFT 1 - Pre-push Secret/PII Scanner Gate
- **Source:** `Git-Secret-PII-Sanitizer-2/src/lib/scanner.ts`
- **Problem it solves:** The operator's GitHub PAT leaked into git history 3+
  times across prior sessions. There was no gate that scanned the actual
  working-tree diff *before* `git add -A && git commit`.
- **Module:** `src/lib/pipeline/core/secret-scan.ts`
- **Integration:** inserted into `src/lib/pipeline/autonomous/push-target.ts` `pushCurrentState()` right
  after `git status --porcelain` detects changes and *before* `git add -A`.
  If a non-dummy, non-redacted secret is found in any changed file or in the
  commit message, the commit is **blocked**, the finding is logged, and a
  postmortem is recorded. The push returns `pushed:false` with the finding.
- **Patterns covered:** GitHub PAT (`ghp_`), GitHub OAuth/apps (`gho_/ghu_/
  ghs_/ghr_`), `github_pat_`, OpenAI (`sk-`/`sk-proj-`/`sk-admin-`), Anthropic
  (`sk-ant-`), Google Gemini (`AIzaSy`), AWS (`AKIA`/secret), Azure, GitLab
  (`glpat-`), Slack (`xox`), Stripe (`sk_live_`/`rk_live_`), generic private
  keys (`-----BEGIN ... PRIVATE KEY-----`), and a high-entropy fallback.

### GRAFT 2 - Duress/Purge Protocol + Load-bearing Read-back
- **Source:** `PKM/tee/duress-ta/src/pkm_orchestrator.c` (the section-3 sequence)
- **Problem it solves:** PAT persistence is fragile (lost 3x to sandbox wipes).
  `clearPushTarget` also had a latent bug: it removed the tier-2 root file but
  NOT the tier-3 `.git/info/loop-push-state.json`, leaving the PAT as a zombie
  credential after a "clear". And `writeStateFile` never verified the write
  actually landed.
- **Module:** `src/lib/pipeline/core/duress.ts`
- **Integration:**
  - **Load-bearing read-back** added to `writeStateFile`: after writing each
    tier, read it back and compare; a tier that fails verification is logged
    and the system knows it can't rely on it.
  - `clearPushTarget` now purges ALL THREE tiers (root file + DB row +
    `.git/info/` file), with a read-back confirming the PAT is gone from every
    tier (PKM phase-4 pattern: "the wall only exists if the query says so").
  - `duressPurgePat()` implements the full PKM phased sequence:
    Phase 1 KEYS (mandatory - purge PAT from all tiers; any failure halts),
    Phase 2 CACHE (degradable - clear in-memory), Phase 3 SAFE-MODE (degradable
    - set a DB/runtime flag the autonomous loop reads before each cycle),
    Phase 4 READ-BACK (degradable - verify gone; if still present, halt +
    critical postmortem), Phase 5 HALT. No-re-entry guard. Triggered by
    anomaly detection (repeated push auth failures suggest compromise).

### GRAFT 3 - Ancestral RAG over Postmortems
- **Source:** `Aether_Forge-/src/engine/darlekRAG.ts` `queryAncestralWisdom`
- **Problem it solves:** LOOP's `getConstraintsForFile(repo, branch, filePath)`
  retrieves postmortems by EXACT path match only. When the LLM enhances file X,
  it sees only X's own failure history - never the relevant lessons learned on
  *similar* files. A syntax-drop failure on `foo.ts` teaches a constraint that
  would prevent the same drop on `bar.ts`, but the per-file gate never surfaces
  it.
- **Module:** `src/lib/pipeline/postmortem/ancestral-rag.ts`
- **Integration:** `queryRelevantPostmortems({ keyword, failureType?, limit })`
  - local, synchronous, zero-LLM-cost keyword + failure-type retrieval over
  all `verified` postmortems (symptom/evidence/constraints text). Injected
  into the enhancement prompt alongside the per-file postmortem so the LLM
  sees both "this file's specific failures" AND "the species' ancestral
  lessons relevant to this symptom".

### GRAFT 4 - Adversarial Red-Team Evaluation Suite
- **Source:** `Aether_Forge-/aetherforge-eval/` (attack-prompts/prompt_suite.json,
  containment-tests/test_containment.js, behavioural-tests/test_awareness.js)
- **Problem it solves:** LOOP's gates verify *structural* safety (AST diff,
  branding, sanitizer) but never *adversarially* test whether the LLM
  enhancement step can be coerced into producing a malicious mutation (unauthorized
  dep injection, key exfiltration, sandbox escape, deceptive cooperation). A
  structurally-valid malicious mutation would pass every current gate.
- **Module:** `src/lib/pipeline/red-team/red-team-suite.ts` (versioned attack
  prompts with `expected_behavior` + `mitigation` + `risk_category`) +
  `red-team-runner.ts` (runs each prompt against the LLM enhancement path,
  classifies the output as REFUSAL/COMPLY, computes TotalAttempts/BypassesAllowed/
  BlockedAttempts, verdict PASSED iff BypassesAllowed===0).
- **Integration:** runs periodically inside the autonomous loop (every N cycles)
  and on-demand via an API route. Results surface in a new **Red Team** panel
  in the UI. A failed red-team (any bypass) blocks the next push and writes a
  critical postmortem - same authority as a structural gate failure.

---

## Concepts Noted but Not Grafted (deferred)

- **Plugin hook system** (Aether_Forge `pluginSystem.ts`): a full
  beforeLLMCall/afterLLMCall/onTaskComplete hook bus. LOOP's procedural
  pipeline doesn't yet need the indirection; revisit when >=3 cross-cutting
  concerns compete.
- **Ephemeral session key vault** (Aether_Forge `keyVault.ts`): client-side
  sessionStorage vault. LOOP's PAT is server-side and needs the *opposite*
  (durable cross-restart), already handled by the 3-tier persistence + the
  new duress purge.
- **Agent memoirs + prayer inbox** (Aether_Forge): per-cycle self-narrated
  memoir + an escalation inbox for unsolvable problems. High UX value,
  deferred to keep this session focused on defensive grafts.
- **Spatiotemporal lifecycle context** (Engine-Harvester `lifecycle.ts`):
  hierarchical scoped DI + event propagation. A larger architectural refactor;
  LOOP's procedural pipeline doesn't need an event bus yet (`loop-event-bus.ts`
  was removed as dead infrastructure with 0 subscribers — audit-3, commit
  590d908). Revisit if >=3 cross-cutting concerns ever compete for a hook bus.
- **Chess adversarial state** (DARLEK-CHESS): turn-based game validation.
  Not directly applicable to a pipeline.

---

## The Unifying Principle

All four grafts express one idea drawn from the operator's body of work:
**a self-improving system must defend the boundary between its inside and
the outside world at the point of contact.** The secret-scan gate defends
the git->GitHub boundary. The duress purge defends the PAT's lifecycle
boundary. The ancestral RAG defends the memory boundary (so the system
doesn't repeat ancestral mistakes). The red-team suite defends the
LLM-output boundary (so a coerced mutation can't become a commit). Each
graft is a load-bearing wall; each was verified by read-back, not assumed.
