/**
 * Postmortem Store — per-file negative constraints learned from past failures.
 *
 * Each postmortem records:
 *   - WHAT failed (failureType, symptom)
 *   - EVIDENCE (machine-copied facts: dropped symbols, AST violations, etc.)
 *   - CONSTRAINTS (imperative instructions the LLM must follow next time)
 *
 * Flow:
 *   1. Before mutating a file, call getActivePostmortem(repo, branch, filePath)
 *   2. If a postmortem exists, inject its constraints into the LLM prompt
 *   3. After the pipeline runs:
 *      - On SUCCESS (committed): markPostmortemResolved(...)
 *      - On FAILURE: recordFailure(...) creates or updates the postmortem
 *
 * Postmortems can also be seeded from external markdown files (e.g. a
 * POSTMORTEMS.md produced by another enhancer) via parseMarkdownPostmortem().
 */

import { createHash } from "crypto";
import { db } from "@/lib/db";
import type { Postmortem as PostmortemRow } from "@prisma/client";
import type { AstDiffResult } from "../core/ast-diff-gate";
import type { SecuritySanitizerResult } from "../emg/sanitizer";
import type { DebateVerdict } from "../emg/debate";
import {
  writePostmortemToDisk,
  readPostmortemFromDisk,
  resolvePostmortemOnDisk,
  listFromDisk,
  listAllPostmortemsFromDisk,
  deletePostmortemFromDisk,
  rehydrateSqliteFromDisk,
} from "./postmortem-repo";

// ── Tamper-evident chain helpers (concept: Aether_Forge Ω darlekRAG) ────
// The chain is a single global sequence ordered by createdAt. Each record's
// `parentHash` is the `hash` of the previously-created record; `hash` is
// sha256 over (parentHash + canonical(content)). Recomputed on every write
// so a direct DB edit (without recomputing) is detectable as a content
// mismatch — see verifyPostmortemChain.
//
// AUDIT 3: LIFECYCLE FIELDS ARE EXCLUDED FROM THE HASHED CONTENT. The hash
// used to cover `status` (and `verificationStatus`), so the resolve path —
// markResolved / resolvePostmortemOnDisk flipping active→resolved (and
// candidate→rejected) WITHOUT recomputing — turned every resolved record
// into a permanent contentMismatch: a false "someone edited the DB" alarm
// on exactly the records where nothing was edited. Resolution is a
// legitimate lifecycle event, not content tampering. With `status` and
// `verificationStatus` out of the hash input (resolvedAt was never in it —
// timestamps are excluded by design), the resolve path never needs to
// touch hashes and the chain stays quiet; what the hash still covers is
// the CONTENT proper — what failed, the evidence, the constraints, the
// attempt count, the file identity — the parts a tamper would actually
// want to rewrite. Documented trade-off: a direct DB edit that flips ONLY
// verificationStatus (e.g. rejected→verified to un-gate prompt injection)
// is no longer chain-detectable; the operative guard remains
// getConstraintsForFile's verified-only injection gate, and recordFailure
// still recomputes the hash on every write it makes. NOTE: this changes
// hash VALUES for every existing record — expected and fine; the chain
// backfill endpoint (POST /api/postmortems/chain) recomputes them. Never
// call it from inside the store.

/** The content a postmortem's hash covers. Excludes timestamps, ids, the
 *  hashes themselves (those are derived), and — per audit 3 — the
 *  lifecycle fields (`status`, `verificationStatus`; `resolvedAt` was
 *  never in the input), which the resolve path legitimately flips without
 *  rehashing. Deterministic key order via object-literal insertion order
 *  (preserved by JSON.stringify for string keys), so the same logical
 *  record always produces the same canonical string regardless of how
 *  the caller constructed it. */
interface PostmortemChainContent {
  targetRepo: string;
  branch: string;
  filePath: string;
  failureType: string;
  symptom: string;
  evidence: string;
  constraints: string;
  attempts: number;
}

function canonicalPostmortemContent(c: PostmortemChainContent): string {
  // Fixed key order — do NOT reorder these without a schema bump.
  return JSON.stringify({
    targetRepo: c.targetRepo,
    branch: c.branch,
    filePath: c.filePath,
    failureType: c.failureType,
    symptom: c.symptom,
    evidence: c.evidence,
    constraints: c.constraints,
    attempts: c.attempts,
  });
}

function computePostmortemHash(parentHash: string | null, canonical: string): string {
  return createHash("sha256")
    .update(`${parentHash ?? ""}|${canonical}`)
    .digest("hex");
}

/** The hash of the most recently created postmortem (by createdAt desc).
 *  Used as the parentHash when appending a new record to the chain. Returns
 *  null when the chain is empty or the DB is unreachable. */
async function getLatestPostmortemHash(): Promise<string | null> {
  try {
    const latest = await db.postmortem.findFirst({
      orderBy: { createdAt: "desc" },
      select: { hash: true },
    });
    return latest?.hash ?? null;
  } catch {
    return null;
  }
}

/** Walk the entire postmortem table in createdAt order and verify the chain.
 *  Returns:
 *   - linkBreaks: count of records whose parentHash ≠ their predecessor's
 *     CURRENT hash. Happens whenever an older record is updated in place
 *     after a younger one was created (expected on repeat failures — the
 *     older record's hash changes, but the younger's parentHash still
 *     points at the pre-update hash). Informational, NOT an attack signal.
 *   - contentMismatches: count of records whose stored hash ≠ recomputed
 *     hash. This means someone edited the row directly in the DB WITHOUT
 *     recomputing the hash — a tamper alarm. AUDIT 3: lifecycle fields
 *     (status / verificationStatus / resolvedAt) are excluded from the
 *     hashed content, so markResolved's no-rehash resolve can never trip
 *     this — a mismatch here means CONTENT was edited.
 * `ok` is true only when both counts are zero. Callers (the API + UI) can
 *  surface both numbers so the operator can tell "records were updated in
 *  place" (linkBreaks, fine) from "the DB was tampered with"
 *  (contentMismatches, alarm). */
