/**
 * GET /api/postmortems/chain — verify the tamper-evident postmortem chain.
 *
 * Walks every postmortem in createdAt order and reports:
 *   - total          : records in the chain
 *   - ok             : true iff linkBreaks == 0 AND contentMismatches == 0
 *   - linkBreaks     : records whose parentHash ≠ their predecessor's
 *                      current hash. Happens on in-place updates (expected
 *                      on repeat failures). Informational, NOT an attack.
 *   - contentMismatches : records whose stored hash ≠ recomputed hash.
 *                      A direct DB edit without recomputing = tamper alarm.
 *   - firstBreakAt   : index of the first break (for the UI to highlight)
 *
 * See verifyPostmortemChain in postmortem-store.ts for the full semantics.
 */
import { NextResponse } from "next/server";
import {
  verifyPostmortemChain,
  backfillPostmortemChain,
} from "@/lib/pipeline/postmortem/postmortem-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await verifyPostmortemChain();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

/** POST /api/postmortems/chain — retroactively chain every pre-chain
 *  postmortem (records created before the hash columns existed, which
 *  have null parentHash/hash). Idempotent: a second call returns 0.
 *  After backfill, GET /api/postmortems/chain reports ok:true (assuming
 *  no in-place content tampering). */
export async function POST() {
  try {
    const result = await backfillPostmortemChain();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { backfilled: 0, total: 0, error: (err as Error).message },
      { status: 500 }
    );
  }
}
