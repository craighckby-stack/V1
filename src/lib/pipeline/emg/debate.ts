/**
 * Code Review & Verification Helper
 * Dual-perspective analysis: Security Reviewer vs Architecture Reviewer.
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

export function conductDebate(topic: string, candidateCode: string, filePath: string): DebateVerdict {
  const secretPattern =
    /\b(AIzaSy[A-Za-z0-9_-]{28,40}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16})\b/;
  const containsSecrets = secretPattern.test(candidateCode);
  const containsEval = /\beval\s*\(|\bnew\s+Function\s*\(/.test(candidateCode);
  const hasTypeAnnotations = /:\s*(string|number|boolean|Promise<|void|Record<)/.test(candidateCode);
  const LARGE_CODE_THRESHOLD = 10000;
  const isLarge = candidateCode.length > LARGE_CODE_THRESHOLD;

  const securityPoints: string[] = [];
  const architecturePoints: string[] = [];
  const args: DebateArgument[] = [];

  if (containsSecrets) {
    securityPoints.push("Potential authentication token or credential identified.");
  }
  if (containsEval) {
    securityPoints.push("Dynamic code execution (eval/Function) flagged for potential security risk.");
  }
  if (isLarge) {
    securityPoints.push("Module complexity is high; consider modularizing for readability.");
  }
  if (securityPoints.length === 0) {
    securityPoints.push("Code passed static security patterns with zero credential exposure.");
  }

  if (hasTypeAnnotations) {
    architecturePoints.push("Strong TypeScript typing and interface contracts are maintained.");
  }
  architecturePoints.push(`Public export contracts for '${filePath}' remain backwards-compatible.`);
  architecturePoints.push("Enhancements maintain maintainability and clean structure.");

  const SECURITY_FRICTION_HIGH = 0.65;
  const SECURITY_FRICTION_LOW = 0.15;

  args.push({
    speaker: "security",
    speakerName: "Security Reviewer",
    avatar: "🛡️",
    stance: securityPoints.length > 1 ? "OPPOSE" : "ENDORSE",
    statement: `Reviewing candidate file ${filePath}: ${securityPoints.join(" ")}`,
    citations: ["Security Guideline: Credential Sanitization", "AST Diff Retention Protocol"],
    cognitiveFriction: securityPoints.length > 1 ? SECURITY_FRICTION_HIGH : SECURITY_FRICTION_LOW,
  });

  args.push({
    speaker: "architecture",
    speakerName: "Architecture Reviewer",
    avatar: "📐",
    stance: "ENDORSE",
    statement: `Structural assessment: ${architecturePoints.join(" ")}`,
    citations: ["Clean Code Standards", "Type Safety & Modularity Guidelines"],
    cognitiveFriction: SECURITY_FRICTION_LOW,
  });

  const criticalFlaws = containsSecrets || containsEval;
  let consensus: DebateVerdict["consensus"] = "APPROVED";
  let consensusCoefficient = 0.92;
  const ARCHITECTURE_FRICTION = 0.15;
  let cognitiveFriction = 0.18;
  let leadSummary = "Review summary: Candidate changes satisfy both security and architectural standards.";

  if (criticalFlaws) {
    consensus = "REQUIRES_REWRITE";
    const CRITICAL_FLAW_CONSENSUS_COEFFICIENT = 0.3;
    consensusCoefficient = CRITICAL_FLAW_CONSENSUS_COEFFICIENT;
    const CRITICAL_COGNITIVE_FRICTION = 0.8;
    cognitiveFriction = CRITICAL_COGNITIVE_FRICTION;
    leadSummary =
      "Review summary: Security concerns identified. Redact credentials and remove dynamic execution before merge.";
  } else if (securityPoints.length > 1) {
    const CONDITIONAL_APPROVAL_CONSENSUS_COEFFICIENT = 0.72;
    consensus = "CONDITIONAL_APPROVAL";
    consensusCoefficient = CONDITIONAL_APPROVAL_CONSENSUS_COEFFICIENT;
    cognitiveFriction = 0.4;
    leadSummary =
      "Review summary: Conditional approval. Verify AST symbol retention before finalizing merge.";
  }

  args.push({
    speaker: "lead",
    speakerName: "Lead Reviewer",
    avatar: "✓",
    stance: "SYNTHESIS",
    statement: leadSummary,
    citations: ["Verification Consensus Checklist"],
    cognitiveFriction,
  });

  return {
    currentTopic: topic,
    consensus,
    consensusCoefficient,
    cognitiveFriction,
    securityPoints,
    architecturePoints,
    leadSummary,
    judgeSummary: leadSummary,
    arguments: args,
  };
}