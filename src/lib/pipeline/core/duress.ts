/**
 * Duress / Purge Protocol — the software analogue of PKM (Panic Key
 * Mechanism).
 *
 * Concept grafted from: craighckby-stack/PKM
 *   (tee/duress-ta/src/pkm_orchestrator.c — the §3 self-destruct sequence).
 *   See docs/CONCEPTS-GRAFTED.md GRAFT 2.
 *
 * The PKM hardware does: 3 deliberate power presses → mandatory KEYS
 * zeroize → degradable PURGE/BOOT/WP phases → HALT. Its two load-bearing
 * ideas, ported to LOOP, are:
 *
 *   1. DEGRADATION POLICY — one phase (KEYS) is mandatory; any failure there
 *      halts EVERYTHING (the forbidden end state is "a brick with intact
 *      keys" — here, "claims purged but the PAT is still on disk"). The
 *      other phases are degradable: a failure marks the run degraded but
 *      continues, because the data is already dead from Phase 1.
 *
 *   2. LOAD-BEARING READ-BACK — "Set without confirm = PKM_FAILED". After
 *      every destructive step, query the state back. The wall only exists
 *      if the query says so. Applied to LOOP: after purging the PAT, we
 *      re-read every tier; if the PAT is still readable anywhere, the
 *      purge FAILED and we halt.
 *
 * Trigger: anomaly detection. The system tracks consecutive push auth
 * failures (401/403 from GitHub). A small window of failures is normal
 * (token expired, transient). Past `DURESS_AUTH_FAILURE_THRESHOLD` in a
 * row, the system concludes the PAT may be under coercion (an attacker
 * probing/rotating it, or the operator's account compromised) and
 * executes the purge. An operator can also trigger it manually via the
 * API route.
 *
 * After purge: the `safe-mode` SystemFlag is set. The autonomous loop
 * reads `isSafeMode()` at the top of every cycle and refuses to run
 * (no mutate, no push) until an operator clears it via the API.
 */

import { db } from "@/lib/db";
import {
  purgeAllPatTiers,
  verifyPatGoneFromAllTiers,
} from "../autonomous/push-target";

// ── Runtime (in-memory) state ─────────────────────────────────────────
// The DB flag is the durable source of truth; this runtime flag is the
// fast path the loop reads every cycle (no DB round-trip). They are
// always set together; cleared together. A process restart rehydrates
// the runtime flag from the DB flag (see rehydrateSafeMode below).
//
// IMPORTANT: the runtime flag lives on globalThis, NOT a module-local
// `let`. Turbopack may create several module instances over the process
// lifetime (HMR, hot-swap pin clearing); a module-local `let` would be
// per-instance — a clear in one instance wouldn't propagate to another,
// leaving the loop stuck in safe-mode forever even after the operator
// cleared it. globalThis is the shared truth across all instances.
const __loopSafeModeSlot = globalThis as unknown as {
  __loopSafeMode?: { active: boolean; reason: string | null };
};
if (!__loopSafeModeSlot.__loopSafeMode) {
  __loopSafeModeSlot.__loopSafeMode = { active: false, reason: null };
}
function getRuntimeSafeMode(): boolean {
  return __loopSafeModeSlot.__loopSafeMode!.active;
}
function getRuntimeSafeModeReason(): string | null {
  return __loopSafeModeSlot.__loopSafeMode!.reason;
}
function setRuntimeSafeMode(active: boolean, reason: string | null): void {
  __loopSafeModeSlot.__loopSafeMode!.active = active;
  __loopSafeModeSlot.__loopSafeMode!.reason = reason;
}

