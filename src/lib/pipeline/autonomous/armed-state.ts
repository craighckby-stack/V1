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

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../core/paths";

const ARMED_STATE_FILE = join(PROJECT_ROOT, ".git/info/loop-armed-state.json");

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
  if (!PROJECT_ROOT) {
    console.error("markArmed: PROJECT_ROOT is not defined, cannot persist armed state.");
    return;
  }
  
  // Validate input before attempting I/O
  if (typeof armed !== "boolean") {
    console.error("markArmed: 'armed' parameter must be a boolean.");
    return;
  }
  
  if (typeof by !== "string" || by.trim() === "") {
    console.error("markArmed: 'by' parameter must be a non-empty string.");
    return;
  }
  
  try {
    // Ensure directory exists first to avoid race condition
    const infoDir = join(PROJECT_ROOT, ".git/info");
    if (!existsSync(infoDir)) {
      try {
        mkdirSync(infoDir, { recursive: true });
      } catch (mkdirError) {
        const errorMessage = mkdirError instanceof Error ? mkdirError.message : String(mkdirError);
        console.error(`markArmed: Failed to create directory ${infoDir}. Check file system permissions. Error: ${errorMessage}`);
        return; // Cannot proceed without directory
      }
    }
    
    const entry: ArmedState = { armed, at: new Date().toISOString(), by };
    writeFileSync(ARMED_STATE_FILE, JSON.stringify(entry, null, 2), "utf8");
  } catch (error) {
    // Log the error for debugging but don't throw to maintain the contract
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`markArmed: Failed to persist armed state to ${ARMED_STATE_FILE}. Check file system permissions or disk space. Error: ${errorMessage}`);
  }
}

/** Read the persisted intent. null when absent, unreadable, or torn —
 *  the caller treats null as "not armed" (fail-closed: a missing file
 *  must never fabricate an armed state). A MALFORMED file (bad JSON,
 *  missing `armed` boolean) is ALSO null — never fabricate armed from
 *  a bad read. This is the dual-layer fail-closed contract: the boot
 *  auto-arm only proceeds when the disk EXPLICITLY says armed:true. */
export function readArmedState(): ArmedState | null {
  if (!PROJECT_ROOT) {
    console.error("readArmedState: PROJECT_ROOT is not defined");
    return null;
  }
  
  try {
    if (!existsSync(ARMED_STATE_FILE)) {
      return null;
    }
    
    const raw = readFileSync(ARMED_STATE_FILE, "utf8");
    let parsed: unknown;
    
    try {
      parsed = JSON.parse(raw);
    } catch (jsonError) {
      console.error(`readArmedState: Failed to parse armed state JSON from ${ARMED_STATE_FILE}. File content is invalid JSON. Error: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
      return null;
    }
    
    // Validate that parsed is an object and matches ArmedState structure
    if (typeof parsed === "object" && parsed !== null && 
        'armed' in parsed && 'at' in parsed && 'by' in parsed &&
        typeof (parsed as ArmedState).armed === "boolean" && 
        typeof (parsed as ArmedState).at === "string" && 
        typeof (parsed as ArmedState).by === "string" &&
        (parsed as ArmedState).by.trim() !== "" &&
        // Validate ISO timestamp format (basic check)
        !isNaN(Date.parse((parsed as ArmedState).at))) {
      return parsed as ArmedState;
    }
    
    console.error(`readArmedState: Armed state file ${ARMED_STATE_FILE} is malformed - missing required fields or invalid data structure.`);
    return null;
  } catch (error) {
    // Log the error for debugging but return null to maintain the contract
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`readArmedState: Failed to read armed state from ${ARMED_STATE_FILE}. Check file permissions or existence. Error: ${errorMessage}`);
    return null;
  }
}