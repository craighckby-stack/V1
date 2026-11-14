// AUDIT 3 (B7 dedupe): the local Shannon-entropy copy was removed —
// core/secret-scan.ts has the identical implementation (verified
// semantically identical: char-frequency → bits/char). One copy, one
// place to fix. The THRESHOLDS stay per-module on purpose: the sanitizer
// (layer 1, LLM-output redaction) and secret-scan (push-path backstop)
// tune their bars for different false-positive budgets.
import { calculateShannonEntropy } from "../core/secret-scan";

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

const HIGH_ENTROPY_THRESHOLD = 4.5;
/** AUDIT 3 (B7): pure-hex literals use secret-scan's stricter bar. The
 *  GENERAL threshold was raised 4.15 → 4.5 because legitimate
 *  alphanumeric utility strings (ids, slugs, tokens) live in the 4.0–4.5
 *  band and redacting them corrupts otherwise-good mutations. A pure-hex
 *  literal in that band is almost never a utility string — it's
 *  hash/key material — and core/secret-scan.ts already blocks hex
 *  assignments at entropy >= 4.0 on the push path. The sanitizer is the
 *  FIRST layer: hex secrets now die here at the same bar as the backstop
 *  instead of burning a full cycle to fail later at the push gate. */
const HEX_ENTROPY_THRESHOLD = 4.0;
const MIN_UNIQUE_CHARS_FOR_UTILITY_STRING = 20;
const MIN_UNIQUE_DIGITS_FOR_UTILITY_STRING = 8;
const MIN_UNIQUE_ALPHANUMERIC_FOR_UTILITY_STRING = 22;
const MAX_ALPHANUMERIC_UTILITY_LENGTH = 36;
const MIN_UPPER_CONST_ASSIGNMENTS_FOR_FIXTURE = 2;

const ENV_VAR_PREFIXES = [
  "DYLD_", "LD_", "PATH=", "HOME=", "USER=", "SHELL=", "TMPDIR=",
  "LANG=", "LC_", "TERM=", "DISPLAY=", "EDITOR=", "VISUAL=",
  "NODE_", "NPM_", "BUN_", "GITHUB_", "GIT_",
] as const;

const FIXTURE_PATH_PATTERNS = [
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
] as const;

const FIXTURE_CONTENT_PREFIXES = [
  "jag_observation_", "jag_node_", "test_", "fixture_", "sample_",
  "example_", "mock_", "stub_", "dummy_", "fake_", "oracle_", "expected_",
] as const;

