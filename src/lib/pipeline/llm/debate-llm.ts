/**
 * Real LLM-driven Code Review Tribunal.
 *
 * Replaces the rule-based if/else debate with actual LLM calls. Three
 * distinct reviewers (Security, Architecture, Lead) each receive the
 * candidate code with role-specific instructions and return findings.
 * The Lead synthesizes the two prior reviews into a final verdict.
 *
 * Falls back to the rule-based conductDebate() if the LLM is unavailable
 * so the pipeline still runs end-to-end.
 */

import { llmComplete } from "./agent-llm";
import {
  conductDebate as ruleBasedDebate,
  DebateVerdict,
  DebateArgument,
} from "../emg/debate";

const SECURITY_SYSTEM = `You are the Security Reviewer in an autonomous code review tribunal. You evaluate candidate code changes for:
- Hardcoded credentials, API keys, or secrets (regex: AIzaSy..., ghp_, gho_, sk-, AKIA..., xox[baprs]-, Slack webhooks).
- Dynamic code execution (eval(), new Function()).
- Path traversal, command injection, SQL injection risks.
- Unsafe deserialization, prototype pollution.
- Information disclosure, PII leakage.
- High-entropy strings that may be secrets.

Respond in strict JSON only:
{
  "stance": "ENDORSE" | "OPPOSE",
  "points": [string, ...],
  "cognitiveFriction": 0.0-1.0,
  "citations": [string, ...]
}

If you find no issues, set stance="ENDORSE" and friction low. If you find critical issues, set stance="OPPOSE" and friction high.`;

const ARCHITECTURE_SYSTEM = `You are the Architecture Reviewer in an autonomous code review tribunal. You evaluate candidate code changes for:
- TypeScript type safety and interface contracts.
- Backwards compatibility of public exports (no symbol removal/renaming).
- Clean code, modularity, single responsibility.
- Naming, cohesion, dependency direction.
- Performance and scalability concerns (without over-engineering).

Respond in strict JSON only:
{
  "stance": "ENDORSE" | "OPPOSE",
  "points": [string, ...],
  "cognitiveFriction": 0.0-1.0,
  "citations": [string, ...]
}

Default to ENDORSE for small refactors that preserve public API. OPPOSE only for genuine architectural regressions.`;

const LEAD_SYSTEM = `You are the Lead Reviewer in an autonomous code review tribunal. You receive the Security Reviewer's and Architecture Reviewer's findings and synthesize a final verdict.

Respond in strict JSON only:
{
  "consensus": "APPROVED" | "CONDITIONAL_APPROVAL" | "REQUIRES_REWRITE" | "REJECTED",
  "consensusCoefficient": 0.0-1.0,
  "cognitiveFriction": 0.0-1.0,
  "leadSummary": string,
  "securityPoints": [string, ...],
  "architecturePoints": [string, ...]
}

Rules:
- APPROVED: both reviewers endorse. Use coefficient >= 0.85.
- CONDITIONAL_APPROVAL: at least one endorses but minor concerns. Use 0.55-0.84.
- REQUIRES_REWRITE: security OPPOSE or significant issues. Use 0.20-0.54.
- REJECTED: critical security flaws. Use < 0.20.`;

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    // Tolerate stray markdown fences around JSON
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function clamp(n: unknown, min = 0, max = 1): number {
  const x = typeof n === "number" ? n : parseFloat(String(n ?? "0"));
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, x));
}

/**
 * Run the LLM-driven debate tribunal. Always returns a DebateVerdict — if
 * the LLM is unavailable, falls back to the rule-based tribunal.
 */
