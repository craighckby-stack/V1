/**
 * Secret / PII Scanner — pre-push gate.
 *
 * Concept grafted from: craighckby-stack/Git-Secret-PII-Sanitizer-2
 *   (src/lib/scanner.ts). See docs/CONCEPTS-GRAFTED.md GRAFT 1.
 *
 * Problem this solves: the operator's GitHub PAT leaked into git history
 * 3+ times because nothing scanned the working-tree diff BEFORE
 * `git add -A && git commit`. This module is the gate that was missing.
 *
 * Design:
 *   - SENSITIVE_PATTERNS: a curated regex catalog of high-signal secret
 *     shapes (GitHub PAT, OpenAI, Anthropic, Gemini, AWS, Azure, GitLab,
 *     Slack, Stripe, private keys, ...). Each entry carries a severity +
 *     placeholder so a finding can be reported AND redacted.
 *   - isAlreadyRedactedOrPlaceholder(): skip matches that are already a
 *     `<..._REDACTED>` token, or that live on a line defining the scanner's
 *     own regex (so the scanner never self-triggers on its own patterns).
 *   - isDocumentationOrDummySecret(): skip EXAMPLEKEY, YOUR_API_KEY,
 *     REPLACE_ME, CHANGEME, fictional domains, 555 phone numbers, etc.
 *     False-positive suppression is what makes the gate trustworthy enough
 *     to BLOCK a push on a hit.
 *   - calculateShannonEntropy(): high-entropy fallback for assignment-shaped
 *     lines that don't match a known provider pattern but look like a secret
 *     (e.g. `token = "a1b2c3..."` with no provider prefix).
 *   - scanContent(): scan a single file's content -> Finding[].
 *   - scanDiff(): scan a unified diff (only the ADDED `+` lines) -> Finding[].
 *     This is the pre-commit path: it sees exactly what's about to land in
 *     git history, never pre-existing content.
 *   - scanCommitMessage(): scan the commit message string -> Finding[].
 *
 * Security boundary: this module is pure logic — no network, no FS writes.
 * Callers (push-target.ts) decide what to do with Findings (block, redact,
 * log, postmortem).
 */

export type SecretSeverity = "Critical" | "High" | "Medium";
export type SecretConfidence = "High" | "Medium" | "Low";

export interface SecretPattern {
  id: string;
  name: string;
  category: string;
  regex: RegExp;
  placeholder: string;
  defaultConfidence: SecretConfidence;
  severity: SecretSeverity;
  description: string;
}

export interface SecretFinding {
  patternId: string;
  patternName: string;
  severity: SecretSeverity;
  confidence: SecretConfidence;
  /** The matched secret text (truncated in any UI/log to avoid re-leaking). */
  matchedText: string;
  /** A redacted preview safe to log: first 4 + last 4 chars + length. */
  redactedPreview: string;
  filePath: string;
  line: number;
  /** The full line (also redacted before logging by callers). */
  lineContent: string;
  /** For diff scans: the SHA the finding is relative to, if known. */
  inCommitMessage?: boolean;
}

/**
 * Curated secret catalog. Ordered by signal-to-noise (highest first).
 * Regexes use the `g` flag where multiple matches per line are expected;
 * scanContent re-instantiates each per-file to avoid lastIndex state.
 */