// Consecutive push-auth-failure counter + purge no-re-entry guard.
// Both live on globalThis (same rule as the runtime safe-mode flag
// above): recordPushAuthFailure is imported from several route graphs,
// and a module-local `let` fragments the counter across instances — the
// 5-consecutive-401 auto-purge could then never reach threshold during
// a real PAT-compromise scenario.
const __duressCountersSlot = globalThis as unknown as {
  __duressCounters?: { authFailures: number; purgeRunning: boolean };
};
if (!__duressCountersSlot.__duressCounters) {
  __duressCountersSlot.__duressCounters = { authFailures: 0, purgeRunning: false };
}
const duressState = __duressCountersSlot.__duressCounters;

// Default: 5 consecutive 401/403 failures = purge. Tunable so an
// operator can raise it for a flaky-network environment or lower it
// to 1 for a paranoid mode.
const DURESS_AUTH_FAILURE_THRESHOLD = 5;

// ── Safe-mode flag (DB-backed, singleton key "safe-mode") ────────────

export interface SafeModeState {
  active: boolean;
  setBy: string | null;
  reason: string | null;
  setAt: string | null;
}

/** Read the safe-mode flag from the DB and hydrate the runtime cache.
 *  Called once at module load. Idempotent. */
export async function rehydrateSafeMode(): Promise<void> {
  try {
    const row = await db.systemFlag.findUnique({ where: { key: "safe-mode" } });
    if (row && row.value === "true") {
      setRuntimeSafeMode(true, row.reason);
    } else {
      setRuntimeSafeMode(false, null);
    }
  } catch {
    // DB unavailable — assume not in safe mode (the loop will surface a
    // warning if it can't reach the DB on a real cycle).
    setRuntimeSafeMode(false, null);
  }
}

/** Fast path: is the system in safe mode? Reads the runtime cache; the
 *  autonomous loop calls this at the top of every cycle. */
export function isSafeMode(): boolean {
  return getRuntimeSafeMode();
}

/** Full state for the UI. Always reads the DB (not the cache) so the
 *  UI can't lie about a stale cache. */
export async function getSafeModeState(): Promise<SafeModeState> {
  try {
    const row = await db.systemFlag.findUnique({ where: { key: "safe-mode" } });
    if (row && row.value === "true") {
      return { active: true, setBy: row.setBy, reason: row.reason, setAt: row.setAt.toISOString() };
    }
  } catch {
    /* DB unavailable — fall through to the runtime cache */
  }
  return { active: getRuntimeSafeMode(), setBy: null, reason: getRuntimeSafeModeReason(), setAt: null };
}

/** Raise the safe-mode flag. Sets BOTH the DB row (durable) and the
 *  runtime cache (fast). Idempotent. */
async function raiseSafeMode(setBy: string, reason: string): Promise<void> {
  setRuntimeSafeMode(true, reason);
  try {
    await db.systemFlag.upsert({
      where: { key: "safe-mode" },
      update: { value: "true", setBy, reason, setAt: new Date(), updatedAt: new Date() },
      create: { key: "safe-mode", value: "true", setBy, reason },
    });
  } catch {
    // DB unavailable — runtime flag still set; the loop will honor it
    // for the lifetime of this process. A restart would rehydrate from
    // a missing DB row as "not safe" — acceptable degradation.
  }
}

/** Raise the safe-mode flag from OUTSIDE the duress module — e.g. the
 *  gate-integrity probe (D5), which halts the loop when a deterministic
 *  probe proves a gate stopped doing its job. Same two-tier write as the
 *  internal path: runtime cache (honored by isSafeMode() at the top of
 *  every cycle) + durable DB row (survives restarts). The operator
 *  clears it through the normal path after verifying. */
export async function raiseSafeModeFlag(setBy: string, reason: string): Promise<void> {
  await raiseSafeMode(setBy, reason);
}