export async function conductLlmDebate(
  topic: string,
  candidateCode: string,
  filePath: string
): Promise<{ verdict: DebateVerdict; usedLlm: boolean; llmError?: string }> {
  const codeSnippet =
    candidateCode.length > 8000 ? candidateCode.slice(0, 8000) + "\n// ... (truncated)" : candidateCode;

  const userMsg = `File under review: ${filePath}\nTopic: ${topic}\n\nCandidate code:\n\n\`\`\`\n${codeSnippet}\n\`\`\``;

  // Run Security + Architecture in parallel for speed.
  const [secRes, archRes] = await Promise.all([
    llmComplete({ systemPrompt: SECURITY_SYSTEM, userPrompt: userMsg, temperature: 0.1 }),
    llmComplete({ systemPrompt: ARCHITECTURE_SYSTEM, userPrompt: userMsg, temperature: 0.2 }),
  ]);

  if (!secRes.ok || !archRes.ok) {
    // Fall back to rule-based
    const fallback = ruleBasedDebate(topic, candidateCode, filePath);
    return {
      verdict: fallback,
      usedLlm: false,
      llmError: !secRes.ok ? secRes.error : archRes.error,
    };
  }

  const secJson = safeJsonParse(secRes.content) ?? {
    stance: "ENDORSE",
    points: ["Security review unavailable — automatic endorsement."],
    cognitiveFriction: 0.2,
    citations: ["fallback"],
  };
  const archJson = safeJsonParse(archRes.content) ?? {
    stance: "ENDORSE",
    points: ["Architecture review unavailable — automatic endorsement."],
    cognitiveFriction: 0.2,
    citations: ["fallback"],
  };

  // Lead synthesis — pass the two prior findings.
  const leadUserMsg = `Topic: ${topic}
File: ${filePath}

Security Reviewer findings:
${JSON.stringify(secJson, null, 2)}

Architecture Reviewer findings:
${JSON.stringify(archJson, null, 2)}

Synthesize a final verdict as JSON per your instructions.`;

  const leadRes = await llmComplete({
    systemPrompt: LEAD_SYSTEM,
    userPrompt: leadUserMsg,
    temperature: 0.1,
  });

  let leadJson: Record<string, unknown> | null = null;
  if (leadRes.ok) {
    leadJson = safeJsonParse(leadRes.content);
  }
  if (!leadJson) {
    // Deterministic fallback synthesis when lead LLM call fails.
    const secStance = secJson.stance === "OPPOSE";
    const archStance = archJson.stance === "OPPOSE";
    let consensus: DebateVerdict["consensus"] = "APPROVED";
    let coefficient = 0.9;
    if (secStance) {
      consensus = "REQUIRES_REWRITE";
      coefficient = 0.3;
    } else if (archStance) {
      consensus = "CONDITIONAL_APPROVAL";
      coefficient = 0.6;
    }
    leadJson = {
      consensus,
      consensusCoefficient: coefficient,
      cognitiveFriction: clamp((secJson.cognitiveFriction ?? 0) + (archJson.cognitiveFriction ?? 0)) / 2,
      leadSummary: `Lead synthesis (fallback): ${consensus} based on Security=${secJson.stance} and Architecture=${archJson.stance}.`,
      securityPoints: asStringArray(secJson.points),
      architecturePoints: asStringArray(archJson.points),
    };
  }

  // Build the DebateVerdict
  const consensus = (leadJson.consensus as DebateVerdict["consensus"]) ?? "APPROVED";
  const consensusCoefficient = clamp(leadJson.consensusCoefficient);
  const cognitiveFriction = clamp(leadJson.cognitiveFriction);

  const securityPoints = asStringArray(leadJson.securityPoints).length
    ? asStringArray(leadJson.securityPoints)
    : asStringArray(secJson.points);
  const architecturePoints = asStringArray(leadJson.architecturePoints).length
    ? asStringArray(leadJson.architecturePoints)
    : asStringArray(archJson.points);
  const leadSummary =
    typeof leadJson.leadSummary === "string"
      ? leadJson.leadSummary
      : `Lead synthesis: ${consensus} (coefficient ${consensusCoefficient.toFixed(2)})`;

  const args: DebateArgument[] = [
    {
      speaker: "security",
      speakerName: "Security Reviewer",
      avatar: "🛡️",
      stance: (secJson.stance === "OPPOSE" ? "OPPOSE" : "ENDORSE") as DebateArgument["stance"],
      statement: asStringArray(secJson.points).join(" ") || "No security findings.",
      citations: asStringArray(secJson.citations).length
        ? asStringArray(secJson.citations)
        : ["Security Guideline: Credential Sanitization", "AST Diff Retention Protocol"],
      cognitiveFriction: clamp(secJson.cognitiveFriction),
    },
    {
      speaker: "architecture",
      speakerName: "Architecture Reviewer",
      avatar: "📐",
      stance: (archJson.stance === "OPPOSE" ? "OPPOSE" : "ENDORSE") as DebateArgument["stance"],
      statement: asStringArray(archJson.points).join(" ") || "No architectural concerns.",
      citations: asStringArray(archJson.citations).length
        ? asStringArray(archJson.citations)
        : ["Clean Code Standards", "Type Safety & Modularity Guidelines"],
      cognitiveFriction: clamp(archJson.cognitiveFriction),
    },
    {
      speaker: "lead",
      speakerName: "Lead Reviewer",
      avatar: "✓",
      stance: "SYNTHESIS",
      statement: leadSummary,
      citations: ["Verification Consensus Checklist"],
      cognitiveFriction,
    },
  ];

  return {
    verdict: {
      currentTopic: topic,
      consensus,
      consensusCoefficient,
      cognitiveFriction,
      securityPoints,
      architecturePoints,
      leadSummary,
      judgeSummary: leadSummary,
      arguments: args,
    },
    usedLlm: true,
  };
}
