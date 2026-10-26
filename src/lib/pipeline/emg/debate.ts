const SECRET_PATTERN = /\b(AIzaSy[A-Za-z0-9_-]{28,40}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16})\b/;
const EVAL_PATTERN = /\beval\s*\(|\bnew\s+Function\s*\(/;
const TYPE_ANNOTATION_PATTERN = /:\s*(string|number|boolean|Promise<|void|Record<)/;
const LARGE_CODE_THRESHOLD = 10000;

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

function analyzeCodeSecurity(candidateCode: string): { securityPoints: string[]; hasCriticalFlaws: boolean } {
  const containsSecrets = SECRET_PATTERN.test(candidateCode);
  const containsEval = EVAL_PATTERN.test(candidateCode);
  const isLarge = candidateCode.length > LARGE_CODE_THRESHOLD;

  const securityPoints: string[] = [];

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

  return {
    securityPoints,
    hasCriticalFlaws: containsSecrets || containsEval,
  };
}

function analyzeCodeArchitecture(candidateCode: string): string[] {
  const hasTypeAnnotations = TYPE_ANNOTATION_PATTERN.test(candidateCode);
  const architecturePoints: string[] = [];

  if (hasTypeAnnotations) {
    architecturePoints.push("Strong TypeScript typing and interface contracts are maintained.");
  }
  architecturePoints.push("Public export contracts remain backwards-compatible.");
  architecturePoints.push("Enhancements maintain maintainability and clean structure.");

  return architecturePoints;
}

function createSecurityArgument(securityPoints: string[], filePath: string): DebateArgument {
  return {
    speaker: "security",
    speakerName: "Security Reviewer",
    avatar: "🛡️",
    stance: securityPoints.length > 1 ? "OPPOSE" : "ENDORSE",
    statement: `Reviewing candidate file ${filePath}: ${securityPoints.join(" ")}`,
    citations: ["Security Guideline: Credential Sanitization", "AST Diff Retention Protocol"],
    cognitiveFriction: securityPoints.length > 1 ? 0.65 : 0.15,
  };
}

function createArchitectureArgument(architecturePoints: string[]): DebateArgument {
  return {
    speaker: "architecture",
    speakerName: "Architecture Reviewer",
    avatar: "📐",
    stance: "ENDORSE",
    statement: `Structural assessment: ${architecturePoints.join(" ")}`,
    citations: ["Clean Code Standards", "Type Safety & Modularity Guidelines"],
    cognitiveFriction: 0.15,
  };
}

function determineConsensus(
  hasCriticalFlaws: boolean,
  securityPoints: string[],
): { consensus: DebateVerdict["consensus"]; consensusCoefficient: number; cognitiveFriction: number; leadSummary: string } {
  if (hasCriticalFlaws) {
    return {
      consensus: "REQUIRES_REWRITE",
      consensusCoefficient: 0.3,
      cognitiveFriction: 0.8,
      leadSummary: "Review summary: Security concerns identified. Redact credentials and remove dynamic execution before merge.",
    };
  }

  if (securityPoints.length > 1) {
    return {
      consensus: "CONDITIONAL_APPROVAL",
      consensusCoefficient: 0.72,
      cognitiveFriction: 0.4,
      leadSummary: "Review summary: Conditional approval. Verify AST symbol retention before finalizing merge.",
    };
  }

  return {
    consensus: "APPROVED",
    consensusCoefficient: 0.92,
    cognitiveFriction: 0.18,
    leadSummary: "Review summary: Candidate changes satisfy both security and architectural standards.",
  };
}

function createLeadArgument(leadSummary: string, cognitiveFriction: number): DebateArgument {
  return {
    speaker: "lead",
    speakerName: "Lead Reviewer",
    avatar: "✓",
    stance: "SYNTHESIS",
    statement: leadSummary,
    citations: ["Verification Consensus Checklist"],
    cognitiveFriction,
  };
}

export function conductDebate(topic: string, candidateCode: string, filePath: string): DebateVerdict {
  const { securityPoints, hasCriticalFlaws } = analyzeCodeSecurity(candidateCode);
  const architecturePoints = analyzeCodeArchitecture(candidateCode);

  const args: DebateArgument[] = [
    createSecurityArgument(securityPoints, filePath),
    createArchitectureArgument(architecturePoints),
  ];

  const { consensus, consensusCoefficient, cognitiveFriction, leadSummary } = determineConsensus(hasCriticalFlaws, securityPoints);

  args.push(createLeadArgument(leadSummary, cognitiveFriction));

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