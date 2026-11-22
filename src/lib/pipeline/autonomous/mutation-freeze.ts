/**
 * Mutation freeze — the operator's "stop evolving, hold this state" lock.
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * The armed tier (self-enhance-armed-state.ts) answers "should the loop
 * run?". The freeze answers a DIFFERENT question: "may the system's own
 * code be mutated at all?" — a lock the operator throws when the system
 * has reached the state they want to keep, deliberately decoupled from
 * start/stop so it can never be flipped by an accidental [START] press
 * or an auto-start path.
 *
 * Semantics: while frozen, EVERY code-mutation surface refuses —
 *   - runCycle / the SelfTask drain / enhanceFile's live write
 *   - executeTask (belt-and-braces for any future caller)
 *   - pushCurrentState (commits AND pushes — the repo state is locked)
 *   - executeMergeBack (merging loop branches into main mutates main)
 *   - chat-task's applyTaskPlan (operator-approved writes included: the
 *     point of the freeze is that NOTHING changes the code, including us)
 * The system keeps OPERATING: the dashboard, status/health endpoints,
 * dropbox ingest, oracle feed, and the worker process itself all stay
 * live. Only the mutation machinery stands down.
 *
 * WIPE-PROOF TIER (same contract as the armed state):
 *   .git/info/loop-mutation-freeze.json — never tracked, never committed,
 *   survives process restarts and sandbox rollbacks. Guards in BOTH the
 *   Next.js server and the loop-worker read this file live (shared
 *   filesystem), so a freeze lands instantly in every process with no
 *   restart and no message passing.
 *
 * WRITE AUTHORITY: only the freeze control route
 * (POST /api/self-enhance/freeze) writes this file — freezing needs no
 * PIN (locking down is the safe direction), unfreezing requires the
 * operator PIN. The LOOP never imports the writer; tests are refused
 * outright (see the test-origin guard) so a test run can never freeze
 * or thaw production — the exact pollution class that once armed the
 * loop "by test-run".
 *
 * Fail-open on read: a missing/torn/malformed file reads as NOT frozen
 * (the system keeps its normal behavior). atomicWriteFileSync makes
 * torn writes impossible in practice; if the file is ever unreadable
 * the operator sees the FROZEN chip disappear and can re-freeze. A lock
 * that bricks the system on a bad read would be worse than the hole.
 */
import { mkdirSync, readFileSync } from "fs";
import { atomicWriteFileSync } from "../core/atomic-file";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";

const FREEZE_FILE = PROJECT_ROOT
  ? join(PROJECT_ROOT, ".git/info/loop-mutation-freeze.json")
  : undefined;

export interface MutationFreezeState {
  /** The operator's lock. true = all code mutation surfaces refuse. */
  frozen: boolean;
  /** ISO timestamp of the last change. */
  at: string;
  /** What made the change (e.g. "operator-freeze"). */
  by: string;
  /** Optional operator note — why the system was locked. */
  reason?: string;
}

/** True when running under a test runner (bun:test / vitest / NODE_ENV).
 * Test runs must NEVER write production intent tiers — see
 * self-enhance-armed-state.ts for the pollution incident this guards. */
function isTestOrigin(): boolean {
  return (
    process.env.BUN_TEST === "1" ||
    process.env.VITEST === "1" ||
    process.env.NODE_ENV === "test"
  );
}

/** Persist the freeze intent. Never throws — a persistence failure must
 *  never fail the control route that already decided (the file is the
 *  restart tier; the guards re-read it live). Refuses test-origin writes
 *  so no test can freeze or thaw the production system. */
export function markMutationFrozen(
  frozen: boolean,
  by: string,
  reason?: string
): void {
  if (!PROJECT_ROOT || !FREEZE_FILE) {
    console.error(
      "markMutationFrozen: Cannot write freeze state because PROJECT_ROOT is undefined. Persistence skipped."
    );
    return;
  }
  if (isTestOrigin()) {
    // Refuse outright — a test writing the production freeze tier is the
    // same class of pollution as the "armed by test-run" incident.
    console.error(
      `markMutationFrozen: refused test-origin write (frozen=${frozen}, by=${by}) — tests must never touch the production freeze tier.`
    );
    return;
  }
  if (typeof frozen !== "boolean") {
    console.error("markMutationFrozen: 'frozen' must be a boolean.");
    return;
  }
  if (typeof by !== "string" || by.trim().length === 0) {
    console.error("markMutationFrozen: 'by' must be a non-empty string.");
    return;
  }

  try {
    const infoDir = join(PROJECT_ROOT, ".git/info");
    mkdirSync(infoDir, { recursive: true });
    const entry: MutationFreezeState = {
      frozen,
      at: new Date().toISOString(),
      by,
      ...(reason ? { reason: reason.slice(0, 500) } : {}),
    };
    atomicWriteFileSync(FREEZE_FILE, JSON.stringify(entry, null, 2));
  } catch (error) {
    console.error(
      `markMutationFrozen: Failed to persist freeze state (frozen=${frozen}) to ${FREEZE_FILE}. Error details:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** Read the persisted lock. null when absent, unreadable, or malformed —
 *  the caller treats null as "not frozen" (fail-open: a bad file must
 *  never permanently brick the mutation machinery; the operator re-freezes
 *  and the FROZEN chip's absence on the dashboard makes the loss visible). */
export function readMutationFreezeState(): MutationFreezeState | null {
  if (!PROJECT_ROOT || !FREEZE_FILE) {
    return null;
  }
  try {
    const raw = readFileSync(FREEZE_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "frozen" in parsed &&
      typeof (parsed as { frozen: unknown }).frozen === "boolean" &&
      "at" in parsed &&
      typeof (parsed as { at: unknown }).at === "string" &&
      "by" in parsed &&
      typeof (parsed as { by: unknown }).by === "string"
    ) {
      const p = parsed as { frozen: boolean; at: string; by: string; reason?: unknown };
      return {
        frozen: p.frozen,
        at: p.at,
        by: p.by,
        ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      };
    }
    console.error(
      "readMutationFreezeState: Invalid freeze state format in",
      FREEZE_FILE,
      "Expected: { frozen: boolean, at: string, by: string }"
    );
    return null;
  } catch {
    // Missing file is the normal "never frozen" case — not an error.
    // Parse/IO errors on an EXISTING file also read as not-frozen
    // (fail-open, see docblock); nothing to log loudly about.
    return null;
  }
}

/** Convenience: is the mutation machinery locked right now? Live read —
 *  a freeze written by the control route is visible to the next check in
 *  ANY process, mid-cycle included. */
export function isMutationFrozen(): boolean {
  return readMutationFreezeState()?.frozen === true;
}

/** The one-line refusal every frozen surface returns/logs — kept uniform
 *  so the operator always sees the same explanation wherever they hit the
 *  lock. Null when not frozen (callers skip the message entirely). */
export function mutationFreezeNotice(): string | null {
  const state = readMutationFreezeState();
  if (!state?.frozen) return null;
  const when = state.at.slice(0, 19).replace("T", " ");
  const why = state.reason ? ` — "${state.reason}"` : "";
  return `MUTATION FREEZE active (set ${when} UTC by ${state.by})${why} — the system is locked in its current state. Unfreeze via the [FREEZE] header button (operator PIN) to allow changes.`;
}
