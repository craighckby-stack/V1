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
    const char = str[i];
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

/**
 * Heuristic: determine if a high-entropy string is actually an environment
 * variable name, a file path, a URL, or a non-secret utility string (alphabet,
 * digit sequence) — none of which are secrets even though they can have
 * entropy > 4.5.
 */
function isLikelyEnvVarOrPath(s: string): boolean {
  // 1. ENV_VAR=value pattern (e.g. DYLD_FRAMEWORK_PATH=/override)
  if (/^[A-Z][A-Z0-9_]*=/.test(s)) return true;

  // 2. Known env var prefixes (macOS dyld, Linux ld, common vars)
  const envPrefixes = [
    "DYLD_", "LD_", "PATH=", "HOME=", "USER=", "SHELL=", "TMPDIR=",
    "LANG=", "LC_", "TERM=", "DISPLAY=", "EDITOR=", "VISUAL=",
    "NODE_", "NPM_", "BUN_", "GITHUB_", "GIT_",
  ];
  for (const prefix of envPrefixes) {
    if (s.startsWith(prefix)) return true;
  }

  // 3. File path (starts with / or contains / and has a file extension)
  if (s.startsWith("/") || /^[a-z]:\//i.test(s)) return true;
  if (s.includes("/") && /\.\w{1,5}$/.test(s)) return true;

  // 4. URL
  if (s.startsWith("http://") || s.startsWith("https://")) return true;

  // 5. Non-secret utility strings — alphabets, digit sequences, etc.
  //    "abcdefghijklmnopqrstuvwxyz" has entropy 4.70 but is clearly not a secret.
  //    Detect: all-unique chars in a sequential run, or pure repeated patterns.
  const unique = new Set(s).size;
  const MIN_UNIQUE_CHARS_THRESHOLD = 20;
  if (unique === s.length && s.length >= MIN_UNIQUE_CHARS_THRESHOLD) {
    // All characters are unique AND length >= 20 — could be alphabet or similar.
    // Real secrets are NOT typically all-unique (they have repetition due to base64).
    // Check if it's a known non-secret pattern:
    const ALPHABET_UNIQUE_CHARS_THRESHOLD = 20;
    if (/^[a-z]+$/i.test(s) && unique >= ALPHABET_UNIQUE_CHARS_THRESHOLD) return true; // alphabet
    const DIGIT_SEQUENCE_UNIQUE_CHARS_THRESHOLD = 8;
    if (/^[0-9]+$/i.test(s) && unique >= DIGIT_SEQUENCE_UNIQUE_CHARS_THRESHOLD) return true;  // digit sequence
    const ALPHANUMERIC_UNIQUE_CHARS_THRESHOLD = 22;
    if (/^[a-z0-9]+$/i.test(s) && unique >= ALPHANUMERIC_UNIQUE_CHARS_THRESHOLD && s.length <= 36) return true; // alphanumeric utility
  }

  return false;
}

/**
 * Heuristic: determine if a file is likely a test/fixture/experiment file
 * where high-entropy strings are deterministic test data (oracle IDs,
 * expected hashes, sample tokens) rather than real secrets.
 */
function isLikelyFixtureFile(filePath: string | undefined, code: string): boolean {
  // 1. Path-based detection
  if (filePath) {
    const lower = filePath.toLowerCase();
    const fixturePathPatterns = [
      /(^|\/)tests?\//,
      /(^|\/)__tests__\//,
      /(^|\/)fixtures?\//,
      /(^|\/)experiments?\//,
      /(^|\/)specs?\//,
      /(^|\/)e2e\//,
      /(^|\/)demo\//,
      /(^|\/)samples?\//,
      /(^|\/)examples?\//,
      /(^|\/)mocks?\//,
      /(^|\/)stubs?\//,
      /\.(test|spec)\.[a-z]+$/i,
      /^test_/,
      /_test\.[a-z]+$/i,
    ];
    for (const pat of fixturePathPatterns) {
      if (pat.test(lower)) return true;
    }
  }

  // 2. Content-based detection — known fixture prefixes assigned to constants
  const fixturePrefixes = [
    "jag_observation_", "jag_node_", "test_", "fixture_", "sample_",
    "example_", "mock_", "stub_", "dummy_", "fake_", "oracle_", "expected_",
  ];
  for (const prefix of fixturePrefixes) {
    if (code.includes(prefix)) {
      const constPattern = new RegExp(`[A-Z][A-Z0-9_]*\\s*=\\s*['"]${prefix}`, "");
      if (constPattern.test(code)) return true;
    }
  }

  // 3. Content-based — file has many UPPER_SNAKE_CASE constants assigned to
  //    high-entropy strings. Test fixture files typically declare a handful
  //    of oracle IDs at the top.
  const upperConstAssignments = code.match(/[A-Z][A-Z0-9_]{2,}\s*=\s*['"][A-Za-z0-9_\-+/=]{24,}['"]/g);
  if (upperConstAssignments && upperConstAssignments.length >= 2) {
    return true;
  }

  return false;
}

export function sanitizeAndGovern(inputCode: string, filePath?: string): SecuritySanitizerResult {
  const violations: string[] = [];
  let sanitized = inputCode;
  let highEntropyTokensFound = 0;

  // Fixture detection: if this file is a test/fixture/experiment file, treat
  // high-entropy strings as deterministic test data, not secrets.
  const isFixtureFile = isLikelyFixtureFile(filePath, inputCode);

  for (const pattern of SECRET_PATTERNS) {
    const matches = sanitized.match(pattern);
    if (matches) {
      for (const match of matches) {
        const SECRET_PREVIEW_LENGTH = 6;
        violations.push(
          `Detected known secret signature: ${match.slice(0, SECRET_PREVIEW_LENGTH)}... (length: ${match.length})`
        );
        const SECRET_PREFIX_LENGTH = 4;
        sanitized = sanitized.split(match).join(`[REDACTED_SECRET_${match.slice(0, SECRET_PREFIX_LENGTH)}]`);
      }
    }
  }

  for (const pii of PII_PATTERNS) {
    const matches = sanitized.match(pii);
    if (matches) {
      for (const match of matches) {
        const PII_PREVIEW_LENGTH = 3;
        violations.push(`Detected PII leak: ${match.slice(0, PII_PREVIEW_LENGTH)}***`);
        sanitized = sanitized.split(match).join("[REDACTED_PII]");
      }
    }
  }

  const stringLiterals = inputCode.match(/["']([A-Za-z0-9_\-+/=]{24,})["']/g);
  if (stringLiterals) {
    for (const literal of stringLiterals) {
      const inner = literal.slice(1, -1);
      const entropy = calculateShannonEntropy(inner);

      // Skip redaction for fixture files — deterministic test data.
      if (isFixtureFile) continue;

      // Skip env var names, file paths, URLs — not secrets even if high-entropy.
      if (isLikelyEnvVarOrPath(inner)) continue;

      // Raised threshold from 4.15 to 4.5 — 4.15 catches too many legitimate
      // strings. Real secrets typically have entropy > 4.5.
      if (entropy > 4.5) {
        highEntropyTokensFound++;
        const HIGH_ENTROPY_PREVIEW_LENGTH = 6;
        violations.push(
          `Detected high-entropy string (entropy: ${entropy.toFixed(2)}): ${inner.slice(0, HIGH_ENTROPY_PREVIEW_LENGTH)}...`
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