export async function verifyPostmortemChain(): Promise<{
  ok: boolean;
  total: number;
  linkBreaks: number;
  contentMismatches: number;
  firstBreakAt: number | null;
}> {
  try {
    const records = await db.postmortem.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true, hash: true, parentHash: true,
        targetRepo: true, branch: true, filePath: true,
        failureType: true, symptom: true, evidence: true, constraints: true,
        attempts: true,
      },
    });
    let linkBreaks = 0;
    let contentMismatches = 0;
    let firstBreakAt: number | null = null;
    let prevHash: string | null = null;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      // Lifecycle fields are excluded from the hashed content (audit 3) —
      // see canonicalPostmortemContent above.
      const canonical = canonicalPostmortemContent({
        targetRepo: r.targetRepo, branch: r.branch, filePath: r.filePath,
        failureType: r.failureType, symptom: r.symptom, evidence: r.evidence,
        constraints: r.constraints, attempts: r.attempts,
      });
      const recomputed = computePostmortemHash(r.parentHash, canonical);
      if (r.hash && r.hash !== recomputed) {
        contentMismatches++;
        if (firstBreakAt === null) firstBreakAt = i;
      }
      if (i > 0 && r.parentHash && r.parentHash !== prevHash) {
        linkBreaks++;
        if (firstBreakAt === null) firstBreakAt = i;
      }
      prevHash = r.hash ?? null;
    }
    return {
      ok: linkBreaks === 0 && contentMismatches === 0,
      total: records.length,
      linkBreaks,
      contentMismatches,
      firstBreakAt,
    };
  } catch {
    return { ok: false, total: 0, linkBreaks: 0, contentMismatches: 0, firstBreakAt: null };
  }
}

/** Retroactively compute parentHash + hash for every postmortem that
 *  predates the chain (null hash) or whose stored hash disagrees with the
 *  recomputed one. Walks createdAt-asc, threading the parentHash through
 *  each record so the whole table becomes a single continuous chain.
 *
 *  Idempotent: a second call finds no records to backfill (all hashes are
 *  valid) and returns 0. Safe to run on a populated DB — it only writes
 *  the two hash columns, never the content columns.
 *
 *  Returns the number of records that were (re)hashed. */
export async function backfillPostmortemChain(): Promise<{
  backfilled: number;
  total: number;
}> {
  try {
    const records = await db.postmortem.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true, hash: true, parentHash: true,
        targetRepo: true, branch: true, filePath: true,
        failureType: true, symptom: true, evidence: true, constraints: true,
        attempts: true,
      },
    });
    let backfilled = 0;
    let prevHash: string | null = null;
    for (const r of records) {
      // Lifecycle fields are excluded from the hashed content (audit 3) —
      // see canonicalPostmortemContent above. This recomputation is what
      // heals the resolved-pre-FIX records: their old hashes covered status.
      const canonical = canonicalPostmortemContent({
        targetRepo: r.targetRepo, branch: r.branch, filePath: r.filePath,
        failureType: r.failureType, symptom: r.symptom, evidence: r.evidence,
        constraints: r.constraints, attempts: r.attempts,
      });
      const expectedHash = computePostmortemHash(prevHash, canonical);
      // Only write if the record is missing its hash OR has a stale hash
      // (different parentHash threading or content drift). This makes the
      // call idempotent and minimizes DB churn on a healthy chain.
      if (r.hash !== expectedHash || r.parentHash !== prevHash) {
        await db.postmortem.update({
          where: { id: r.id },
          data: { parentHash: prevHash, hash: expectedHash },
        });
        backfilled++;
      }
      prevHash = expectedHash;
    }
    return { backfilled, total: records.length };
  } catch {
    return { backfilled: 0, total: 0 };
  }
}

export type PostmortemFailureType =
  | "AST_SYMBOL_DROPPED"
  | "AST_STRUCTURAL_DRIFT"
  | "BRANDING_INJECTION"
  | "REVIEW_REJECTED"
  | "SANITIZER_REDACTION"
  | "HEADER_STRIPPED"
  | "COMPILE_ERROR"
  | "ZERO_DIFF_SATURATION"
  // D5: the red-team test-attacker found an input where the source
  // diverges from what a pinned ratchet test asserts (or a weakening
  // mutation that keeps the test passing). Seeded as a candidate on the
  // TEST file — kept as a watch list, never injected until this system
  // observes the same weakness itself.
  | "WEAK_RATCHET"
  | "OTHER";

