import { stripComments } from "../autonomous/code-analysis";

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
  if (typeof code !== "string") {
    throw new Error("normalizeCode requires a string input");
  }
  return stripComments(code)
    .replace(WHITESPACE_REGEX, " ")
    .replace(SPECIAL_CHARACTERS_REGEX, "$1")
    .trim();
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
    
    // Validate maxCycles
    if (typeof options?.maxCycles !== "number" || options.maxCycles <= 0) {
      this.maxCycles = DEFAULT_MAX_CYCLES;
    } else {
      this.maxCycles = Math.min(MAX_ALLOWED_CYCLES, options.maxCycles);
    }
  }

  public computeTreeFingerprint(files: TreeFileDescriptor[]): string {
    if (!files || !Array.isArray(files)) {
      throw new Error("computeTreeFingerprint requires a non-empty array of TreeFileDescriptor");
    }
    
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const raw = sorted.map(f => `${f.path}:${f.sha ?? f.size ?? 0}`).join("|");
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    return `tree_fp_${Math.abs(hash).toString(16)}`;
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
    if (typeof hash !== "string") {
      throw new Error("setSaturatedTreeHash requires a string input");
    }
    this.saturatedTreeHash = hash;
  }

  public checkZeroDiffSaturation(originalCode: string, proposedCode: string): HaltEvaluationState | null {
    if (typeof originalCode !== "string" || typeof proposedCode !== "string") {
      throw new Error("checkZeroDiffSaturation requires string inputs for both originalCode and proposedCode");
    }
    
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
    if (typeof success !== "boolean") {
      throw new Error("recordResult requires a boolean value for success");
    }
    
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
    if (typeof max !== "number" || max <= 0) {
      throw new Error("setMaxCycles requires a positive number");
    }
    this.maxCycles = Math.min(MAX_ALLOWED_CYCLES, max);
  }

  public reset(): void {
    this.consecutiveFailures = 0;
    this.currentCycle = 0;
    this.skippedPaths.clear();
    this.saturatedTreeHash = null;
    this.lastFilePath = undefined;
  }
}