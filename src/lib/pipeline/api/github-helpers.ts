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
  const candidate = (clientToken ?? process.env.GITHUB_TOKEN ?? "").trim();
  
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
  if (token !== null && (typeof token !== 'string' || !token.trim())) {
    throw new Error("Invalid token provided: must be a non-empty string or null");
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: API_ACCEPT_HEADER,
  };
  
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  
  return headers;
}