/**
 * Constant-time string equality — the ONE helper for every secret compare
 * (API keys, operator PIN, master PIN, worker ingest token).
 *
 * WHY NOT `===`: a direct string compare short-circuits on the first
 * differing byte, leaking how much of the secret matched through response
 * timing. Comparing FIXED-LENGTH sha256 digests with timingSafeEqual leaks
 * nothing: every input hashes to the same 32-byte length, and the compare
 * takes constant time for equal-length buffers. Hashing both sides (not
 * just one) also hides the secret's length — the digest is always 32 bytes.
 *
 * Provenance (operator, 2026-11-25 audit): mini-services/loop-worker
 * already used this exact pattern (`keyMatches`, operator round 3,
 * 2026-11-23). The audit found the SAME flaw in three more places — the
 * loop-worker PIN compares, the unlock edge route, the unfreeze route,
 * and the oracle ingest token — so the pattern is promoted here and every
 * site now shares this definition. No behavior change for correct inputs;
 * wrong secrets just stop being timing-observable.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** True iff `provided` equals `expected`, without timing leakage.
 *  Empty/absent `provided` is always false (fail-closed) — a caller that
 *  treats "no credential submitted" differently must check that itself. */
export function constantTimeEqual(
  provided: string | null | undefined,
  expected: string
): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
