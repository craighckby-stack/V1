export interface SiphonSource {
  readonly id: string;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly label: string;
  readonly category: "neural" | "orchestration" | "verification" | "runtime" | "cryptography";
  readonly patterns: string[];
}

// NOTE (audit 7 de-mock): SECURITY_THRESHOLD / AGENT_THRESHOLD /
// DEFAULT_THRESHOLD / SECURITY_KEYWORDS / AGENT_KEYWORDS were removed.
// They drove the mock performArchitecturalVote's hardcoded 96/94/92
// "confidence" scores. The honest no-op replacement (below) doesn't
// need them. The SIPHON_SOURCES catalog is retained as a reference
// list (the UI dropdown + /api/engines/catalog serve it), but it no
// longer drives a fake selection.

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

/**
 * performArchitecturalVote — HONEST NO-OP (audit 7 de-mock).
 *
 * The previous implementation was a MOCK SIMULATION: it matched keywords
 * (crypto/auth/token/key → 96; agent/loop/engine/prompt → 94; else → 92)
 * and returned hardcoded scores + rationale strings, which the manual
 * pipeline's Stage 0 then surfaced as "[STAGE 0] Selected pattern: X
 * (Confidence: 96%)" — presenting a hardcoded constant as a measured
 * confidence. That was dishonest: no measurement happened.
 *
 * The honest replacement returns a NEUTRAL vote: score 0, rationale
 * "no template selection — the LLM refactors directly", recommendedPattern
 * "Direct LLM Refactor". The manual pipeline's Stage 0 now logs this
 * honestly. The SIPHON_SOURCES catalog stays as a reference list (the UI
 * dropdown and the /api/engines/catalog route still serve it), but it no
 * longer drives a fake selection.
 *
 * The interface is unchanged (returns ArchitecturalVote) so
 * unified-pipeline.ts and its type `patternVote`/`siphonVote` compile
 * without modification. A future real classifier (LLM-based, measured)
 * can replace this no-op; until then, nothing is pretending to measure.
 */
export function performArchitecturalVote(fileName: string, codeSnippet: string): ArchitecturalVote {
  if (!fileName || typeof fileName !== "string" || fileName.trim() === "") {
    throw new Error("Invalid input: fileName must be a non-empty string");
  }
  if (!codeSnippet || typeof codeSnippet !== "string" || codeSnippet.trim() === "") {
    throw new Error("Invalid input: codeSnippet must be a non-empty string");
  }
  // The "orchestration" source is the neutral default — it's the category
  // for general refactoring, not a security/agent specialization. Using it
  // as the no-op anchor keeps the SIPHON_SOURCES reference list coherent.
  const defaultSource =
    SIPHON_SOURCES.find((source) => source.category === "orchestration") ??
    SIPHON_SOURCES[0];
  if (!defaultSource) {
    throw new Error("Internal configuration error: SIPHON_SOURCES is empty — cannot anchor the no-op vote.");
  }
  return {
    source: defaultSource,
    score: 0,
    rationale:
      "no template selection — the LLM refactors this file directly (audit 7 de-mock: the prior keyword-classifier vote was a hardcoded simulation, not a measurement)",
    recommendedPattern: "Direct LLM Refactor",
  };
}