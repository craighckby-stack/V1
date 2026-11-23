/**
 * Operator armed-intent store — the wipe-proof tier for "this loop was
 * armed".
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * The loop runtime's `config.enabled` lives in memory. A process restart
 * (dev-server reload, crash, sandbox reboot) resets it to the compiled
 * default (false) — so an operator who pressed [START] this morning finds
 * a dead loop after lunch, and "run by itself when quota is available"
 * silently stops being true the moment the process recycles.
 *
 * The armed intent is an OPERATOR DECISION, and operator decisions about
 * autonomy must outlive processes. So it gets the same treatment as the
 * other wipe-proof tiers:
 *
 *   vault key       .git/info/loop-vault-key
 *   push state      .git/info/loop-push-state.json
 *   swap journal    .git/info/loop-hot-swap-journal.jsonl
 *   armed state     .git/info/loop-armed-state.json   ← this file
 *
 * .git/info/ is never tracked, never committed, and survives both process
 * restarts and the sandbox's SQLite rollbacks (observed live: the mutation
 * corpus reads 0 attempts while the remote holds 108 loop-NN branches —
 * anything that must survive goes in .git/info/, not the DB).
 *
 * SEMANTICS (one boolean, written by exactly three call sites)
 *   [START] / POST /api/autonomous/start  → markArmed(true)  — armed
 *   [STOP]  / POST /api/autonomous/stop   → markArmed(false) — sticky stop
 *   config PATCH with an explicit enabled → markArmed(that)   — rare path
 *
 * The boot auto-arm (loop-runtime constructor) reads this file: if the
 * operator left the loop armed, the fresh process re-arms it and lets the
 * loop's own quota-aware backoff (dynamic cooldown + pre-tree-fetch
 * fast-path) wait out any active 429 gate. That is the whole of "run by
 * itself when quota available": arm once, it runs whenever the gate is
 * open; [STOP] clears the intent and nothing auto-starts again.
 *
 * Pure leaf: fs + path + PROJECT_ROOT only, no pipeline imports — safe
 * to load from anywhere (loop-runtime, API routes, instrumentation).
 */

import { readFileSync, existsSync } from "fs";
import { atomicWriteFileSync } from "../core/atomic-file";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";

const ARMED_STATE_FILE = join(PROJECT_ROOT, ".git/info/loop-armed-state.json");
const VALID_BY_VALUES = ["operator-start", "operator-stop", "config-patch"];

export interface ArmedState {
  /** The operator's intent. true = armed (auto-run when quota allows). */
  armed: boolean;
  /** ISO timestamp of the last change — for the boot log line. */
  at: string;
  /** What made the change ("operator-start" | "operator-stop" | "config-patch"). */
  by: string;
}

/** Persist the armed intent. Never throws — a persistence failure must
 *  never fail a start/stop that already succeeded in memory (the in-memory
 *  flag remains the live source; the disk file is the restart tier). */
export function markArmed(armed: boolean, by: string): void {
  // TEST-ORIGIN GUARD: same pollution class as the self-enhance armed
  // tier ("armed by test-run") — no test runner may ever write the
  // production intent file, regardless of the 'by' value passing the
  // whitelist below.
  if (
    process.env.BUN_TEST === "1" ||
    process.env.VITEST === "1"
  ) {
    console.error(
      `markArmed: refused test-origin write (armed=${armed}, by=${by}) — tests must never write the production armed tier.`
    );
    return;
  }
  // Validate the 'by' parameter to ensure only valid values are persisted
  if (!VALID_BY_VALUES.includes(by)) {
    console.error(`markArmed: Invalid 'by' value "${by}". Must be one of: ${VALID_BY_VALUES.join(", ")}`);
    return;
  }

  try {
    const entry: ArmedState = { armed, at: new Date().toISOString(), by };
    // Rely on atomicWriteFileSync to handle directory creation or fail gracefully
    atomicWriteFileSync(ARMED_STATE_FILE, JSON.stringify(entry, null, 2));
  } catch (error) {
    // Log the error for debugging but don't throw to maintain the contract
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`markArmed: Failed to persist armed state to ${ARMED_STATE_FILE} (by: ${by}, armed: ${armed}). Check file system permissions. Error details: ${errorMessage}`);
  }
}

/** Read the persisted intent. null when absent, unreadable, or torn —
 *  the caller treats null as "not armed" (fail-closed: a missing file
 *  must never fabricate an armed state). A MALFORMED file (bad JSON,
 *  missing `armed` boolean) is ALSO null — never fabricate armed from
 *  a bad read. This is the dual-layer fail-closed contract: the boot
 *  auto-arm only proceeds when the disk EXPLICITLY says armed:true. */
export function readArmedState(): ArmedState | null {
  try {
    if (!existsSync(ARMED_STATE_FILE)) {
      return null; // File absent, expected on first run, treated as not armed.
    }

    const raw = readFileSync(ARMED_STATE_FILE, "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (jsonError) {
      console.error(`readArmedState: Failed to parse armed state JSON from ${ARMED_STATE_FILE}. File content is invalid JSON. Error: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
      return null;
    }

    if (typeof parsed !== "object" || parsed === null) {
      console.error(`readArmedState: Armed state file ${ARMED_STATE_FILE} is malformed - root element is not an object.`);
      return null;
    }

    const state = parsed as ArmedState;

    // Validate that parsed matches ArmedState structure and data integrity
    // ISO 8601 format ending in Z is strictly enforced here.
    const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

    if (typeof state.armed !== "boolean" ||
        typeof state.at !== "string" ||
        typeof state.by !== "string" ||
        !VALID_BY_VALUES.includes(state.by) || // Enforce documented valid sources for 'by'
        !iso8601Regex.test(state.at)) {

      console.error(`readArmedState: Armed state file ${ARMED_STATE_FILE} is malformed - missing required fields, invalid structure, or invalid 'by' value (${state.by}).`);
      return null;
    }

    return state;
  } catch (error) {
    // Catch I/O errors other than ENOENT (which is handled by existsSync check)
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`readArmedState: Failed to read armed state from ${ARMED_STATE_FILE} despite existence. Check file permissions or disk integrity. Error: ${errorMessage}`);
    return null;
  }
}