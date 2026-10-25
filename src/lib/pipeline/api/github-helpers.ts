/**
 * Shared helpers for GitHub-related API routes.
 *
 * Used by /api/github/* routes to normalize token resolution and headers.
 * Server-only — never import from client components.
 */

/**
 * Resolve a usable GitHub token from a client-supplied value, falling back
 * to the GITHUB_TOKEN environment variable. Rejects obviously invalid
 * placeholders (MY_*, "undefined", "[REDACTED]", or shorter than 8 chars).
 */
export function getUsableToken(clientToken?: string): string | null {
  const candidate = (clientToken ?? process.env.GITHUB_TOKEN ?? "").trim();
  if (
    !candidate ||
    candidate.startsWith("MY_") ||
    candidate === "undefined" ||
    candidate === "[REDACTED]" ||
    candidate.length < 8
  ) {
    return null;
  }
  return candidate;
}

/**
 * Build the standard GitHub API headers. Token is optional — when omitted,
 * the request is anonymous (subject to GitHub's lower rate limits).
 */
export function githubHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "Architecture-Helper-Pipeline",
    Accept: "application/vnd.github.v3+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}
