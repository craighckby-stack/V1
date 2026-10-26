/**
 * Shared helpers for GitHub-related API routes.
 *
 * Used by /api/github/* routes to normalize token resolution and headers.
 * Server-only — never import from client components.
 */

const MIN_TOKEN_LENGTH = 8;
const USER_AGENT = "Architecture-Helper-Pipeline";
const API_ACCEPT_HEADER = "application/vnd.github.v3+json";

const INVALID_TOKEN_PREFIXES = ["MY_"] as const;
const INVALID_TOKEN_VALUES = ["undefined", "[REDACTED]"] as const;

type InvalidTokenPrefix = typeof INVALID_TOKEN_PREFIXES[number];
type InvalidTokenValue = typeof INVALID_TOKEN_VALUES[number];

/**
 * Resolve a usable GitHub token from a client-supplied value, falling back
 * to the GITHUB_TOKEN environment variable. Rejects obviously invalid
 * placeholders (MY_*, "undefined", "[REDACTED]", or shorter than 8 chars).
 */
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

function isInvalidToken(token: string): boolean {
  return (
    INVALID_TOKEN_PREFIXES.some(prefix => token.startsWith(prefix)) ||
    INVALID_TOKEN_VALUES.includes(token as InvalidTokenValue)
  );
}

/**
 * Build the standard GitHub API headers. Token is optional — when omitted,
 * the request is anonymous (subject to GitHub's lower rate limits).
 */
export function githubHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: API_ACCEPT_HEADER,
  };
  
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  
  return headers;
}