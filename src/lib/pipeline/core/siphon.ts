export interface SiphonSource {
  readonly id: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly label: string;
  readonly category: "neural" | "orchestration" | "verification" | "runtime" | "cryptography";
  readonly patterns: string[];
}

const SECURITY_THRESHOLD = 96;
const AGENT_THRESHOLD = 94;
const DEFAULT_THRESHOLD = 92;

const SECURITY_KEYWORDS = ["crypto", "auth", "token", "key"] as const;
const AGENT_KEYWORDS = ["agent", "loop", "engine", "prompt"] as const;

export const SIPHON_SOURCES: readonly SiphonSource[] = [
  {
    id: "pattern-optimizer-helper",
    owner: "craighckby-stack",
    repo: "pattern-optimizer-helper",
    branch: "main",
    label: "Pattern Optimization Helper",
    category: "orchestration",
    patterns: [
      "AST Diff Gate Verification",
      "AES-GCM Encrypted Storage Helper",
      "Context Continuity Protocol",
      "Multi-Model Fallback Helper",
      "Modular Code Architecture",
    ],
  },
  {
    id: "verification-governance-helper",
    owner: "craighckby-stack",
    repo: "verification-governance-helper",
    branch: "main",
    label: "Security & Verification Helper",
    category: "verification",
    patterns: [
      "Tri-Loop Autonomous Refactoring",
      "Tree Fingerprint Saturation Guard",
      "Zero-Diff Code Saturation Check",
      "Consecutive Failure Skip List",
      "Shannon Entropy Secret Sanitizer",
      "Dual-Perspective Code Review",
    ],
  },
  {
    id: "clean-room-agents-helper",
    owner: "craighckby-stack",
    repo: "clean-room-agents-helper",
    branch: "main",
    label: "Modular Agent Engines Helper",
    category: "runtime",
    patterns: [
      "5-Pillar Clean Architecture",
      "Bounded ReAct Reasoning Loop",
      "In-Memory VFS Sandbox",
      "Session Context Compaction",
      "Multi-Agent Coordination Helper",
    ],
  },
  {
    id: "deepmind-research",
    owner: "google-deepmind",
    repo: "deepmind-research",
    branch: "master",
    label: "Algorithm Research Patterns",
    category: "neural",
    patterns: ["Algorithmic Program Search", "Policy Heuristics", "Self-Supervised Verification"],
  },
  {
    id: "ms-autogen",
    owner: "microsoft",
    repo: "autogen",
    branch: "main",
    label: "Multi-Agent Coordination Helper",
    category: "orchestration",
    patterns: ["Conversational Agent Protocol", "Group Consensus Review", "Execution Sandbox"],
  },
  {
    id: "langchain-langgraph",
    owner: "langchain-ai",
    repo: "langgraph",
    branch: "main",
    label: "Stateful Workflow Helper",
    category: "runtime",
    patterns: ["Cyclic Graph State Machine", "State Checkpointing", "Human-in-the-Loop Review"],
  },
];

export interface ArchitecturalVote {
  source: SiphonSource;
  score: number;
  rationale: string;
  recommendedPattern: string;
}

function containsKeyword(text: string, keywords: readonly string[]): boolean {
  if (!text || typeof text !== 'string') {
    return false;
  }
  const lowerText = text.toLowerCase();
  return keywords.some(keyword => lowerText.includes(keyword));
}

function isSecurityRelated(fileName: string, codeSnippet: string): boolean {
  if (!fileName || typeof fileName !== 'string' || !codeSnippet || typeof codeSnippet !== 'string') {
    return false;
  }
  return containsKeyword(fileName, SECURITY_KEYWORDS) || 
         containsKeyword(codeSnippet, SECURITY_KEYWORDS);
}

function isAgentRelated(fileName: string, codeSnippet: string): boolean {
  if (!fileName || typeof fileName !== 'string' || !codeSnippet || typeof codeSnippet !== 'string') {
    return false;
  }
  return containsKeyword(fileName, AGENT_KEYWORDS) || 
         containsKeyword(codeSnippet, AGENT_KEYWORDS);
}

export function performArchitecturalVote(fileName: string, codeSnippet: string): ArchitecturalVote {
  if (!fileName || typeof fileName !== 'string' || !codeSnippet || typeof codeSnippet !== 'string') {
    throw new Error("fileName and codeSnippet must be non-empty strings");
  }
  
  const securitySource = SIPHON_SOURCES.find(source => source.category === "verification");
  const agentSource = SIPHON_SOURCES.find(source => source.category === "runtime");
  
  if (!securitySource) {
    throw new Error("Internal configuration error: Security siphon source is missing from SIPHON_SOURCES array. Please check array integrity for verification category.");
  }
  
  if (!agentSource) {
    throw new Error("Internal configuration error: Agent siphon source is missing from SIPHON_SOURCES array. Please check array integrity for runtime category.");
  }
  
  if (isSecurityRelated(fileName, codeSnippet)) {
    return {
      source: securitySource,
      score: SECURITY_THRESHOLD,
      rationale:
        "Handles sensitive keys and security credentials; applied Shannon entropy sanitization and memory isolation.",
      recommendedPattern: "Shannon Entropy Secret Sanitizer",
    };
  }

  if (isAgentRelated(fileName, codeSnippet)) {
    return {
      source: agentSource,
      score: AGENT_THRESHOLD,
      rationale:
        "Implements execution cycles or agent workflows; mapped to 5-Pillar Modular Agent Architecture.",
      recommendedPattern: "Bounded ReAct Reasoning Loop & VFS Sandbox",
    };
  }

  const defaultSource = SIPHON_SOURCES.find(source => source.category === "orchestration");
  if (!defaultSource) {
    throw new Error("Internal configuration error: Default siphon source is missing from SIPHON_SOURCES array. Please check array integrity for orchestration category.");
  }

  return {
    source: defaultSource,
    score: DEFAULT_THRESHOLD,
    rationale: "Standard code refactoring and AST verification baseline.",
    recommendedPattern: "AST Diff Gate Verification & Type Safety",
  };
}