export interface PostmortemRecord {
  id: string;
  targetRepo: string;
  branch: string;
  filePath: string;
  status: "active" | "resolved";
  /** verified = observed by this system. candidate = seeded from external
   *  markdown, unconfirmed. rejected = a candidate contradicted by a
   *  successful commit. Only `verified` postmortems are injected into the
   *  LLM prompt — see getConstraintsForFile. */
  verificationStatus: "verified" | "candidate" | "rejected";
  failureType: PostmortemFailureType;
  symptom: string;
  evidence: string;
  constraints: string;
  attempts: number;
  /** D7 (Reflexion): the LLM's verbal self-diagnosis of WHY its own
   *  reasoning produced the latest failure. Stored after the verdict,
   * injected with the next attempt's constraint block. null when the
   *  reflection call hasn't run (or the DB predates the field). */
  reflection?: string | null;
  /** Tamper-evident chain — parentHash of the previous record, hash of this
   *  one. null on records created before the chain existed or when the DB
   *  was unreachable at creation time. See verifyPostmortemChain. */
  parentHash: string | null;
  hash: string | null;
  lastAttemptAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PostmortemConstraints {
  hasActivePostmortem: boolean;
  failureType?: PostmortemFailureType;
  symptom?: string;
  constraints: string[];
  attempts?: number;
  /** Formatted block to inject into the LLM prompt */
  promptBlock: string;
}

/** AUDIT 3 (F6): bounded, control-char-free prompt injection for the
 *  postmortem block. Fields that go into mutation prompts are hard-capped
 *  (the cut is marked "…[truncated]") and stripped of control characters:
 *  the class keeps \t, \n, \r (legitimate formatting in multi-line
 *  evidence/constraints) and replaces every other C0 control char plus
 *  DEL with a space, so a poisoned record can't smuggle terminal escapes,
 *  framing characters, or NUL-cutoff tricks into the prompt. Applied in
 *  formatPromptBlock — the single choke point every prompt injection of a
 *  postmortem flows through (unified-pipeline, task-executor,
 *  self-enhance-loop). */
function sanitizeInjectedPostmortemField(text: string, limit: number): string {
  // Strip first, truncate second — the cap then applies to visible chars.
  const safe = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  if (safe.length <= limit) return safe;
  return `${safe.slice(0, limit)}…[truncated]`;
}

class PostmortemStore {
  /** One-time rehydration guard: when the DB is wiped (or fresh), seed it
   *  from the repo's postmortems/ directory on first read. Idempotent and
   *  process-local — only runs once per process, so a DB wipe mid-run
   *  still gets caught by the per-call disk fallback below. */
  private rehydrated = false;
  private async ensureRehydrated(): Promise<void> {
    if (this.rehydrated) return;
    this.rehydrated = true;
    try {
      let imported = 0;
      const recs = await rehydrateSqliteFromDisk(async (rec) => {
        // upsert: create if missing, skip if present (don't overwrite a
        // fresher DB row with a stale disk row).
        const existing = await db.postmortem.findUnique({
          where: {
            targetRepo_branch_filePath: {
              targetRepo: rec.targetRepo,
              branch: rec.branch,
              filePath: rec.filePath,
            },
          },
        });
        if (existing) return;
        await db.postmortem.create({
          data: {
            targetRepo: rec.targetRepo,
            branch: rec.branch,
            filePath: rec.filePath,
            status: rec.status,
            failureType: rec.failureType,
            symptom: rec.symptom,
            evidence: rec.evidence,
            constraints: rec.constraints,
            attempts: rec.attempts,
            lastAttemptAt: new Date(rec.lastAttemptAt),
            resolvedAt: rec.resolvedAt ? new Date(rec.resolvedAt) : null,
            // AUDIT 3 (B3/B4): the old create DROPPED these three fields.
            // verificationStatus defaulted to "verified" in Prisma — a
            // disk CANDIDATE (unconfirmed red-team finding, externally
            // seeded claim) silently became a VERIFIED constraint injected
            // into every enhance prompt after a DB wipe. parentHash/hash
            // defaulted to NULL — chain verification short-circuits on
            // null, so a rehydrated record could be edited in the DB
            // without the tamper-evident chain ever noticing. Both holes
            // closed: the disk record is the source of truth, carry it
            // through. (rehydrateSqliteFromDisk already defaults schema-1
            // files to "verified"/null-hash — honest for their age.)
            verificationStatus: rec.verificationStatus ?? "verified",
            parentHash: rec.parentHash ?? null,
            hash: rec.hash ?? null,
          },
        });
      });
      imported = recs;
      if (imported > 0) {
        console.log(`[POSTMORTEM] rehydrated ${imported} record(s) from repo to DB`);
        // AUDIT 3 (B10): auto-backfill. Some rehydrated records may be
        // schema-1 (null hashes) or carry stale links from a mid-cycle
        // wipe. The old flow required the operator to remember to POST
        // /api/postmortems/chain after every DB recovery — a recovery
        // step that isn't documented anywhere the operator would look.
        // Backfill is idempotent and only writes the hash columns, so
        // running it automatically after rehydration is safe.
        try {
          const bf = await backfillPostmortemChain();
          if (bf.backfilled > 0) {
            console.log(`[POSTMORTEM] chain auto-backfilled ${bf.backfilled} rehydrated record(s)`);
          }
        } catch {
          /* best-effort — the operator endpoint remains as fallback */
        }
      }
    } catch {
      /* best-effort — per-call disk fallback still covers reads */
    }
  }

  /**
   * Get the active postmortem for a specific file, if one exists.
   * Returns null if no active postmortem (file has never failed, or was resolved).
   *
   * Read order: SQLite (fast cache) → repo JSON (source of truth, survives
   * DB wipes). The disk fallback is what makes failure memory durable
   * across DB recreations.
   */
  async getActivePostmortem(
    repo: string,
    branch: string,
    filePath: string
  ): Promise<PostmortemRecord | null> {
    await this.ensureRehydrated();
    // 1. Fast path: SQLite cache.
    try {
      const record = await db.postmortem.findUnique({
        where: {
          targetRepo_branch_filePath: { targetRepo: repo, branch, filePath },
        },
      });
      if (record) {
        if (record.status !== "active") return null;
        return this.mapRecord(record);
      }
    } catch {
      /* DB unavailable — fall through to disk */
    }
    // 2. Disk fallback: the repo's postmortems/<repo>/<branch>/<file>.json.
    //    This is the wiped-DB recovery path: if SQLite is empty but the
    //    repo has a record, the system still recalls the failure.
    const fromDisk = readPostmortemFromDisk(repo, branch, filePath);
    if (fromDisk && fromDisk.status === "active") return fromDisk;
    return null;
  }

