const MIN_TOKEN_LENGTH = 8;
const USER_AGENT = "Architecture-Helper-Pipeline";
const API_ACCEPT_HEADER = "application/vnd.github.v3+json";

const INVALID_TOKEN_PREFIXES = ["MY_"] as const;
const INVALID_TOKEN_VALUES = ["undefined", "[REDACTED]"] as const;

type InvalidTokenPrefix = typeof INVALID_TOKEN_PREFIXES[number];
type InvalidTokenValue = typeof INVALID_TOKEN_VALUES[number];

function isInvalidToken(token: string): boolean {
  if (typeof token !== 'string' || !token) {
    return true;
  }
  
  return (
    INVALID_TOKEN_PREFIXES.some(prefix => token.startsWith(prefix)) ||
    INVALID_TOKEN_VALUES.some(value => token.includes(value))
  );
}

export function getUsableToken(clientToken?: string): string | null {
  // Handle undefined environment variables more safely
  const envToken = process.env?.GITHUB_TOKEN ?? "";
  const candidate = (clientToken ?? envToken).trim();
  
  if (
    !candidate ||
    candidate.length < MIN_TOKEN_LENGTH ||
    isInvalidToken(candidate)
  ) {
    return null;
  }
  
  return candidate;
}

export function githubHeaders(token: string | null): Record<string, string> {
  if (token === null) {
    return {
      "User-Agent": USER_AGENT,
      Accept: API_ACCEPT_HEADER,
    };
  }

  // Validate token is actually a string
  if (typeof token !== 'string') {
    throw new Error(`Invalid token provided: must be a string, received ${typeof token}. Please check your configuration.`);
  }

  // Trim the token before validation
  const trimmedToken = token.trim();

  if (!trimmedToken) {
    throw new Error(`Invalid token provided: must be a non-empty string after trimming. Please check your token configuration.`);
  }

  // Additional validation to ensure token meets requirements
  if (trimmedToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`Invalid token provided: token length must be at least ${MIN_TOKEN_LENGTH} characters. Please check your token configuration.`);
  }

  if (isInvalidToken(trimmedToken)) {
    throw new Error(`Invalid token provided: token contains invalid patterns. Please check your token configuration.`);
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: API_ACCEPT_HEADER,
  };
  
  headers["Authorization"] = `Bearer ${trimmedToken}`;
  
  return headers;
}