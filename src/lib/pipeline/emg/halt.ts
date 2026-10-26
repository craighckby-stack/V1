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
const SINGLE_LINE_COMMENT_REGEX = /\/\/[^\n\r]*/g;
const MULTI_LINE_COMMENT_REGEX = /\/\*[\s\S]*?\*\//g;

export function normalizeCode(code: string): string {
  return code
    .replace(MULTI_LINE_COMMENT_REGEX, "")
    .replace(SINGLE_LINE_COMMENT_REGEX, "")
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
    this.maxCycles = options?.maxCycles ?? DEFAULT_MAX_CYCLES;
  }

  public computeTreeFingerprint(files: TreeFileDescriptor[]): string {
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