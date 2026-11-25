import { stripComments } from "../autonomous/code-analysis";
import { createHash } from "node:crypto";

export interface HaltEvaluationState {
  shouldHalt: boolean;
  reason?:
    | "TREE_FINGERPRINT_SATURATED"
    | "ZERO_DIFF_SATURATION"
    | "CONSECUTIVE_FAILURE_LIMIT"
    | "MAX_CYCLES_REACHED";
  detail: string;
}

export interface TreeFileDescriptor {
  path: string;
  sha?: string;
  size?: number;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_MAX_CYCLES = 100;
const MAX_ALLOWED_CYCLES = 1000;
const WHITESPACE_REGEX = /\s+/g;
const SPECIAL_CHARACTERS_REGEX = /\s*([{};:,=()])\s*/g;

/**
 * Normalize code for zero-diff saturation comparison: remove comments and
 * collapse whitespace/punctuation spacing.
 *
 * Comment removal is done by the real TypeScript scanner
 * (stripComments from code-analysis.ts) — NOT by regex. The old
 * SINGLE_LINE_COMMENT_REGEX stripped from `//` to end-of-line inside STRING
 * literals too, so `"https://old.example"` → `"https://new.example"`
 * normalized to identical text and a REAL change was misclassified as
 * ZERO_DIFF_SATURATION (audit 2, item 10).
 */
export function normalizeCode(code: string): string {
  return stripComments(code)
    .replace(WHITESPACE_REGEX, " ")
    .replace(SPECIAL_CHARACTERS_REGEX, "$1")
    .trim();
}

/**
 * THE tree fingerprint (sha256, 2026-11-25 audit E). One definition shared
 * by the governor (below) and loop-runtime.ts — the two modules previously
 * carried byte-identical copies of a 32-bit hash.
 *
 * WHY SHA256 AND NOT THE OLD 32-BIT djb2-STYLE HASH: the fingerprint is a
 * "has the tree changed at all" detector — its whole value is NOT colliding.
 * A 32-bit hash over a ~1000-entry tree has meaningful birthday-collision
 * odds across a long endurance run (p ≈ n²/2³³ per pair set); a collision
 * reads as "tree unchanged" in watch mode, silently SKIPPING cycles on a
 * remotely-changed repo, and as "saturated" in the governor, halting the
 * loop on a false convergence. sha256 (256-bit) makes collisions a
 * non-event. Cost: one hash of a ~100KB string per cycle — nanoseconds.
 *
 * MIGRATION NOTE: persisted stats (LoopStats.lastTreeFingerprint) may hold
 * an old-format `tree_fp_<8hex>` value. On the first cycle after this
 * change the new-format fingerprint simply won't match the stored one —
 * watch mode runs one extra cycle instead of skipping (the safe direction)
 * and the stored value is overwritten with the new format on completion.
 * Self-healing; no migration code needed.
 */
export function computeTreeFingerprintHash(
  files: Array<{ path: string; sha?: string; size?: number }>
): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const raw = sorted.map((f) => `${f.path}:${f.sha ?? f.size ?? 0}`).join("|");
  return "tree_fp_" + createHash("sha256").update(raw).digest("hex");
}

export class SelfStoppingGovernor {
  private saturatedTreeHash: string | null = null;
  private consecutiveFailures = 0;
  private readonly maxConsecutiveFailures: number;
  private maxCycles: number;
  private currentCycle = 0;
  private skippedPaths = new Set<string>();
  private lastFilePath?: string;

  constructor(options?: { maxConsecutiveFailures?: number; maxCycles?: number }) {
    this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.maxCycles = options?.maxCycles ?? DEFAULT_MAX_CYCLES;
  }

  public computeTreeFingerprint(files: TreeFileDescriptor[]): string {
    return computeTreeFingerprintHash(files);
  }

  public checkTreeSaturation(currentTreeFingerprint: string): HaltEvaluationState | null {
    if (this.saturatedTreeHash && this.saturatedTreeHash === currentTreeFingerprint) {
      return {
        shouldHalt: true,
        reason: "TREE_FINGERPRINT_SATURATED",
        detail: `Tree fingerprint identical to prior saturation state (${currentTreeFingerprint}). Evolution converged.`,
      };
    }
    return null;
  }

  public setSaturatedTreeHash(hash: string): void {
    this.saturatedTreeHash = hash;
  }

  public checkZeroDiffSaturation(originalCode: string, proposedCode: string): HaltEvaluationState | null {
    const normOriginal = normalizeCode(originalCode);
    const normProposed = normalizeCode(proposedCode);
    if (normOriginal === normProposed) {
      return {
        shouldHalt: true,
        reason: "ZERO_DIFF_SATURATION",
        detail: "Normalized AST code difference is 0. System has reached maximum code saturation.",
      };
    }
    return null;
  }

  public recordResult(success: boolean, filePath?: string): HaltEvaluationState | null {
    if (filePath && this.lastFilePath && this.lastFilePath !== filePath) {
      this.currentCycle = 0;
    }
    if (filePath) {
      this.lastFilePath = filePath;
    }
    this.currentCycle++;
    if (this.currentCycle >= this.maxCycles) {
      return {
        shouldHalt: true,
        reason: "MAX_CYCLES_REACHED",
        detail: `Cycle cap of ${this.maxCycles} reached. Terminating loop to conserve resources.`,
      };
    }
    if (!success) {
      this.consecutiveFailures++;
      if (filePath) {
        this.skippedPaths.add(filePath);
      }
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        return {
          shouldHalt: true,
          reason: "CONSECUTIVE_FAILURE_LIMIT",
          detail: `Reached threshold of ${this.maxConsecutiveFailures} consecutive failure cycles. Quarantining mutations.`,
        };
      }
    } else {
      this.consecutiveFailures = 0;
    }
    return null;
  }

  public getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  public getMaxConsecutiveFailures(): number {
    return this.maxConsecutiveFailures;
  }

  public getSkippedPaths(): string[] {
    return Array.from(this.skippedPaths);
  }

  public getCurrentCycle(): number {
    return this.currentCycle;
  }

  public getMaxCycles(): number {
    return this.maxCycles;
  }

  public setMaxCycles(max: number): void {
    if (typeof max === "number" && max > 0) {
      this.maxCycles = Math.min(MAX_ALLOWED_CYCLES, max);
    }
  }

  public reset(): void {
    this.consecutiveFailures = 0;
    this.currentCycle = 0;
    this.skippedPaths.clear();
    this.saturatedTreeHash = null;
    this.lastFilePath = undefined;
  }
}