/** Clear the safe-mode flag (operator action). Clears BOTH tiers. */
export async function clearSafeMode(by: string = "operator"): Promise<{ cleared: boolean }> {
  setRuntimeSafeMode(false, null);
  duressState.authFailures = 0;
  try {
    await db.systemFlag.upsert({
      where: { key: "safe-mode" },
      update: { value: "false", setBy: by, reason: `cleared by ${by}`, setAt: new Date(), updatedAt: new Date() },
      create: { key: "safe-mode", value: "false", setBy: by, reason: `cleared by ${by}` },
    });
    // Load-bearing read-back: confirm the value actually flipped to "false".
    // If it didn't, the clear didn't take — re-raise the runtime flag so
    // the next isSafeMode() check is honest, and surface the failure.
    const readBack = await db.systemFlag.findUnique({ where: { key: "safe-mode" } });
    if (readBack && readBack.value !== "false") {
      console.error("[DURESS] clearSafeMode read-back MISMATCH — value still", readBack.value);
      setRuntimeSafeMode(true, `clear failed (DB value still ${readBack.value})`);
      return { cleared: false };
    }
  } catch (err) {
    console.error("[DURESS] clearSafeMode DB upsert threw:", (err as Error).message);
    /* DB unavailable — runtime flag cleared; restart rehydrates as not-safe */
  }
  return { cleared: true };
}

// ── Anomaly detection (the duress trigger) ────────────────────────────

/** Called by push-target after a successful push. Resets the
 *  consecutive-auth-failure counter. A single success clears the
 *  accumulated suspicion. */
export function recordPushSuccess(): void {
  duressState.authFailures = 0;
}

/** Called by push-target after a 401/403 from GitHub. Returns true if
 *  the threshold was crossed and the duress purge was auto-triggered.
 *  The caller (push-target) logs the trigger event. */
export async function recordPushAuthFailure(statusCode: number): Promise<{ triggered: boolean; reason?: string }> {
  // Only 401/403 count as "auth failure" — 429 (rate limit), 5xx, network
  // errors are NOT coercion signals, they're operational.
  if (statusCode !== 401 && statusCode !== 403) {
    return { triggered: false };
  }
  duressState.authFailures++;
  if (duressState.authFailures >= DURESS_AUTH_FAILURE_THRESHOLD) {
    const reason =
      `Duress auto-trigger: ${duressState.authFailures} consecutive push ` +
      `auth failures (401/403). PAT may be compromised or rotated; ` +
      `purging all tiers and entering safe mode.`;
    // Fire-and-forget the purge; recordPushAuthFailure stays synchronous
    // from the caller's perspective. The purge logs its own phases.
    void duressPurgePat({ reason, setBy: "duress:auto" }).catch(() => {
      // Even if the purge throws, the safe-mode flag is raised inside
      // it before any throw can escape — so the loop will still halt.
    });
    return { triggered: true, reason };
  }
  return { triggered: false };
}

/** Operator-facing count for the UI. */
export function getConsecutiveAuthFailures(): number {
  return duressState.authFailures;
}

// ── The PKM §3 purge sequence ─────────────────────────────────────────

export interface DuressPurgeResult {
  /** Sequence-level status: COMPLETE (all mandatory + degradable steps
   *  ran), DEGRADED (some degradable steps failed but KEYS succeeded),
   *  FAILED (Phase 1 KEYS failed — the forbidden end state was caught
   *  and the system halted before claiming success). */
  outcome: "COMPLETE" | "DEGRADED" | "FAILED";
  /** Phase 1 KEYS: was the PAT purged from ALL three tiers? Mandatory. */
  keysPurged: { tier2: boolean; tier3: boolean; db: boolean };
  /** Phase 4 READ-BACK: is the PAT confirmed gone from all tiers? */
  readBack: { tier2Gone: boolean; tier3Gone: boolean; dbGone: boolean; allGone: boolean };
  /** Safe-mode flag was raised (Phase 3). */
  safeModeRaised: boolean;
  /** Degradation flags from the degradable phases. */
  degraded: string[];
  /** Final reason recorded. */
  reason: string;
  /** ISO timestamp the sequence started. */
  startedAt: string;
  /** ISO timestamp the sequence finished. */
  finishedAt: string;
}

