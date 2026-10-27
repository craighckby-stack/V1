/**
 * Debate tribunal TYPES.
 *
 * The verdicts described by these interfaces are produced exclusively by the
 * real LLM tribunal in src/lib/pipeline/llm/debate-llm.ts (three actual LLM
 * reviews: Security, Architecture, Lead synthesis).
 *
 * The old rule-based `conductDebate()` — regex checks dressed up as a
 * "review tribunal" that fabricated reviewer statements and verdicts — was
 * removed. Deterministic regex checks are legitimate static analysis, but
 * presenting their output as a debate between reviewers was a simulation.
 * The LLM tribunal throws when it cannot run; it never fabricates a verdict.
 */

export interface DebateArgument {
  speaker: "security" | "architecture" | "lead";
  speakerName: string;
  avatar: string;
  stance: "OPPOSE" | "ENDORSE" | "SYNTHESIS";
  statement: string;
  citations: string[];
  cognitiveFriction: number;
}

export interface DebateVerdict {
  currentTopic: string;
  consensus: "APPROVED" | "REJECTED" | "CONDITIONAL_APPROVAL" | "REQUIRES_REWRITE";
  consensusCoefficient: number;
  cognitiveFriction: number;
  securityPoints: string[];
  architecturePoints: string[];
  leadSummary: string;
  judgeSummary?: string;
  arguments: DebateArgument[];
}
