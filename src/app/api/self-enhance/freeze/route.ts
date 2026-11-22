import { NextResponse } from "next/server";
import { workerFetch } from "@/lib/pipeline/autonomous/loop-worker-client";
import {
  markMutationFrozen,
  readMutationFreezeState,
} from "@/lib/pipeline/autonomous/mutation-freeze";
import { markSelfEnhanceArmed } from "@/lib/pipeline/autonomous/self-enhance-armed-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/freeze   body: { frozen: boolean, pin?: string, reason?: string }
 *
 * The operator's "stop evolving, hold this state" lock.
 *
 *   { frozen: true }  — LOCK the system. No PIN required: locking down is
 *                       the SAFE direction (the mutation machinery refuses;
 *                       dashboard, ingest, oracle, and health monitoring all
 *                       keep operating). Also clears the armed tier so a
 *                       future unfreeze + reboot starts from an explicit
 *                       [START], never a surprise auto-start, and asks the
 *                       worker to stand its continuous loop down gracefully.
 *
 *   { frozen: false, pin } — UNLOCK. PIN required (operator PIN documented
 *                       mid-README, or the master PIN). The direction that
 *                       re-enables self-mutation is the one that must prove
 *                       operator presence. The PIN is validated here, never
 *                       logged, and the write itself is refused for test
 *                       origins inside markMutationFrozen.
 *
 * The persisted tier (.git/info/loop-mutation-freeze.json) is wipe-proof
 * (never committed, survives restarts and sandbox rollbacks) and is read
 * LIVE by every guard in both the server and the worker — the lock lands
 * instantly, mid-cycle included.
 */
export async function POST(req: Request) {
  try {
    let body: { frozen?: unknown; pin?: unknown; reason?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON in request body" },
        { status: 400 }
      );
    }

    const { frozen, pin, reason } = body;
    if (typeof frozen !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "'frozen' must be a boolean (true = lock, false = unlock)" },
        { status: 400 }
      );
    }
    const reasonStr = typeof reason === "string" ? reason.trim() : "";

    // ── UNFREEZE: PIN required ─────────────────────────────────────────
    if (!frozen) {
      const operatorPin = (process.env.LOOP_UNLOCK_PIN ?? "").trim() || "691";
      const masterPin = (process.env.LOOP_MASTER_PIN ?? "").trim() || "4444";
      const pinStr = typeof pin === "string" ? pin.trim() : "";
      if (!pinStr) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "pin is required to unfreeze — re-enabling self-mutation proves operator presence (operator PIN documented mid-README, or the master PIN)",
          },
          { status: 400 }
        );
      }
      if (pinStr !== operatorPin && pinStr !== masterPin) {
        // Never log the submitted PIN — outcome only.
        console.warn("[FREEZE] unfreeze refused: wrong PIN");
        return NextResponse.json(
          { ok: false, error: "wrong PIN — unfreeze refused" },
          { status: 403 }
        );
      }
      markMutationFrozen(false, "operator-unfreeze", reasonStr || undefined);
      console.log("[FREEZE] mutation freeze lifted by operator");
      return NextResponse.json({
        ok: true,
        frozen: false,
        message:
          "Mutation freeze lifted — press [START] to run the self-enhancement loop again (arming is explicit after a freeze).",
      });
    }

    // ── FREEZE: no PIN (safe direction) ────────────────────────────────
    markMutationFrozen(
      true,
      "operator-freeze",
      reasonStr || "operator locked the system in its current state"
    );
    // Clear the armed tier too: a frozen system must not carry a stale
    // armed:true that an unfreeze + reboot would silently act on. After
    // an unfreeze the loop starts only via an explicit [START].
    markSelfEnhanceArmed(false, "operator-stop");

    // Ask the worker to stand down gracefully (run-token bump — an
    // in-flight cycle bails at its next checkpoint; the freeze guards at
    // the write points catch anything already past one). Best-effort: if
    // the worker is unreachable nothing is running in it, and the file
    // tier alone holds the lock.
    const stopRes = await workerFetch("/stop", {
      method: "POST",
      timeoutMs: 8000,
    }).catch(() => null);

    const state = readMutationFreezeState();
    console.log(
      `[FREEZE] mutation freeze ENGAGED${stopRes?.ok ? " — worker loop stood down" : " — worker unreachable or already stopped (file tier holds the lock)"}`
    );
    return NextResponse.json({
      ok: true,
      frozen: true,
      stopped: stopRes?.ok === true,
      at: state?.at,
      message:
        "MUTATION FREEZE engaged — the system is locked in its current state. Code, commits, and pushes are refused everywhere; the dashboard, ingest, oracle feed, and health monitoring keep operating. Unfreeze requires the operator PIN.",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
