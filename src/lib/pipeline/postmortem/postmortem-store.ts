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

import { db } from "@/lib/db";
import type { AstDiffResult } from "../core/ast-diff-gate";
import type { SecuritySanitizerResult } from "../emg/sanitizer";
import type { DebateVerdict } from "../emg/debate";
import {
  writePostmortemToDisk,
  readPostmortemFromDisk,
  resolvePostmortemOnDisk,
  listFromDisk,
  rehydrateSqliteFromDisk,
} from "./postmortem-repo";

export type PostmortemFailureType =
  | "AST_SYMBOL_DROPPED"
  | "AST_STRUCTURAL_DRIFT"
  | "BRANDING_INJECTION"
  | "REVIEW_REJECTED"
  | "SANITIZER_REDACTION"
  | "HEADER_STRIPPED"
  | "COMPILE_ERROR"
  | "ZERO_DIFF_SATURATION"
  | "OTHER";

export interface PostmortemRecord {
  id: string;
  targetRepo: string;
  branch: string;
  filePath: string;
  status: "active" | "resolved";
  failureType: PostmortemFailureType;
  symptom: string;
  evidence: string;
  constraints: string;
  attempts: number;
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
      const imported = await rehydrateSqliteFromDisk(async (rec) => {
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
          },
        });
      });
      if (imported > 0) {
        console.log(`[POSTMORTEM] rehydrated ${imported} record(s) from repo to DB`);
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
    return `\n\n--- POSTMORTEM CONSTRAINTS (this file failed ${pm.attempts} time(s) before) ---
FAILURE TYPE: ${pm.failureType}
SYMPTOM: ${pm.symptom}
EVIDENCE:
${pm.evidence}
CONSTRAINTS (MUST follow ALL of these):
${pm.constraints}
--- END POSTMORTEM CONSTRAINTS ---\n\n`;
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
  }): Promise<PostmortemRecord> {
    const { repo, branch, filePath, failureType, symptom, evidence, constraints } = params;
    let record: PostmortemRecord;
    try {
      const existing = await db.postmortem.findUnique({
        where: {
          targetRepo_branch_filePath: { targetRepo: repo, branch, filePath },
        },
      });
      if (existing) {
        const updated = await db.postmortem.update({
          where: { id: existing.id },
          data: {
            status: "active",
            failureType,
            symptom,
            evidence,
            constraints,
            attempts: { increment: 1 },
            lastAttemptAt: new Date(),
            resolvedAt: null,
            updatedAt: new Date(),
          },
        });
        record = this.mapRecord(updated);
      } else {
        const created = await db.postmortem.create({
          data: {
            targetRepo: repo,
            branch,
            filePath,
            status: "active",
            failureType,
            symptom,
            evidence,
            constraints,
            attempts: 1,
            lastAttemptAt: new Date(),
          },
        });
        record = this.mapRecord(created);
      }
    } catch (err) {
      // DB unavailable — build an in-memory record and STILL write it to
      // disk. The previous code returned an in-memory record that nothing
      // could recall (getActivePostmortem only read from DB). Now the disk
      // write means the next getActivePostmortem finds it even with a dead DB.
      record = {
        id: `pm_${Date.now()}`,
        targetRepo: repo,
        branch,
        filePath,
        status: "active",
        failureType,
        symptom,
        evidence,
        constraints,
        attempts: 1,
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
   */
  async markResolved(repo: string, branch: string, filePath: string): Promise<void> {
    try {
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
   * Returns TRUE when a row was actually deleted, FALSE when the id
   * does not exist — the caller reports a 404, never a false success.
   */
  async delete(id: string): Promise<boolean> {
    const result = await db.postmortem.deleteMany({ where: { id } });
    return result.count > 0;
  }

  private mapRecord(r: any): PostmortemRecord {
    return {
      id: r.id,
      targetRepo: r.targetRepo,
      branch: r.branch,
      filePath: r.filePath,
      status: r.status as "active" | "resolved",
      failureType: r.failureType as PostmortemFailureType,
      symptom: r.symptom,
      evidence: r.evidence,
      constraints: r.constraints,
      attempts: r.attempts,
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
      failureType,
      symptom,
      evidence,
      constraints: constraints || `Avoid the failure described above when refactoring ${filePath}.`,
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
      });
      count++;
    } catch {
      /* ignore */
    }
  }
  return count;
}
