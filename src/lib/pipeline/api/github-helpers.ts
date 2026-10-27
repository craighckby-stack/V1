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
  const candidate = (clientToken ?? (process.env?.GITHUB_TOKEN ?? "")).trim();
  
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

  const trimmedToken = token.trim();
  
  if (typeof token !== 'string' || !trimmedToken) {
    throw new Error(`Invalid token provided: must be a non-empty string. Received: ${token}`);
  }

  if (isInvalidToken(token)) {
    throw new Error(`Invalid token provided: contains invalid patterns. Received: ${token}`);
  }

  if (trimmedToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`Invalid token provided: must be at least ${MIN_TOKEN_LENGTH} characters long. Received: ${trimmedToken.length} characters`);
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: API_ACCEPT_HEADER,
  };
  
  headers["Authorization"] = `Bearer ${trimmedToken}`;
  
  return headers;
}