  /**
   * Get the constraints for a file, formatted for injection into the LLM prompt.
   * Returns an empty (no-op) constraints object if no active postmortem.
   */
  async getConstraintsForFile(
    repo: string,
    branch: string,
    filePath: string
  ): Promise<PostmortemConstraints> {
    const pm = await this.getActivePostmortem(repo, branch, filePath);
    if (!pm) {
      return { hasActivePostmortem: false, constraints: [], promptBlock: "" };
    }
    // Verification gate: only VERIFIED postmortems are injected. A
    // candidate (seeded from external markdown) is kept as a watch list
    // but never shapes the LLM prompt until this system observes the
    // same failure (which upgrades it to verified). A rejected
    // candidate (file succeeded without the claimed failure) is also
    // skipped. This prevents an unverified external claim from steering
    // the refactor.
    if (pm.verificationStatus !== "verified") {
      return { hasActivePostmortem: false, constraints: [], promptBlock: "" };
    }
    const constraintLines = pm.constraints
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return {
      hasActivePostmortem: true,
      failureType: pm.failureType,
      symptom: pm.symptom,
      constraints: constraintLines,
      attempts: pm.attempts,
      promptBlock: this.formatPromptBlock(pm),
    };
  }

  /**
   * Format a postmortem as a constraint block for the LLM prompt.
   * This goes AFTER the system prompt and BEFORE the user code, so the LLM
   * sees the constraints as hard requirements.
   */
  private formatPromptBlock(pm: PostmortemRecord): string {
    // AUDIT 3 (F6): bounded, control-char-free injection. symptom/evidence/
    // constraints used to go into mutation prompts VERBATIM with no
    // truncation, and evidence includes raw LLM text (debate reasons,
    // change summaries) — an unbounded, unsanitized block let a poisoned
    // rejection reason live forever as a "CONSTRAINTS (MUST follow ALL)"
    // instruction. Caps: symptom 300, evidence 500, constraints 500;
    // control chars (everything except \t/\n/\r) become spaces — see
    // sanitizeInjectedPostmortemField. (Reflection is separately bounded
    // at write time — storeReflection slices to 400.)
    const symptom = sanitizeInjectedPostmortemField(pm.symptom, 300);
    const evidence = sanitizeInjectedPostmortemField(pm.evidence, 500);
    const constraints = sanitizeInjectedPostmortemField(pm.constraints, 500);
    // D7 (Reflexion): the prior self-diagnosis rides WITH the constraints —
    // per the Reflexion finding, a stored self-reflection across trials
    // materially reduces repetition of the same reasoning error. The
    // reflection is the LLM's own words about its own reasoning, which
    // lands differently from an externally imposed constraint.
    const reflectionBlock = pm.reflection
      ? `\nPRIOR REFLECTION (your own self-diagnosis from the last failure — you wrote this):
${pm.reflection}\n`
      : "";
    return `\n\n--- POSTMORTEM CONSTRAINTS (this file failed ${pm.attempts} time(s) before) ---
FAILURE TYPE: ${pm.failureType}
SYMPTOM: ${symptom}
EVIDENCE:
${evidence}
CONSTRAINTS (MUST follow ALL of these):
${constraints}
${reflectionBlock}
--- END POSTMORTEM CONSTRAINTS ---\n\n`;
  }