/**
 * Execute the duress/purge sequence. Implements PKM §3 with LOOP's
 * three-tier PAT persistence as the KEYS phase.
 *
 * PHASE 1 — KEYS (MANDATORY). Purge the PAT from all three tiers
 * (root state file, .git/info state file, DB row). Any failure here
 * halts the sequence with outcome FAILED — the forbidden end state is
 * "claims purged but the PAT is still on disk", and we refuse to
 * report success if we can't prove destruction.
 *
 * PHASE 2 — CACHE (DEGRADABLE). Clear the in-memory runtime caches.
 * Failure is non-fatal (the data is already dead from Phase 1).
 *
 * PHASE 3 — SAFE-MODE (DEGRADABLE). Raise the safe-mode flag (DB + runtime)
 * so the autonomous loop refuses to run any further cycles. Failure
 * here degrades the run but the loop will still halt on the next cycle
 * because the runtime flag is set in-memory before the DB write.
 *
 * PHASE 4 — READ-BACK (DEGRADABLE). Re-read every tier and confirm the
 * PAT is GONE. This is the load-bearing read-back. If any tier still
 * shows a PAT, mark degraded (we can't prove destruction) and ensure
 * safe-mode is raised — the system stays halted until an operator
 * investigates.
 *
 * PHASE 5 — HALT. Write a critical postmortem recording the purge. The
 * autonomous loop will see safe-mode on its next tick and refuse to run.
 *
 * No-re-entry: if a purge is already in progress, returns immediately
 * with a FAILED outcome and the reason "re-entry blocked" (PKM
 * SEQ_RUNNING guard).
 */
