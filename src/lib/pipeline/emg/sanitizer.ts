/**
 * Security Sanitizer & Governance Helper
 * Shannon entropy on tokens, secret pattern matching, PII redaction.
 */

export type ErrorClass =
  | "HARDCODED_CRED"
  | "SECRET_LEAKAGE"
  | "HIGH_ENTROPY_TOKEN"
  | "PII"
  | "AST_PARSE"
  | "UNGROUNDED_CLAIMS"
  | "CLEAN";

export interface SecuritySanitizerResult {
  readonly clean: boolean;
  readonly sanitizedCode: string;
  readonly errorClass: ErrorClass;
  readonly violations: readonly string[];
  readonly autoAppliedFix?: string;
  readonly highEntropyTokensFound: number;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /AIzaSy[A-Za-z0-9_-]{33}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /gho_[A-Za-z0-9]{36}/g,
  /sk-[A-Za-z0-9]{32,48}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[0-9a-zA-Z-]{10,48}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]+/g,
];

const PII_PATTERNS: readonly RegExp[] = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) return 0;
  const frequencies = new Map<string, number>();
  for (let i = 0; i < str.length; i++) {
    const char = str[i]!;
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function sanitizeAndGovern(inputCode: string): SecuritySanitizerResult {
  const violations: string[] = [];
  let sanitized = inputCode;
  let highEntropyTokensFound = 0;

  for (const pattern of SECRET_PATTERNS) {
    const matches = sanitized.match(pattern);
    if (matches) {
      for (const match of matches) {
        violations.push(
          `Detected known secret signature: ${match.slice(0, 6)}... (length: ${match.length})`
        );
        sanitized = sanitized.split(match).join(`[REDACTED_SECRET_${match.slice(0, 4)}]`);
      }
    }
  }

  for (const pii of PII_PATTERNS) {
    const matches = sanitized.match(pii);
    if (matches) {
      for (const match of matches) {
        violations.push(`Detected PII leak: ${match.slice(0, 3)}***`);
        sanitized = sanitized.split(match).join("[REDACTED_PII]");
      }
    }
  }

  const stringLiterals = inputCode.match(/["']([A-Za-z0-9_\-+/=]{24,})["']/g);
  if (stringLiterals) {
    for (const literal of stringLiterals) {
      const inner = literal.slice(1, -1);
      const entropy = calculateShannonEntropy(inner);
      if (entropy > 4.15) {
        highEntropyTokensFound++;
        violations.push(
          `Detected high-entropy string (entropy: ${entropy.toFixed(2)}): ${inner.slice(0, 6)}...`
        );
        sanitized = sanitized.split(inner).join("[REDACTED_HIGH_ENTROPY_KEY]");
      }
    }
  }

  const isClean = violations.length === 0;
  const errorClass: ErrorClass = isClean
    ? "CLEAN"
    : highEntropyTokensFound > 0
    ? "HIGH_ENTROPY_TOKEN"
    : "SECRET_LEAKAGE";

  return {
    clean: isClean,
    sanitizedCode: sanitized,
    errorClass,
    violations,
    autoAppliedFix: isClean ? undefined : sanitized,
    highEntropyTokensFound,
  };
}