  /**
   * D7 (Reflexion): store the LLM's verbal self-diagnosis on the file's
   * postmortem row. One per file — the newest reflection replaces the
   * older, keeping the injected prompt bounded. Reflection is a DB-only
   * field (it is NOT part of the tamper-evident chain content and NOT
   * written to the disk mirror): a lost reflection is re-generable on
   * the next failure, and the chain/hash contract stays untouched.
   * Best-effort — a reflection-write failure never fails the cycle.
   */
  async storeReflection(
    repo: string,
    branch: string,
    filePath: string,
    reflection: string
  ): Promise<boolean> {
    try {
      await db.postmortem.update({
        where: { targetRepo_branch_filePath: { targetRepo: repo, branch, filePath } },
        data: { reflection: reflection.slice(0, 400) },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Record a failure for a file. Creates a new postmortem or updates the
   * existing one (incrementing attempts, replacing evidence/constraints).
   *
   * WRITE-THROUGH (audit2-c): writes to BOTH SQLite (cache) AND the repo's
   * postmortems/<repo>/<branch>/<file>.json (source of truth). The repo
   * write is what makes the failure memory survive DB wipes — the
   * previous fallback-to-in-memory meant a DB outage made the system
   * record failures it could never recall.
   */
  async recordFailure(params: {
    repo: string;
    branch: string;
    filePath: string;
    failureType: PostmortemFailureType;
    symptom: string;
    evidence: string;
    constraints: string;
    /** verified = observed by this system (default). candidate = seeded
     *  from external markdown, not yet observed. See model doc. */
    verificationStatus?: "verified" | "candidate";
    /** AUDIT 3 (B12): true (default) when this call IS an observation of
     *  the failure by this system (the autonomous loop's gate rejection).
     *  System records that aren't observations (red-team probes, duress
     *  events, hot-swap postmortems) pass false — they must NOT upgrade
     *  an existing candidate to verified, because nothing was observed
     *  about the real file. */
    observed?: boolean;
  }): Promise<PostmortemRecord> {
    const { repo, branch, filePath, failureType, symptom, evidence, constraints } = params;
    const verificationStatus = params.verificationStatus ?? "verified";
    let record: PostmortemRecord;
    try {
      const existing = await db.postmortem.findUnique({
        where: {
          targetRepo_branch_filePath: { targetRepo: repo, branch, filePath },
        },
      });
      if (existing) {
        // Update in place. A real failure (verified) UPGRADES a candidate
        // to verified — we just observed the claimed failure ourselves,
        // so the external claim is now confirmed. AUDIT 3 (B12): only an
        // actual OBSERVATION upgrades (observed !== false) — a system
        // record (red-team/duress/hot-swap) against the same file path
        // observed nothing about the real file and must not confirm the
        // external claim. Recompute the content hash with the existing
        // parentHash so the record's content integrity stays
        // self-consistent. (The chain link from any LATER record to this
        // one will now be stale — verifyPostmortemChain reports that as
        // an expected linkBreak, not a content mismatch.)
        const isObservation = params.observed !== false;
        const nextVerification =
          existing.verificationStatus === "candidate" && isObservation
            ? "verified"
            : verificationStatus;
        // Lifecycle fields (status / verificationStatus) are excluded from
        // the hashed content (audit 3) — only the content proper is hashed;
        // verificationStatus is still PERSISTED, just not hashed.
        const canonical = canonicalPostmortemContent({
          targetRepo: repo, branch, filePath, failureType, symptom, evidence, constraints,
          attempts: existing.attempts + 1,
        });
        const newHash = computePostmortemHash(existing.parentHash, canonical);
        const updated = await db.postmortem.update({
          where: { id: existing.id },
          data: {
            status: "active",
            failureType, symptom, evidence, constraints,
            attempts: { increment: 1 },
            lastAttemptAt: new Date(),
            resolvedAt: null,
            verificationStatus: nextVerification,
            hash: newHash,
            updatedAt: new Date(),
          },
        });
        record = this.mapRecord(updated);
      } else {
        // Append to the chain: parentHash = latest existing hash, hash =
        // sha256(parentHash + canonical content). This makes the whole
        // failure memory a tamper-evident ledger — see verifyPostmortemChain.
        const parentHash = await getLatestPostmortemHash();
        const canonical = canonicalPostmortemContent({
          targetRepo: repo, branch, filePath, failureType, symptom, evidence, constraints,
          attempts: 1,
        });
        const hash = computePostmortemHash(parentHash, canonical);
        const created = await db.postmortem.create({
          data: {
            targetRepo: repo, branch, filePath,
            status: "active", verificationStatus,
            failureType, symptom, evidence, constraints,
            attempts: 1, lastAttemptAt: new Date(),
            parentHash, hash,
          },
        });
        record = this.mapRecord(created);
      }
    } catch (err) {
      // DB unavailable — build an in-memory record and STILL write it to
      // disk. The chain fields are unknown without the DB (we can't read
      // the latest hash), so they're null — the disk write still preserves
      // the failure memory; the chain just resumes on the next DB-available
      // create. AUDIT 3 (B11): this used to be fully silent — a scar could
      // be lost with zero trace if both DB and disk were having a bad day.
      // At minimum the operator's log must show the DB fell back.
      console.error(
        "[POSTMORTEM] DB unavailable in recordFailure — falling back to in-memory + disk (chain link will be null):",
        err instanceof Error ? err.message : String(err)
      );
      record = {
        id: `pm_${Date.now()}`,
        targetRepo: repo, branch, filePath,
        status: "active", verificationStatus,
        failureType, symptom, evidence, constraints,
        attempts: 1,
        parentHash: null, hash: null,
        lastAttemptAt: new Date().toISOString(),
        resolvedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    // Write-through to disk (source of truth). Best-effort: a disk failure
    // doesn't fail the recordFailure call — the in-memory + SQLite record
    // still exists for this process. The disk just won't survive a restart.
    try {
      writePostmortemToDisk(record);
    } catch (diskErr) {
      console.error("[POSTMORTEM] failed to write to repo (continuing with DB only):", diskErr);
    }
    return record;
  }

  /**
   * Mark a postmortem as resolved (file was successfully committed).
   * Kept for history — getActivePostmortem skips resolved records.
   * Also resolves the on-disk copy so the repo's audit trail reflects
   * "failed then fixed" instead of staying active forever.
   *
   * AUDIT 3: no rehash on resolve — the lifecycle fields this flips
   * (status, verificationStatus, resolvedAt) are excluded from the chain's
   * hashed content (see canonicalPostmortemContent), so this update can
   * never register as content tampering in verifyPostmortemChain.
   */
  async markResolved(repo: string, branch: string, filePath: string): Promise<void> {
    // Two-phase update so a CANDIDATE being resolved is REJECTED (the
    // external claim was contradicted — the file succeeded without the
    // claimed failure). A VERIFIED record being resolved stays verified
    // (the failure was real; it's now fixed — the verification status is
    // about whether the failure was OBSERVED, not whether it's active).
    try {
      await db.postmortem.updateMany({
        where: { targetRepo: repo, branch, filePath, status: "active", verificationStatus: "candidate" },
        data: { status: "resolved", verificationStatus: "rejected", resolvedAt: new Date(), updatedAt: new Date() },
      });
      await db.postmortem.updateMany({
        where: { targetRepo: repo, branch, filePath, status: "active" },
        data: { status: "resolved", resolvedAt: new Date(), updatedAt: new Date() },
      });
    } catch {
      /* ignore DB error — disk still has the record */
    }
    try {
      resolvePostmortemOnDisk(repo, branch, filePath);
    } catch {
      /* best-effort */
    }
  }

  /**
   * List all active postmortems for a repo/branch.
   * Reads from SQLite first, then merges any disk-only records (the
   * wiped-DB recovery path — a record on disk but not yet rehydrated
   * into the cache still shows up in the UI).
   */
  async listActive(repo?: string, branch?: string): Promise<PostmortemRecord[]> {
    await this.ensureRehydrated();
    const seen = new Set<string>();
    const out: PostmortemRecord[] = [];
    try {
      const where: Record<string, unknown> = { status: "active" };
      if (repo) where.targetRepo = repo;
      if (branch) where.branch = branch;
      const records = await db.postmortem.findMany({
        where,
        orderBy: { lastAttemptAt: "desc" },
        take: 100,
      });
      for (const r of records) {
        const rec = this.mapRecord(r);
        seen.add(`${rec.targetRepo}|${rec.branch}|${rec.filePath}`);
        out.push(rec);
      }
    } catch {
      /* DB unavailable — disk-only path below */
    }
    // Merge disk-only records not already in the DB result.
    try {
      const disk = listFromDisk(repo, branch);
      for (const rec of disk) {
        if (rec.status !== "active") continue;
        const key = `${rec.targetRepo}|${rec.branch}|${rec.filePath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rec);
      }
    } catch {
      /* disk unreadable — best-effort */
    }
    return out;
  }

  /**
   * Delete a postmortem by ID (for the UI's "dismiss" button).
   * Returns TRUE when the DB row and/or its on-disk file was actually
   * deleted, FALSE when neither exists — the caller reports a 404, never
   * a false success.
   *
   * AUDIT 3 (defect 2): this used to delete ONLY the SQLite row. The
   * on-disk JSON under postmortems/ is the declared source of truth, so
   * ensureRehydrated re-imported the file on the next boot and the
   * "dismissed" record resurrected. Now the disk file is removed too.
   * The file's path is resolved from the DB row's (repo, branch,
   * filePath) when the DB knows the id; when it doesn't (record exists
   * ONLY on disk — wiped DB, failed rehydration, or DB down), the
   * composite id disk records carry (`repo/branch/filePath`, minted by
   * fromFileShape) is matched against the disk list instead, so a
   * disk-only postmortem can also be dismissed — otherwise it could
   * NEVER be dismissed and kept being re-imported (and re-injected)
   * forever. The file removal is best-effort: a missing or unreadable
   * file must not fail the DB delete.
   */
  async delete(id: string): Promise<boolean> {
    // 1. Resolve the record's (repo, branch, filePath) from the DB row.
    let target: { repo: string; branch: string; filePath: string } | null = null;
    try {
      const row = await db.postmortem.findUnique({
        where: { id },
        select: { targetRepo: true, branch: true, filePath: true },
      });
      if (row) target = { repo: row.targetRepo, branch: row.branch, filePath: row.filePath };
    } catch {
      /* DB read failed — try the composite disk-id fallback below */
    }
    // 2. Remove the on-disk file (source of truth) — best-effort.
    let fileRemoved = false;
    if (target) {
      try {
        fileRemoved = deletePostmortemFromDisk(target.repo, target.branch, target.filePath);
      } catch {
        /* best-effort — the DB delete below still runs */
      }
    } else {
      // Disk-only record: match the composite id (`repo/branch/filePath`).
      try {
        for (const rec of listAllPostmortemsFromDisk()) {
          if (rec.id === id) {
            fileRemoved = deletePostmortemFromDisk(rec.targetRepo, rec.branch, rec.filePath);
            break;
          }
        }
      } catch {
        /* best-effort */
      }
    }
    // 3. Delete the DB row.
    const result = await db.postmortem.deleteMany({ where: { id } });
    return result.count > 0 || fileRemoved;
  }

  // Typed against the generated Prisma row — was `any`, which silently
  // opted this mapping out of every type check the rest of the codebase
  // enjoys (a renamed column would have surfaced as undefined at runtime
  // instead of a compile error here).
  private mapRecord(r: PostmortemRow): PostmortemRecord {
    return {
      id: r.id,
      targetRepo: r.targetRepo,
      branch: r.branch,
      filePath: r.filePath,
      status: r.status as "active" | "resolved",
      verificationStatus: (r.verificationStatus as PostmortemRecord["verificationStatus"]) ?? "verified",
      failureType: r.failureType as PostmortemFailureType,
      symptom: r.symptom,
      evidence: r.evidence,
      constraints: r.constraints,
      attempts: r.attempts,
      reflection: r.reflection ?? null,
      parentHash: r.parentHash,
      hash: r.hash,
      // Defensive instanceof kept: disk-rehydrated rows pass through here
      // as ISO strings in some paths, and a future schema change to string
      // dates would otherwise break serialization silently.
      lastAttemptAt: r.lastAttemptAt instanceof Date ? r.lastAttemptAt.toISOString() : r.lastAttemptAt,
      resolvedAt: r.resolvedAt instanceof Date ? r.resolvedAt.toISOString() : r.resolvedAt,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
    };
  }
}

export const postmortemStore = new PostmortemStore();

/**
 * Generate postmortem data from a failed pipeline report.
 * Extracts the failure type, symptom, evidence, and constraints from the
 * AST diff result, sanitizer result, and review verdict.
 */
export function generatePostmortemFromReport(params: {
  filePath: string;
  astDiffResult: AstDiffResult;
  sanitizerResult: SecuritySanitizerResult;
  reviewVerdict: DebateVerdict;
  haltReason?: string;
}): {
  failureType: PostmortemFailureType;
  symptom: string;
  evidence: string;
  constraints: string;
} {
  const { filePath, astDiffResult, sanitizerResult, reviewVerdict, haltReason } = params;

  // Determine the primary failure type
  // NOTE: this function never produces HEADER_STRIPPED or COMPILE_ERROR —
  // those are recorded directly by the self-enhance loop. The switch below
  // widens back to the full union so those cases stay defensive.
  let failureType = "OTHER" as PostmortemFailureType;
  let symptom = `Pipeline failed for ${filePath}`;

  if (!astDiffResult.passed) {
    const highViolations = astDiffResult.violations.filter((v) => v.severity === "high");
    if (highViolations.some((v) => v.code === "AST_SYMBOL_DROPPED")) {
      failureType = "AST_SYMBOL_DROPPED";
      symptom = `AST gate rejected: ${highViolations
        .find((v) => v.code === "AST_SYMBOL_DROPPED")?.message.slice(0, 120)}`;
    } else if (highViolations.some((v) => v.code === "AST_STRUCTURAL_DRIFT")) {
      failureType = "AST_STRUCTURAL_DRIFT";
      symptom = `Structural drift exceeded safe threshold`;
    } else if (highViolations.some((v) => v.code === "BRANDING_INJECTION")) {
      failureType = "BRANDING_INJECTION";
      symptom = `Unauthorized persona/branding injection detected`;
    }
  } else if (
    reviewVerdict.consensus === "REJECTED" ||
    reviewVerdict.consensus === "REQUIRES_REWRITE"
  ) {
    failureType = "REVIEW_REJECTED";
    symptom = `Review tribunal rejected: ${reviewVerdict.consensus} (${(
      reviewVerdict.consensusCoefficient * 100
    ).toFixed(0)}% consensus)`;
  } else if (!sanitizerResult.clean && sanitizerResult.highEntropyTokensFound > 0) {
    failureType = "SANITIZER_REDACTION";
    symptom = `Sanitizer redacted ${sanitizerResult.highEntropyTokensFound} high-entropy token(s)`;
  } else if (haltReason === "ZERO_DIFF_SATURATION") {
    failureType = "ZERO_DIFF_SATURATION";
    symptom = `0-diff saturation: no semantic change produced`;
  }

  // Build evidence — machine-copied facts
  const evidenceParts: string[] = [];
  if (!astDiffResult.passed) {
    evidenceParts.push(`AST score: ${astDiffResult.astScore}/100`);
    evidenceParts.push(
      `Symbol map: orig=${astDiffResult.symbolMap.originalCount} proposed=${astDiffResult.symbolMap.proposedCount} retained=${astDiffResult.symbolMap.retainedCount}`
    );
    if (astDiffResult.symbolMap.missingSymbols.length > 0) {
      evidenceParts.push(
        `Missing symbols: ${astDiffResult.symbolMap.missingSymbols.map((s) => `${s.name} (${s.type})`).join(", ")}`
      );
    }
    for (const v of astDiffResult.violations) {
      evidenceParts.push(`Violation [${v.severity}] ${v.code}: ${v.message}`);
    }
  }
  if (!sanitizerResult.clean) {
    evidenceParts.push(`Sanitizer violations: ${sanitizerResult.violations.join("; ")}`);
    if (sanitizerResult.highEntropyTokensFound > 0) {
      evidenceParts.push(`High-entropy tokens redacted: ${sanitizerResult.highEntropyTokensFound}`);
    }
  }
  if (
    reviewVerdict.consensus === "REJECTED" ||
    reviewVerdict.consensus === "REQUIRES_REWRITE"
  ) {
    evidenceParts.push(`Review consensus: ${reviewVerdict.consensus}`);
    evidenceParts.push(`Security findings: ${reviewVerdict.securityPoints.join("; ")}`);
    evidenceParts.push(`Lead summary: ${reviewVerdict.leadSummary}`);
  }
  if (haltReason) {
    evidenceParts.push(`Halt reason: ${haltReason}`);
  }
  const evidence = evidenceParts.join("\n");

  // Build constraints — imperative instructions for the next attempt
  const constraintLines: string[] = [];
  switch (failureType) {
    case "AST_SYMBOL_DROPPED":
      constraintLines.push(
        `Preserve EVERY symbol from the original file. The following were dropped last time and MUST appear in the output:`
      );
      for (const s of astDiffResult.symbolMap.missingSymbols) {
        constraintLines.push(`  - ${s.name} (${s.type})`);
      }
      constraintLines.push(
        `Do NOT remove, rename, or merge any function, class, method, interface, type, or const.`
      );
      break;
    case "AST_STRUCTURAL_DRIFT":
      constraintLines.push(
        `Keep the structural drift under 65%. The last attempt drifted ${(
          astDiffResult.structuralDriftRatio * 100
        ).toFixed(0)}%.`
      );
      constraintLines.push(`Make minimal, surgical changes — do not restructure the file.`);
      break;
    case "BRANDING_INJECTION":
      constraintLines.push(
        `Do NOT add any persona/branding strings: ${astDiffResult.brandingInjections.join(", ")}`
      );
      break;
    case "REVIEW_REJECTED":
      constraintLines.push(`Address the review tribunal's findings:`);
      for (const p of reviewVerdict.securityPoints) {
        constraintLines.push(`  - ${p}`);
      }
      constraintLines.push(`Do not introduce credentials, eval(), or dynamic code execution.`);
      break;
    case "SANITIZER_REDACTION":
      constraintLines.push(
        `Do not introduce high-entropy strings that look like secrets. The sanitizer redacted ${sanitizerResult.highEntropyTokensFound} token(s).`
      );
      constraintLines.push(
        `If the file contains test fixtures (oracle IDs, expected hashes), keep them as-is — they are not secrets.`
      );
      break;
    case "HEADER_STRIPPED":
      constraintLines.push(`Preserve ALL import statements and file headers from the original.`);
      constraintLines.push(`Do not wipe imports, module declarations, or file-level comments.`);
      break;
    case "ZERO_DIFF_SATURATION":
      constraintLines.push(
        `The last attempt produced no semantic change (0-diff saturation). Make a real, meaningful refactor this time.`
      );
      constraintLines.push(
        `Add type annotations, extract constants, modularize — but preserve all public symbols.`
      );
      break;
    default:
      constraintLines.push(`Follow the standard refactoring rules from the system prompt.`);
  }
  const constraints = constraintLines.join("\n");

  return { failureType, symptom, evidence, constraints };
}

/**
 * Parse a markdown postmortem (like the POSTMORTEMS.md format from the user's
 * other enhancer) into a structured record. Supports the format:
 *
 *   ### ❌ [date] path/to/file.ts `source: ...`
 *   **Symptom:** ...
 *   **EVIDENCE:**
 *   ```
 *   ...
 *   ```
 *   **CONSTRAINT:** ...
 *   **STATUS:** ACTIVE
 */
export function parseMarkdownPostmortem(
  md: string,
  repo: string,
  branch: string
): Array<Omit<PostmortemRecord, "id" | "attempts" | "lastAttemptAt" | "resolvedAt" | "createdAt" | "updatedAt">> {
  const results: Array<
    Omit<PostmortemRecord, "id" | "attempts" | "lastAttemptAt" | "resolvedAt" | "createdAt" | "updatedAt">
  > = [];
  const entries = md.split(/^### ❌/m).slice(1);
  for (const entry of entries) {
    // Extract file path from the header line: [2026-10-25] path/to/file.ts `source: ...`
    const headerMatch = entry.match(/^\s*\[[^\]]*\]\s+(\S+)/);
    if (!headerMatch) continue;
    const filePath = headerMatch[1];

    // Extract symptom
    const symptomMatch = entry.match(/\*\*Symptom:\*\*\s*(.+)/);
    const symptom = symptomMatch ? symptomMatch[1].trim() : "Unknown failure";

    // Extract evidence (between ``` fences after EVIDENCE:)
    const evidenceMatch = entry.match(/\*\*EVIDENCE[^:]*:\*\*\s*```\s*([\s\S]*?)```/);
    const evidence = evidenceMatch ? evidenceMatch[1].trim() : "";

    // Extract constraints
    const constraintMatch = entry.match(/\*\*CONSTRAINT[^:]*:\*\*\s*<([^>]+)>/);
    const constraints = constraintMatch ? constraintMatch[1].trim() : "";

    // Determine failure type from symptom
    let failureType: PostmortemFailureType = "OTHER";
    const lowerSymptom = symptom.toLowerCase();
    if (lowerSymptom.includes("header stripped") || lowerSymptom.includes("import")) {
      failureType = "HEADER_STRIPPED";
    } else if (lowerSymptom.includes("ast") && lowerSymptom.includes("symbol")) {
      failureType = "AST_SYMBOL_DROPPED";
    } else if (lowerSymptom.includes("ast") && lowerSymptom.includes("rejected")) {
      failureType = "AST_SYMBOL_DROPPED";
    } else if (lowerSymptom.includes("type annotation")) {
      failureType = "COMPILE_ERROR";
    }

    results.push({
      targetRepo: repo,
      branch,
      filePath,
      status: "active",
      // Externally-seeded markdown = candidate by the verification
      // lifecycle: kept as a watch list, never injected into a prompt
      // until this system observes the same failure itself.
      verificationStatus: "candidate",
      failureType,
      symptom,
      evidence,
      constraints: constraints || `Avoid the failure described above when refactoring ${filePath}.`,
      // No chain fields — these records enter the DB through
      // recordFailure-style paths that compute chain hashes, or stay as
      // watch-list rows.
      parentHash: null,
      hash: null,
    });
  }
  return results;
}

/**
 * Seed postmortems from an external markdown file (e.g. POSTMORTEMS.md from
 * the user's other enhancer). Imports all entries as active postmortems.
 */
export async function seedPostmortemsFromMarkdown(
  md: string,
  repo: string,
  branch: string
): Promise<number> {
  const entries = parseMarkdownPostmortem(md, repo, branch);
  let count = 0;
  for (const entry of entries) {
    try {
      await postmortemStore.recordFailure({
        repo: entry.targetRepo,
        branch: entry.branch,
        filePath: entry.filePath,
        failureType: entry.failureType,
        symptom: entry.symptom,
        evidence: entry.evidence,
        constraints: entry.constraints,
        // Seeded from external markdown = CANDIDATE: someone else claimed
        // this file fails this way, but this system hasn't observed it.
        // Candidates are NOT injected into the LLM prompt until this
        // system records the same failure (upgrading to verified) or the
        // file succeeds (rejecting the claim). See getConstraintsForFile.
        verificationStatus: "candidate",
      });
      count++;
    } catch {
      /* ignore */
    }
  }
  return count;
}
