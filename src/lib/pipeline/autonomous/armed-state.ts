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
  try {
    // Ensure directory exists first to avoid race condition
    const infoDir = join(PROJECT_ROOT, ".git/info");
    mkdirSync(infoDir, { recursive: true });
    
    // Validate input
    if (!by || typeof by !== "string" || by.trim() === "") {
      throw new Error("markArmed: 'by' parameter must be a non-empty string");
    }
    
    const entry: ArmedState = { armed, at: new Date().toISOString(), by };
    writeFileSync(ARMED_STATE_FILE, JSON.stringify(entry, null, 2), "utf8");
  } catch {
    /* best-effort — same contract as the swap journal */
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
      return null;
    }
    
    const raw = readFileSync(ARMED_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    
    // Validate that parsed is an object and has all required fields
    if (parsed && 
        typeof parsed === "object" && 
        parsed.armed !== undefined && 
        typeof parsed.armed === "boolean" && 
        parsed.at !== undefined && 
        typeof parsed.at === "string" && 
        parsed.by !== undefined && 
        typeof parsed.by === "string") {
      return {
        armed: parsed.armed,
        at: parsed.at,
        by: parsed.by,
      };
    }
    return null;
  } catch {
    return null;
  }
}