export const SENSITIVE_PATTERNS: SecretPattern[] = [
  // ── GitHub tokens ───────────────────────────────────────────────────
  {
    id: "github-pat",
    name: "GitHub Personal Access Token",
    category: "Authentication",
    regex: /\bghp_[A-Za-z0-9]{36}\b/g,
    placeholder: "<GITHUB_PAT_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed GitHub classic personal access token",
  },
  {
    id: "github-fine-grained-pat",
    name: "GitHub Fine-Grained PAT",
    category: "Authentication",
    regex: /\bgithub_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9]{59}\b/g,
    placeholder: "<GITHUB_PAT_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed GitHub fine-grained personal access token",
  },
  {
    id: "github-oauth-app",
    name: "GitHub OAuth / App / Server / Refresh Token",
    category: "Authentication",
    regex: /\b(?:gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36}\b/g,
    placeholder: "<GITHUB_TOKEN_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed GitHub OAuth/app/refresh token",
  },
  // ── AI / LLM provider keys ──────────────────────────────────────────
  {
    id: "openai-key",
    name: "OpenAI API Key",
    category: "AI Keys",
    regex: /\bsk-[A-Za-z0-9]{32,}\b/g,
    placeholder: "<OPENAI_API_KEY_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed OpenAI secret key",
  },
  {
    id: "anthropic-key",
    name: "Anthropic Claude API Key",
    category: "AI Keys",
    regex: /\bsk-ant-api[A-Za-z0-9_-]{20,}\b/g,
    placeholder: "<ANTHROPIC_API_KEY_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed Anthropic Claude API key",
  },
  {
    id: "google-gemini-key",
    name: "Google Gemini / Cloud API Key",
    category: "AI Keys",
    regex: /\bAIzaSy[A-Za-z0-9_-]{33}\b/g,
    placeholder: "<GEMINI_API_KEY_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed Google Gemini / Firebase AI key",
  },
  // ── Cloud providers ─────────────────────────────────────────────────
  {
    id: "aws-access-key",
    name: "AWS Access Key ID",
    category: "Cloud Keys",
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    placeholder: "<AWS_ACCESS_KEY_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed AWS access key ID",
  },
  {
    id: "azure-storage-key",
    name: "Azure Storage Account Key",
    category: "Cloud Keys",
    regex: /AccountKey=[A-Za-z0-9+/=]{80,}/g,
    placeholder: "<AZURE_STORAGE_KEY_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed Azure storage account key (connection string)",
  },
  // ── Other git hosts + SaaS ──────────────────────────────────────────
  {
    id: "gitlab-token",
    name: "GitLab Personal Access Token",
    category: "Authentication",
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    placeholder: "<GITLAB_TOKEN_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed GitLab access token",
  },
  {
    id: "slack-token",
    name: "Slack Token / Webhook",
    category: "Authentication",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    placeholder: "<SLACK_TOKEN_REDACTED>",
    defaultConfidence: "High",
    severity: "High",
    description: "Exposed Slack bot/app/user/webhook token",
  },
  {
    id: "stripe-key",
    name: "Stripe Secret / Restricted Key",
    category: "Payments",
    regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    placeholder: "<STRIPE_KEY_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed Stripe secret or restricted key",
  },
  // ── Generic private keys ────────────────────────────────────────────
  {
    id: "private-key-block",
    name: "PEM / Private Key Block",
    category: "Cryptography",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    placeholder: "<PRIVATE_KEY_REDACTED>",
    defaultConfidence: "High",
    severity: "Critical",
    description: "Exposed PEM private key header",
  },
];

/** Shannon entropy in bits per character. Used by the high-entropy fallback
 *  to catch assignment-shaped secrets with no provider prefix. */
