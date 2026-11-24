/**
 * loop-touch.ts — cron-delegate operator touch (dead-man's-switch feed).
 *
 * WHY THIS EXISTS (operator, 2026-11-24 — 10-day endurance test):
 *   The dead-man's switch (operator-touch.ts) auto-pauses the loop when
 *   the operator hasn't touched the system in 24h — a quota-burn safety
 *   net. The operator has SANCTIONED a 10-day unattended run and asked
 *   that "cron jobs take over if the user closes the window". This
 *   script is the cron's delegate gesture: it stamps the wipe-proof
 *   touch tier exactly like a daily [START] check-in would, keeping the
 *   switch fed at its DESIGNED cadence (once per day) rather than
 *   disabling or lengthening the threshold — if the cron layer itself
 *   dies, the switch still trips and the loop pauses, preserving the
 *   safety net for a genuinely runaway system.
 *
 * The stamp is auditable: readOperatorTouch shows by:"cron-delegate"
 * (or the argv override), so post-hoc analysis can always tell
 * operator touches from cron touches from test pollution (the latter
 * is now refused outright by the test-origin guard).
 *
 * Usage:
 *   bun scripts/loop-touch.ts                 # by:"cron-delegate"
 *   bun scripts/loop-touch.ts operator-setup  # custom by label
 *
 * Prints the resulting touch state (one line) for the cron job's reply.
 */

import { markOperatorTouch, readOperatorTouch } from "../src/lib/pipeline/autonomous/operator-touch";

const rawBy = process.argv[2] ?? "";
const by = rawBy.trim() ? rawBy.trim() : "cron-delegate";

// The touch module is a pure leaf (fs + path + atomic-write) — no DB,
// no LLM, no pipeline graph. Safe to call from any process, any time.
markOperatorTouch(by);

const state = readOperatorTouch();
if (state) {
  console.log(`touched: at=${state.at} by=${state.by}`);
} else {
  console.error(`touch FAILED: readOperatorTouch returned null. Expected a state object after writing with label "${by}". Check underlying file system permissions or store integrity.`);
  process.exit(1);
}