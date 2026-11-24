import { NextResponse } from "next/server";
import { workerFetch, ensureWorkerRunning } from "@/lib/pipeline/autonomous/loop-worker-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/self-enhance/unlock
 * Body: { filePath: string, pin?: string }
 *
 * Unlocks a saturated file so it's eligible for the next cycle. Resets
 * its no-growth counter and enhancements-this-pass counter — a fresh
 * start. The file is re-evaluated on the next cycle.
 *
 * TWO PIN TIERS (operator + master), 2026-11-17:
 *
 *   - operator PIN (LOOP_UNLOCK_PIN, default "691"): the friction gate.
 *     Documented ONCE, mid-README ("Why it can't go rogue"), so you only
 *     know it if you've actually read the manual. Unlocks one file per
 *     entry. A speed bump, not a security boundary — the real boundary
 *     for the code remains protected-files + the gate chain.
 *
 *   - master PIN (LOOP_MASTER_PIN, default "4444"): operator-only secret.
 *     NOT in the README (the operator keeps it to themselves). Entering
 *     it once activates "master unlock mode"; while active, every
 *     subsequent [unlock] click bypasses the PIN prompt and unlocks
 *     directly — the operator's active management session no longer
 *     needs a PIN per file. PERSISTENCE (2026-11-24, 10-day endurance
 *     test): the flag lives in the wipe-proof tier (.git/info/loop-
 *     master-unlocked.json) and survives worker restarts; the
 *     constructor re-hydrates it at boot. An explicit [STOP] deletes
 *     the file — the single deliberate end of the bypass, per the
 *     operator's "unlocked until the system is stopped" contract.
 *
 * The master PIN protects nothing the operator PIN doesn't already
 * protect. The real code-safety boundary is protected-files + the gate
 * chain, which no PIN can bypass and the loop can never edit. The
 * master PIN is pure operator convenience: it stops the "type 691 on
 * every one of these 8 locked files" tedium during an active pass
 * without weakening the per-file friction for a casual passer-by (who
 * doesn't know 4444 and can't find it in the README).
 *
 * The loop-worker's /unlock mirror applies the SAME two-tier check
 * (this port is reachable through the gateway's XTransformPort pattern,
 * so validating only here at the edge would not be enough). This route
 * is inside the protected control-API prefix and the worker is outside
 * scan scope — neither check is reachable by the loop's own mutations.
 */

/** Default when LOOP_UNLOCK_PIN is unset/blank in .env. Documented once,
 *  mid-README. Trimmed before compare; never logged. */
const DEFAULT_UNLOCK_PIN = "691";

/** Default when LOOP_MASTER_PIN is unset/blank in .env. SECRET — never
 *  written to the README, never logged, never returned to the client. */
const DEFAULT_MASTER_PIN = "4444";

function expectedUnlockPin(): string {
  const fromEnv = (process.env.LOOP_UNLOCK_PIN ?? "").trim();
  return fromEnv || DEFAULT_UNLOCK_PIN;
}

function expectedMasterPin(): string {
  const fromEnv = (process.env.LOOP_MASTER_PIN ?? "").trim();
  return fromEnv || DEFAULT_MASTER_PIN;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as {
      filePath?: unknown;
      pin?: unknown;
    } | null;
    if (!body || typeof body.filePath !== "string" || !body.filePath) {
      return NextResponse.json(
        { ok: false, error: "filePath is required" },
        { status: 400 }
      );
    }

    const pinStr = typeof body.pin === "string" ? body.pin.trim() : "";
    const isMaster = pinStr === expectedMasterPin();
    const isOperator = pinStr === expectedUnlockPin();

    // ── Edge PIN gate — validate BEFORE touching the worker ─────────
    // Three accepted cases:
    //   1. master PIN submitted  → forward with pin; worker activates
    //      master mode + unlocks the file.
    //   2. no PIN submitted      → forward WITHOUT pin; worker decides
    //      (accepts only if its masterUnlocked flag is already true;
    //      otherwise 400). This is the "auto-pass the rest" path: the
    //      UI omits the PIN when master mode is active.
    //   3. operator PIN submitted → forward with pin; worker does a
    //      normal single-file unlock.
    // Anything else (a PIN that matches neither) → 403 here, fast,
    // without a worker round-trip. Never log the submitted value.
    if (pinStr && !isMaster && !isOperator) {
      console.warn(
        `[unlock] refused: wrong PIN for ${body.filePath}`
      );
      return NextResponse.json(
        {
          ok: false,
          error: 'wrong operator PIN — see the README\'s safety section ("Why it can\'t go rogue")',
        },
        { status: 403 }
      );
    }

    const alive = await ensureWorkerRunning();
    if (!alive) {
      return NextResponse.json(
        { ok: false, error: "Loop worker unreachable — unlock not applied." },
        { status: 503 }
      );
    }
    // Forward the pin when present (master or operator); omit it when
    // absent so the worker applies its masterUnlocked auto-pass check.
    // The worker re-validates (defense in depth for the direct :3004
    // path through the gateway).
    const forwardBody: { filePath: string; pin?: string } = {
      filePath: body.filePath,
    };
    if (pinStr) forwardBody.pin = pinStr;
    const r = await workerFetch("/unlock", {
      method: "POST",
      body: JSON.stringify(forwardBody),
      timeoutMs: 10000,
    });
    if (!r || !r.data) {
      // Network failure / non-JSON body — the worker is unreachable or
      // returned garbage. Map to 502 (the honest "worker unlock failed").
      return NextResponse.json(
        { ok: false, error: "Worker unlock failed." },
        { status: 502 }
      );
    }
    // Pass the worker's actual status + body through. The worker returns
    // 200 on success, 400 on a missing PIN (master mode not active), 403 on
    // a wrong PIN. Surfacing the worker's honest status + message (rather
    // than masking every non-2xx as 502) lets the UI give the real reason
    // — e.g. "pin is required" instead of a generic "worker failed".
    return NextResponse.json(r.data, { status: r.status });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