export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) return 0;
  const freq = new Map<string, number>();
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    freq.set(c, (freq.get(c) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** A match is already a redaction placeholder (`<..._REDACTED>`) OR the line
 *  is defining the scanner's own regex/pattern (so the scanner never
 *  self-triggers on its own catalog). */
export function isAlreadyRedactedOrPlaceholder(
  matchedText: string,
  contextLine: string = ""
): boolean {
  if (!matchedText) return false;
  if (/<[A-Z0-9_-]+_REDACTED>/i.test(matchedText)) return true;
  if (/\[REDACTED[A-Z0-9_ -]*\]/i.test(matchedText)) return true;
  if (contextLine) {
    // The line is defining a scanner pattern entry (regex/placeholder/
    // patternId/defaultConfidence). Skipping these is what lets the scanner
    // live inside the same repo it scans without self-matching.
    if (/\b(?:placeholder|regex|patternId|defaultConfidence)\s*:\s*['"`/]/.test(contextLine)) {
      return true;
    }
    // A code comment that names the pattern id explicitly (docs/examples).
    if (new RegExp(`\\b${matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(contextLine) &&
        /\/\/.*scanner|\/\*.*scanner|\*.*pattern/i.test(contextLine)) {
      return true;
    }
  }
  return false;
}

/** Match is a well-known documentation/example dummy. Suppressing these is
 *  what makes the gate trustworthy (a doc string saying "paste YOUR_API_KEY
 *  here" must not block the push). */
export function isDocumentationOrDummySecret(
  matchedText: string,
  _patternId: string,
  contextLine: string = ""
): boolean {
  if (!matchedText) return false;
  const upper = matchedText.toUpperCase();
  const lineUpper = contextLine.toUpperCase();
  if (
    upper.includes("EXAMPLEKEY") ||
    upper.includes("YOUR_API_KEY") ||
    upper.includes("YOUR_KEY") ||
    upper.includes("INSERT_API_KEY") ||
    upper.includes("INSERT_KEY") ||
    upper.includes("MY_SECRET_KEY") ||
    upper.includes("DUMMY_KEY") ||
    upper.includes("REPLACE_ME") ||
    upper.includes("CHANGEME") ||
    upper.includes("SAMPLE_TOKEN") ||
    upper.includes("FAKE_SECRET") ||
    upper.includes("XXXXXXXXXXXX") ||
    upper.includes("000000000000")
  ) {
    return true;
  }
  if (
    lineUpper.includes("SAMPLE_SNIPPETS") ||
    lineUpper.includes("MOCK_CREDENTIAL") ||
    lineUpper.includes("DUMMY_DATA") ||
    lineUpper.includes("EXAMPLE:") ||
    lineUpper.includes("E.G.")
  ) {
    return true;
  }
  return false;
}

/** Produce a redacted preview of a secret: `ghp_…(36)` style, safe to log. */
export function redactSecret(text: string): string {
  if (!text) return "";
  if (text.length <= 8) return `${text[0]}…(${text.length})`;
  return `${text.slice(0, 4)}…${text.slice(-4)}(${text.length})`;
}

/** Paths the scanner should never scan (binaries, lockfiles, the scanner's
 *  own source, the .git internals). Conservative list. */
export function isIgnoredScanPath(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.toLowerCase();
  const ignoredDirs = [
    "node_modules/", ".git/", "dist/", "build/", "coverage/",
    ".next/", ".output/", "vendor/", "tmp/", "temp/", ".cache/",
    "download/", // sandbox download cache
  ];
  const ignoredFiles = [
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "composer.lock", "go.sum", "cargo.lock", "bun.lock",
  ];
  const binaryExtensions = [
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".zip", ".tar", ".gz", ".pdf", ".mp3", ".mp4", ".db",
  ];
  for (const d of ignoredDirs) if (normalized.includes(d)) return true;
  for (const f of ignoredFiles) if (normalized.endsWith(f)) return true;
  for (const e of binaryExtensions) if (normalized.endsWith(e)) return true;
  // Never scan the scanner's own source — it defines the regexes.
  if (normalized.endsWith("secret-scan.ts")) return true;
  return false;
}

/** Scan a single file's full content. Returns Findings (possibly empty). */
export function scanContent(
  content: string,
  filePath: string = "snippet.txt"
): SecretFinding[] {
  if (!content) return [];
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (const pattern of SENSITIVE_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const matchedText = match[0];
      const matchIndex = match.index;
      const preMatch = content.slice(0, matchIndex);
      const lineNumber = preMatch.split(/\r?\n/).length;
      const currentLine = lines[lineNumber - 1] || "";
      if (isAlreadyRedactedOrPlaceholder(matchedText, currentLine)) continue;
      if (isDocumentationOrDummySecret(matchedText, pattern.id, currentLine)) continue;
      findings.push({
        patternId: pattern.id,
        patternName: pattern.name,
        severity: pattern.severity,
        confidence: pattern.defaultConfidence,
        matchedText,
        redactedPreview: redactSecret(matchedText),
        filePath,
        line: lineNumber,
        lineContent: currentLine,
      });
    }
  }
  // High-entropy fallback: assignment-shaped lines whose value is a long
  // high-entropy string that didn't match a provider prefix.
  const entropyPattern = /(?:token|secret|api[_-]?key|password|passwd|pwd|access[_-]?key|private[_-]?key)\s*[:=]\s*['"]([A-Za-z0-9_+/=.-]{32,})['"]/gi;
  let em: RegExpExecArray | null;
  while ((em = entropyPattern.exec(content)) !== null) {
    const value = em[1];
    const matchIndex = em.index;
    const preMatch = content.slice(0, matchIndex);
    const lineNumber = preMatch.split(/\r?\n/).length;
    const currentLine = lines[lineNumber - 1] || "";
    if (isAlreadyRedactedOrPlaceholder(value, currentLine)) continue;
    if (isDocumentationOrDummySecret(value, "high-entropy", currentLine)) continue;
    const entropy = calculateShannonEntropy(value);
    // 4.0 bits/char is a high bar — base64 averages ~6, hex is 4, English
    // prose is ~3. This suppresses prose while catching opaque secrets.
    if (entropy < 4.0) continue;
    // Skip if a provider pattern already flagged this line.
    if (findings.some((f) => f.line === lineNumber && f.patternId !== "high-entropy-assignment")) continue;
    findings.push({
      patternId: "high-entropy-assignment",
      patternName: "High-Entropy Assignment (no provider prefix)",
      severity: "Medium",
      confidence: "Low",
      matchedText: value,
      redactedPreview: redactSecret(value),
      filePath,
      line: lineNumber,
      lineContent: currentLine,
    });
  }
  return findings;
}

/** Scan a unified diff. Only ADDED lines (starting with `+`, not `+++` hunk
 *  headers) are scanned — pre-existing content is out of scope for a
 *  pre-commit gate. Returns Findings (possibly empty). */
export function scanDiff(
  diffText: string,
  /** The path the diff is for, if known. Falls back to the diff's own header. */
  fallbackPath: string = "diff"
): SecretFinding[] {
  if (!diffText) return [];
  const findings: SecretFinding[] = [];
  let currentPath = fallbackPath;
  let lineNum = 0;
  const lines = diffText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track which file we're in: `diff --git a/x b/x` or `+++ b/x`.
    const diffHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffHeader) {
      currentPath = diffHeader[2];
      lineNum = 0;
      continue;
    }
    const plusPlusHeader = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusPlusHeader) {
      currentPath = plusPlusHeader[1];
      lineNum = 0;
      continue;
    }
    // Skip hunk headers `@@ -a,b +c,d @@` and removed lines `-`.
    if (/^@@/.test(line)) { lineNum = 0; continue; }
    if (line.startsWith("-")) continue;
    if (line.startsWith("+")) {
      // Added line — strip the leading `+` and scan just this line's content.
      const added = line.slice(1);
      lineNum++;
      // Inline-scan the single added line for each pattern (cheap).
      for (const pattern of SENSITIVE_PATTERNS) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags.replace("g", ""));
        const m = regex.exec(added);
        if (!m) continue;
        const matchedText = m[0];
        if (isAlreadyRedactedOrPlaceholder(matchedText, added)) continue;
        if (isDocumentationOrDummySecret(matchedText, pattern.id, added)) continue;
        findings.push({
          patternId: pattern.id,
          patternName: pattern.name,
          severity: pattern.severity,
          confidence: pattern.defaultConfidence,
          matchedText,
          redactedPreview: redactSecret(matchedText),
          filePath: currentPath,
          line: lineNum,
          lineContent: added,
        });
      }
      // High-entropy fallback on the added line.
      const em = /(?:token|secret|api[_-]?key|password|passwd|pwd|access[_-]?key|private[_-]?key)\s*[:=]\s*['"]([A-Za-z0-9_+/=.-]{32,})['"]/i.exec(added);
      if (em) {
        const value = em[1];
        if (!isAlreadyRedactedOrPlaceholder(value, added) &&
            !isDocumentationOrDummySecret(value, "high-entropy", added)) {
          const entropy = calculateShannonEntropy(value);
          if (entropy >= 4.0 &&
              !findings.some((f) => f.line === lineNum && f.patternId !== "high-entropy-assignment")) {
            findings.push({
              patternId: "high-entropy-assignment",
              patternName: "High-Entropy Assignment (no provider prefix)",
              severity: "Medium",
              confidence: "Low",
              matchedText: value,
              redactedPreview: redactSecret(value),
              filePath: currentPath,
              line: lineNum,
              lineContent: added,
            });
          }
        }
      }
    }
  }
  return findings;
}

/** Scan a commit message. Commit messages are free text; the diff scanner
 *  doesn't see them, so a secret pasted into the message would survive every
 *  other gate. */
export function scanCommitMessage(message: string): SecretFinding[] {
  if (!message) return [];
  const findings: SecretFinding[] = [];
  const lines = message.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of SENSITIVE_PATTERNS) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags.replace("g", ""));
      const m = regex.exec(line);
      if (!m) continue;
      const matchedText = m[0];
      if (isAlreadyRedactedOrPlaceholder(matchedText, line)) continue;
      if (isDocumentationOrDummySecret(matchedText, pattern.id, line)) continue;
      findings.push({
        patternId: pattern.id,
        patternName: pattern.name,
        severity: pattern.severity,
        confidence: pattern.defaultConfidence,
        matchedText,
        redactedPreview: redactSecret(matchedText),
        filePath: "<commit-message>",
        line: i + 1,
        lineContent: line,
        inCommitMessage: true,
      });
    }
  }
  return findings;
}

/** Severity-rank: Critical > High > Medium. Used to pick the worst finding
 *  for the block reason. */
const SEVERITY_RANK: Record<SecretSeverity, number> = {
  Critical: 3,
  High: 2,
  Medium: 1,
};

/** Summarize findings into a single go/no-go + a human-readable reason.
 *  `blockOnMedium` controls whether Medium-severity (high-entropy, low
 *  confidence) findings block — callers may want to only warn on those. */
export function summarizeFindings(
  findings: SecretFinding[],
  blockOnMedium: boolean = false
): { block: boolean; worst: SecretFinding | null; reason: string } {
  if (findings.length === 0) return { block: false, worst: null, reason: "" };
  const blocking = findings.filter(
    (f) => blockOnMedium || f.severity !== "Medium"
  );
  if (blocking.length === 0) {
    // Only medium findings — warn but don't block.
    const worst = findings.reduce((a, b) => (SEVERITY_RANK[a.severity] >= SEVERITY_RANK[b.severity] ? a : b));
    return {
      block: false,
      worst,
      reason: `Secret scanner: ${findings.length} low-confidence finding(s) (warn only). Worst: ${worst.patternName} in ${worst.filePath}:${worst.line}`,
    };
  }
  const worst = blocking.reduce((a, b) => (SEVERITY_RANK[a.severity] >= SEVERITY_RANK[b.severity] ? a : b));
  const reason =
    `Secret scanner BLOCKED commit: ${blocking.length} finding(s). ` +
    `Worst: ${worst.patternName} [${worst.severity}] in ${worst.filePath}:${worst.line} ` +
    `(${worst.redactedPreview}). Run 'push <PAT> <owner/repo>' to reconfigure ` +
    `or remove the secret before committing.`;
  return { block: true, worst, reason };
}
