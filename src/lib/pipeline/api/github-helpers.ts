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

/**
 * Resolve the token to use for a GitHub API call (audit 3): ONLY the
 * client-supplied token is considered. The old
 * `clientToken ?? process.env.GITHUB_TOKEN` fallback would have turned
 * /api/github/commit-file and batch-commit into anonymous write-proxies
 * riding the owner's credential the moment GITHUB_TOKEN was ever exported
 * in the server environment. It is unset today, so runtime behavior is
 * identical — the latent hole is closed.
 */
export function getUsableToken(clientToken?: string): string | null {
  if (typeof clientToken !== 'string') {
    return null;
  }
  
  const candidate = clientToken.trim();
  
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

  if (typeof token !== 'string') {
    throw new Error(`Invalid token provided: expected string but received ${typeof token}`);
  }

  const trimmedToken = token.trim();

  if (trimmedToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`Invalid token provided: must be at least ${MIN_TOKEN_LENGTH} characters long. Received: ${trimmedToken.length} characters`);
  }

  if (isInvalidToken(trimmedToken)) {
    throw new Error(`Invalid token provided: token contains invalid prefixes or values`);
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: API_ACCEPT_HEADER,
  };
  
  headers["Authorization"] = `Bearer ${trimmedToken}`;
  
  return headers;
}