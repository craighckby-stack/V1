# LOOP Post-Endurance Upgrade Spec — review response

**Operator verdict: 2026-11-26. APPROVED in full, sequenced.**

> Provenance note: this spec was submitted for review in-conversation during
> the endurance run and never persisted — the original text is lost to the
> session that carried it. This document is the surviving record: the
> reconstructed spec, the review verdicts, and the conditions attached. It
> lives here so the decision outlives the conversation it was posed in.
> If the original text resurfaces and disagrees with this reconstruction,
> the operator ruling below governs.

The spec proposed three post-endurance capabilities. Review verdicts:

---

## 1. Saturation autonomy — APPROVED, SHIPPED 2026-11-26 (pulled forward)

**As specified:** saturated files re-enter rotation without operator
interaction.

**As implemented:** the auto-relock backoff (`saturation.ts`
`relockCooldownMs`): each no-growth re-lock doubles the cooldown from a 5m
base (2^(lockCount-1)), capped at 24h. `lockCount` survives manual unlocks
by design — the escalation IS the churn control. The `[unlock]` buttons are
PINless; the master-PIN tier (operator 691 + master 4444 + the persisted
bypass session) was retired the same day; the single remaining PIN guards
unfreezing the mutation freeze.

**Why it shipped mid-run instead of post-close:** the endurance run itself
needed it. Most files had saturated and every lock required operator
attention — which contradicted the run's zero-interaction rule. The change
removed an operator dependency without adding risk: every write still
passes the full gate chain (mutation-guard → structural → AST → syntax →
lint → typecheck → debate → sandbox).

**Evidence it works:** converged files now self-release on their own
schedule; unlock-spamming a converged file buys it exponentially longer
peace, not a PIN prompt.

---

## 2. Finding ledger — APPROVED WITH CONDITIONS, after run close (2026-12-04)

**The idea:** a persistent, append-only record of observations the loop
makes that don't warrant a mutation — dead exports, unreachable branches,
cross-file facts, suspicious patterns. Today those observations evaporate
unless they become mutations. The postmortem chain records failures; the
lesson store records general rules; nothing records *things noticed*.

**Why it matters more now:** with most files saturated, converged cycles
still burn a full scan and produce nothing durable. A ledger turns the
saturated loop from a mutation engine into an observation engine — but only
if observations persist.

**Conditions attached by this review:**

1. **Append-only, postmortem-chain class** — tamper-evident (parentHash
   chain), never pruned, wipe-proof disk tier + DB.
2. **Bounded prompt injection** — the ledger may feed context only through
   a capped window (the MutationCorpus ≤300-row digest pattern), never
   wholesale. An uncapped ledger is a prompt-bloat vector that degrades the
   mutation quality it is meant to improve.
3. **Operator-readable** — surfaced in the dashboard with an honest count.
4. **Written by the scan pass, not a new LLM call** — observations must
   stay free during idle cycles. A ledger that costs quota during
   saturation defeats its own purpose.

**Suggested shape:** a `Finding` model (17 → 18) + a postmortems-style disk
chain + a bounded RAG read mirroring `ancestral-rag.ts`.

---

## 3. Dataset export — APPROVED WITH CONDITIONS, after run close

**The idea:** one command that exports the run's accumulated data —
`AutonomousCycle`, `PipelineRun`, `MutationCorpus`, the postmortem chain +
disk JSON, the lesson store, self-model snapshots, saturation states, health
snapshots, the machine-readable self-description — into a versioned,
parsable bundle for offline analysis and publication.

**Why it matters:** the 10-day run's data IS the experiment's product.
Locked in SQLite + `.git/info/` tiers it is neither analyzable nor citable.
The baseline snapshot (1385 / 845 / 825 / 1048 / 25 at 2026-11-24 13:11)
plus the closing snapshot brackets the claim the run makes.

**Conditions attached by this review:**

1. **Secret-scan gate over the assembled bundle** before it lands anywhere
   (PAT, env, sealed envelopes never — reuse the existing pre-commit
   scanner on the bundle).
2. **Operator-triggered only** — a script (`scripts/export-dataset.ts`),
   NOT a loop-reachable API route. The export is an operator instrument,
   the same protection class as `audit-remote.ts`.
3. **Schema-versioned JSON with a manifest** — schemaVersion, run window,
   baseline + closing stats, environment, tool versions — so the bundle
   stays parsable post-hoc.
4. **Include the provenance chain hashes** (postmortem `parentHash` chain)
   so the bundle is self-verifying.

**Sequencing rationale:** mid-run exports are snapshots of an incomplete
experiment; the valuable export is the closing one. Build after close, run
once at close, re-run on demand.

---

## Sequencing summary

| Item | Verdict | When |
|---|---|---|
| Saturation autonomy | Approved, shipped | 2026-11-26 (mid-run, the run needed it) |
| Finding ledger | Approved + 4 conditions | After 2026-12-04 close |
| Dataset export | Approved + 4 conditions | After 2026-12-04 close |

The two post-close items become the first entries of the post-endurance
README outline: when the run closes, the endurance framing retires into a
results retrospective, and this spec's remaining items lead the "what
builds next" section. The README rewrite and these two builds land as one
post-close pass.