function isLikelyEnvVarOrPath(s: string): boolean {
  // 1. ENV_VAR=value pattern (e.g. DYLD_FRAMEWORK_PATH=/override)
  if (/^[A-Z][A-Z0-9_]*=/.test(s)) return true;

  // 2. Known env var prefixes
  if (ENV_VAR_PREFIXES.some(prefix => s.startsWith(prefix))) return true;

  // 3. File path (starts with / or contains / and has a file extension)
  if (s.startsWith("/") || /^[a-z]:\//i.test(s)) return true;
  if (s.includes("/") && /\.\w{1,5}$/.test(s)) return true;

  // 4. URL
  if (s.startsWith("http://") || s.startsWith("https://")) return true;

  // 5. Non-secret utility strings — alphabets, digit sequences, etc.
  const unique = new Set(s).size;
  if (unique === s.length && s.length >= MIN_UNIQUE_CHARS_FOR_UTILITY_STRING) {
    // All characters are unique AND length >= 20 — could be alphabet or similar.
    // Real secrets are NOT typically all-unique (they have repetition due to base64).
    // Check if it's a known non-secret pattern:
    if (/^[a-z]+$/i.test(s) && unique >= MIN_UNIQUE_CHARS_FOR_UTILITY_STRING) return true; // alphabet
    if (/^[0-9]+$/i.test(s) && unique >= MIN_UNIQUE_DIGITS_FOR_UTILITY_STRING) return true;  // digit sequence
    if (/^[a-z0-9]+$/i.test(s) && unique >= MIN_UNIQUE_ALPHANUMERIC_FOR_UTILITY_STRING && s.length <= MAX_ALPHANUMERIC_UTILITY_LENGTH) return true; // alphanumeric utility
  }

  return false;
}

function isLikelyFixtureFile(filePath: string | null | undefined, code: string): boolean {
  // 1. Path-based detection
  if (filePath) {
    const lower = filePath.toLowerCase();
    if (FIXTURE_PATH_PATTERNS.some(pat => pat.test(lower))) return true;
  }

  // 2. Content-based detection — known fixture prefixes assigned to constants
  for (const prefix of FIXTURE_CONTENT_PREFIXES) {
    if (code.includes(prefix)) {
      const constPattern = new RegExp(`[A-Z][A-Z0-9_]*\\s*=\\s*['"]${prefix}`, "");
      if (constPattern.test(code)) return true;
    }
  }

  // 3. Content-based — file has many UPPER_SNAKE_CASE constants assigned to
  //    high-entropy strings. Test fixture files typically declare a handful
  //    of oracle IDs at the top.
  const upperConstAssignments = code.match(/[A-Z][A-Z0-9_]{2,}\s*=\s*['"][A-Za-z0-9_\-+/=]{24,}['"]/g);
  if (upperConstAssignments && upperConstAssignments.length >= MIN_UPPER_CONST_ASSIGNMENTS_FOR_FIXTURE) {
    return true;
  }

  return false;
}

export function sanitizeAndGovern(inputCode: string, filePath?: string): SecuritySanitizerResult {
  // Input validation
  if (typeof inputCode !== 'string' || inputCode.length === 0) {
    return {
      clean: false,
      sanitizedCode: '',
      errorClass: "SECRET_LEAKAGE",
      violations: ["Input code must be a non-empty string"],
      highEntropyTokensFound: 0
    };
  }

  // Validate filePath if provided
  if (filePath !== undefined && typeof filePath !== 'string') {
    return {
      clean: false,
      sanitizedCode: inputCode,
      errorClass: "SECRET_LEAKAGE",
      violations: ["filePath must be a string if provided"],
      highEntropyTokensFound: 0
    };
  }

  const violations: string[] = [];
  let sanitized = inputCode;
  let highEntropyTokensFound = 0;
  const MAX_ITERATIONS = 1000; // Prevent potential infinite loops

  // Fixture detection: if this file is a test/fixture/experiment file, treat
  // high-entropy strings as deterministic test data, not secrets.
  const isFixtureFile = isLikelyFixtureFile(filePath, inputCode);

  try {
    // Check for known secret patterns
    for (const pattern of SECRET_PATTERNS) {
      const matches = sanitized.match(pattern);
      if (matches) {
        for (const match of matches) {
          violations.push(
            `Detected known secret signature: ${match.slice(0, 6)}... (length: ${match.length})`
          );
          sanitized = sanitized.replace(match, `[REDACTED_SECRET_${match.slice(0, 4)}]`);
        }
      }
    }

    // Check for PII patterns
    for (const pii of PII_PATTERNS) {
      const matches = sanitized.match(pii);
      if (matches) {
        for (const match of matches) {
          violations.push(`Detected PII leak: ${match.slice(0, 3)}***`);
          sanitized = sanitized.replace(match, "[REDACTED_PII]");
        }
      }
    }

    // Check for high entropy strings
    const stringLiterals = inputCode.match(/["']([A-Za-z0-9_\-+/=]{24,})["']/g);
    if (stringLiterals) {
      let iterations = 0;
      for (const literal of stringLiterals) {
        iterations++;
        if (iterations > MAX_ITERATIONS) {
          violations.push("High entropy check exceeded maximum iterations - potential infinite loop prevented");
          break;
        }

        if (!literal) continue; // Skip null/undefined literals

        const inner = literal.slice(1, -1);
        const entropy = calculateShannonEntropy(inner);

        // Skip redaction for fixture files — deterministic test data.
        if (isFixtureFile) continue;

        // Skip env var names, file paths, URLs — not secrets even if high-entropy.
        if (isLikelyEnvVarOrPath(inner)) continue;

        // General literals: the 4.5 bar (raised from 4.15 — lower values
        // redact legitimate utility strings and corrupt good mutations).
        // Pure-hex literals: the strict 4.0 bar, mirroring secret-scan.
        const isPureHex = /^[0-9a-fA-F]+$/.test(inner);
        if (isPureHex ? entropy >= HEX_ENTROPY_THRESHOLD : entropy > HIGH_ENTROPY_THRESHOLD) {
          highEntropyTokensFound++;
          violations.push(
            `Detected high-entropy string (entropy: ${entropy.toFixed(2)}): ${inner.slice(0, 6)}...`
          );
          sanitized = sanitized.replace(literal, `"[REDACTED_HIGH_ENTROPY_KEY]"`);
        }
      }
    }
  } catch (error) {
    violations.push(`Error during sanitization: ${error instanceof Error ? error.message : String(error)}`);
    // FAIL CLOSED: returning the unsanitized inputCode on a sanitizer
    // error (the old behavior) lets a secret in the input slip through
    // unredacted — a transient parse failure silently downgrades to
    // "trust the LLM output as-is". Instead return a sentinel that
    // downstream stages must treat as a hard rejection. The clean:false
    // flag already does that for the gate-runner; the sentinel makes the
    // raw code unusable too so no copy-paste path can resurrect it.
    return {
      clean: false,
      sanitizedCode: "// SANITIZER_FAILED — original code redacted as a precaution; see violations[] for the cause",
      errorClass: "AST_PARSE",
      violations,
      highEntropyTokensFound
    };
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