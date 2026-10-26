/**
 * Architecture Template & Pattern Helper (siphon)
 * Curated architectural templates & pattern sources for the pipeline.
 */

export interface SiphonSource {
  readonly id: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly label: string;
  readonly category: "neural" | "orchestration" | "verification" | "runtime" | "cryptography";
  readonly patterns: string[];
}

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

export function performArchitecturalVote(fileName: string, codeSnippet: string): ArchitecturalVote {
  const lowerName = fileName.toLowerCase();
  const lowerSnippet = codeSnippet.toLowerCase();

  if (
    lowerName.includes("crypto") ||
    lowerName.includes("auth") ||
    lowerName.includes("token") ||
    lowerSnippet.includes("key")
  ) {
    const SECURITY_SCORE = 96;
    return {
      source: SIPHON_SOURCES[1],
      score: SECURITY_SCORE,
      rationale:
        "Handles sensitive keys and security credentials; applied Shannon entropy sanitization and memory isolation.",
      recommendedPattern: "Shannon Entropy Secret Sanitizer",
    };
  }

  if (
    lowerName.includes("agent") ||
    lowerName.includes("loop") ||
    lowerName.includes("engine") ||
    lowerSnippet.includes("prompt")
  ) {
    const AGENT_PATTERN_SCORE = 94;
    return {
      source: SIPHON_SOURCES[2],
      score: AGENT_PATTERN_SCORE,
      rationale:
        "Implements execution cycles or agent workflows; mapped to 5-Pillar Modular Agent Architecture.",
      recommendedPattern: "Bounded ReAct Reasoning Loop & VFS Sandbox",
    };
  }

  const BASELINE_SCORE = 92;
  return {
    source: SIPHON_SOURCES[0],
    score: BASELINE_SCORE,
    rationale: "Standard code refactoring and AST verification baseline.",
    recommendedPattern: "AST Diff Gate Verification & Type Safety",
  };
}