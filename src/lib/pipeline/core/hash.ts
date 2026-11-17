/**
 * Shared hash utility — a 16-hex sha of a source string, used as compact
 * provenance for "what did the file look like when this was attempted".
 *
 * Extracted here (from self-enhance-loop.ts, where a local copy lived) so
 * the TOCTOU recheck can be added to chat-task.ts and schema-gate.ts
 * without duplicating the hash. self-enhance-loop.ts keeps its local copy
 * to minimize blast radius; this is the canonical shared version for new
 * consumers. The two are byte-identical.
 */
import { createHash } from "crypto";

/** 16-hex sha of a source string — compact provenance for TOCTOU compares. */
export function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