export async function duressPurgePat(opts: {
  reason: string;
  setBy?: string;
}): Promise<DuressPurgeResult> {
  const startedAt = new Date().toISOString();
  const setBy = opts.setBy ?? "duress";
  const degraded: string[] = [];

  // No-re-entry guard (PKM SEQ_RUNNING).
  if (duressState.purgeRunning) {
    return {
      outcome: "FAILED",
      keysPurged: { tier2: false, tier3: false, db: false },
      readBack: { tier2Gone: false, tier3Gone: false, dbGone: false, allGone: false },
      safeModeRaised: getRuntimeSafeMode(),
      degraded: ["re-entry blocked"],
      reason: `${opts.reason} (re-entry blocked — a purge was already running)`,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  duressState.purgeRunning = true;

  try {
    // ── PHASE 1 — KEYS (MANDATORY) ────────────────────────────────
    // Pure destruction of the PAT across all tiers. The caller
    // (push-target) cannot leave the system in a "half-purged" state.
    let keysPurged: { tier2: boolean; tier3: boolean; db: boolean };
    try {
      keysPurged = await purgeAllPatTiers();
    } catch (err) {
      // A throw in Phase 1 is the worst case — we attempted destruction
      // and something blew up before we could confirm. Treat as FAILED.
      keysPurged = { tier2: false, tier3: false, db: false };
      degraded.push(`Phase 1 KEYS threw: ${(err as Error).message.slice(0, 200)}`);
    }
    const keysOk = keysPurged.tier2 && keysPurged.tier3 && keysPurged.db;
    if (!keysOk) {
      // Forbidden end state caught. Raise safe-mode anyway (belt-and-
      // suspenders — the runtime flag is set in-memory next), then halt.
      try { await raiseSafeMode(setBy, `${opts.reason} (Phase 1 KEYS failed)`); } catch (e) { /* best-effort */ }
      return {
        outcome: "FAILED",
        keysPurged,
        readBack: { tier2Gone: false, tier3Gone: false, dbGone: false, allGone: false },
        safeModeRaised: getRuntimeSafeMode(),
        degraded,
        reason: `${opts.reason} — Phase 1 KEYS failed (tier2=${keysPurged.tier2}, tier3=${keysPurged.tier3}, db=${keysPurged.db}). PAT NOT confirmed purged.`,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    // ── PHASE 2 — CACHE (DEGRADABLE) ──────────────────────────────
    // The runtime safe-mode cache + auth-failure counter. These are
    // in-process only; a process restart clears them. Non-fatal.
    try {
      duressState.authFailures = 0;
    } catch (err) {
      degraded.push(`Phase 2 CACHE degraded: ${(err as Error).message.slice(0, 200)}`);
    }

    // ── PHASE 3 — SAFE-MODE (DEGRADABLE) ───────────────────────────
    // Raise the flag so the autonomous loop halts on its next tick.
    let safeModeRaised = false;
    try {
      await raiseSafeMode(setBy, opts.reason);
      safeModeRaised = true;
    } catch (err) {
      degraded.push(`Phase 3 SAFE-MODE degraded: ${(err as Error).message.slice(0, 200)}`);
      // Still set the runtime flag in-memory so this process halts.
      setRuntimeSafeMode(true, opts.reason);
      safeModeRaised = true;
    }

    // ── PHASE 4 — READ-BACK (DEGRADABLE) ───────────────────────────
    // Load-bearing: "the wall only exists if the query says so."
    let readBack: { tier2Gone: boolean; tier3Gone: boolean; dbGone: boolean; allGone: boolean };
    try {
      readBack = await verifyPatGoneFromAllTiers();
    } catch (err) {
      readBack = { tier2Gone: false, tier3Gone: false, dbGone: false, allGone: false };
      degraded.push(`Phase 4 READ-BACK threw: ${(err as Error).message.slice(0, 200)}`);
    }
    if (!readBack.allGone) {
      degraded.push(
        `Phase 4 READ-BACK: PAT still detectable (tier2=${readBack.tier2Gone}, tier3=${readBack.tier3Gone}, db=${readBack.dbGone}). Safe-mode stays raised.`
      );
      // Ensure safe-mode is raised even if Phase 3 degraded.
      if (!getRuntimeSafeMode()) {
        setRuntimeSafeMode(true, `${opts.reason} (read-back could not confirm purge)`);
      }
    }

    // ── PHASE 5 — HALT ────────────────────────────────────────────
    // The autonomous loop reads isSafeMode() on its next tick and
    // refuses to run. We also write a postmortem here so the system's
    // own failure memory records the purge. The postmortem write is
    // best-effort — if the DB is unavailable, the safe-mode runtime
    // flag is what actually halts the loop.
    try {
      const { postmortemStore } = await import("../postmortem/postmortem-store");
      await postmortemStore.recordFailure({
        repo: "self",
        branch: "main",
        filePath: "system:duress",
        observed: false, // system event, not an observation of a real file
        failureType: "OTHER",
        symptom: "Duress purge executed",
        evidence: JSON.stringify({ keysPurged, readBack, safeModeRaised, reason: opts.reason }),
        constraints: `The system executed a duress purge. Reason: ${opts.reason}. ` +
          `PAT is ${readBack.allGone ? "confirmed purged" : "NOT confirmed purged — investigate"}. ` +
          `Safe-mode is raised. An operator must clear it via the API after verifying the PAT situation.`,
      });
    } catch (err) {
      degraded.push(`Phase 5 HALT postmortem degraded: ${(err as Error).message.slice(0, 200)}`);
    }

    const outcome: DuressPurgeResult["outcome"] =
      degraded.length === 0 && readBack.allGone
        ? "COMPLETE"
        : readBack.allGone
          ? "DEGRADED"
          : "FAILED";

    return {
      outcome,
      keysPurged,
      readBack,
      safeModeRaised,
      degraded,
      reason: opts.reason,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } finally {
    duressState.purgeRunning = false;
  }
}

// Rehydrate the runtime safe-mode flag on module load so a process
// restart doesn't silently drop a safe-mode state the DB still holds.
void rehydrateSafeMode();