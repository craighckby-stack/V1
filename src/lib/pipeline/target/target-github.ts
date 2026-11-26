/**
 * Target GitHub — lib-level GitHub API helpers for EXTERNAL target repos.
 *
 * Server-only. The existing /api/github/* routes inline their API calls
 * (they were built for the manual runner UI); target mode needs the same
 * primitives callable from the pipeline lib, so this module owns them:
 *   - repo info + recursive tree listing
 *   - file fetch (Contents API, base64 → utf-8)
 *   - branch creation from a base ref (same refs pattern as loop-runtime)
 *   - single-file commit via the Contents PUT (same shape as the
 *     commit-file route, including the "fetch blob sha at the branch
 *     first" TOCTOU-safe sequence)
 *   - branch listing + loop-t-NN numbering
 *   - a pure unified-diff builder for the secret-scan gate
 *
 * Token handling: the token is only ever sent as an Authorization header
 * — never in a URL, a log line, or an error message. Error bodies from
 * GitHub are truncated and never echoed back with headers.
 */

const GH_API = "https://api.github.com";
const USER_AGENT = "LOOP-target-mode";

function ghHeaders(token: string | null, accept = "application/vnd.github.v3+json"): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "User-Agent": USER_AGENT,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Truncate + sanitize a GitHub error body into a safe message. */
function ghError(status: number, body: unknown, fallback: string): string {
  let msg: string;
  if (typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string") {
    msg = (body as { message: string }).message;
  } else {
    msg = fallback;
  }
  // Ensure msg is treated as string before slicing, though fallback should guarantee it.
  const safeMsg = String(msg);
  return `GitHub API ${status}: ${safeMsg.slice(0, 200)}`;
}

export interface TargetTreeFile {
  path: string;
  size: number;
  sha: string;
}

export interface TargetTreeInfo {
  files: TargetTreeFile[];
  defaultBranch: string;
  truncated: boolean;
}

/** GET /repos/{repo} → default branch (null on 404/network failure). */
export async function getRepoDefaultBranch(
  repo: string,
  token: string | null
): Promise<string | null> {
  try {
    const res = await fetch(`${GH_API}/repos/${repo}`, { headers: ghHeaders(token) });
    if (!res.ok) return null;
    const data = (await res.json()) as { default_branch?: string };
    return data.default_branch ?? null;
  } catch {
    return null;
  }
}

/** Cap on tree entries we consider (huge monorepos → honest truncation). */
const MAX_TREE_FILES = 400;

/** Directories to skip entirely when `skipMetaDirs` is true — these are
 *  meta/docs/config directories that can have thousands of files (e.g.
 *  deepseek-ai/deepseek-harness has 2000+ .agents/notes/ markdown files)
 *  and would fill the tree cap before any actual source file appears. */
const META_DIRS_TO_SKIP = new Set([
  ".agents", ".github", ".vscode", ".idea", ".husky", ".git",
  "docs", "doc", "documentation", "wiki",
  "node_modules", "dist", "build", "target", "vendor",
]);

/** GET /git/trees/{ref}?recursive=1 → candidate blob list.
 *  `maxTreeFiles` (optional) overrides the 400-file cap — auto-fork
 *  uses 2000 (it has the sealed PAT + needs to see past large docs/
 *  meta directories to find actual source files in big repos).
 *  `skipMetaDirs` (optional) skips meta/docs directories (.agents/,
 *  .github/, docs/, etc.) BEFORE counting toward the cap — so the cap
 *  is spent on actual source files, not 2000 markdown docs. Auto-fork
 *  passes true (it wants source); the gauntlet passes false (it wants
 *  the full tree for its own picker). */
export async function listTargetTree(
  repo: string,
  ref: string,
  token: string | null,
  maxTreeFiles?: number,
  skipMetaDirs?: boolean,
): Promise<{ ok: true; tree: TargetTreeInfo } | { ok: false; error: string }> {
  const cap = maxTreeFiles ?? MAX_TREE_FILES;
  try {
    const res = await fetch(
      `${GH_API}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { headers: ghHeaders(token) }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, error: ghError(res.status, body, "could not list tree") };
    }
    const data = (await res.json()) as {
      tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }>;
      truncated?: boolean;
    };
    const files: TargetTreeFile[] = [];
    for (const entry of data.tree ?? []) {
      if (entry.type !== "blob" || !entry.path || !entry.sha) continue;
      // Skip meta/docs directories before the cap — so 2000+ .agents/
      // notes/ markdown files don't fill the tree before any source
      // file appears. The cap is spent on actual source files.
      if (skipMetaDirs) {
        const segments = entry.path.split("/");
        if (segments.some((s) => META_DIRS_TO_SKIP.has(s))) continue;
      }
      files.push({ path: entry.path, size: entry.size ?? 0, sha: entry.sha });
      if (files.length >= cap) break;
    }
    return {
      ok: true,
      tree: {
        files,
        defaultBranch: "",
        truncated: Boolean(data.truncated) || (data.tree?.length ?? 0) >= cap,
      },
    };
  } catch (err) {
    return { ok: false, error: `Tree listing failed: ${(err as Error).message}` };
  }
}

export interface FetchedTargetFile {
  content: string;
  /** Blob sha at the fetched ref — needed for the Contents PUT. */
  blobSha: string;
  size: number;
}

/** GET /contents/{path}?ref={ref} → {content, blobSha}. Returns ok:false
 *  (not null) so "missing" and "broken" are distinguishable to the caller. */
export async function fetchTargetFile(
  repo: string,
  path: string,
  ref: string,
  token: string | null
): Promise<{ ok: true; file: FetchedTargetFile } | { ok: false; status: number; error: string }> {
  try {
    const url = `${GH_API}/repos/${repo}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return {
        ok: false,
        status: res.status,
        error: ghError(res.status, body, "could not fetch file"),
      };
    }
    const data = (await res.json()) as {
      content?: string;
      encoding?: string;
      sha?: string;
      size?: number;
    };
    if (data.encoding !== "base64" || typeof data.content !== "string") {
      return { ok: false, status: res.status, error: "unexpected Contents API encoding" };
    }
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return {
      ok: true,
      file: { content, blobSha: data.sha ?? "", size: data.size ?? content.length },
    };
  } catch (err) {
    return { ok: false, status: 0, error: `Fetch failed: ${(err as Error).message}` };
  }
}

/**
 * Ensure branch exists (create from baseRef's HEAD if missing). Same
 * fail-open philosophy as the commit-file route's ensureBranch: an
 * unexpected status here returns ok:false with the reason, and the
 * caller decides to abort — the commit PUT is never attempted blind.
 */
export async function ensureTargetBranch(
  repo: string,
  branch: string,
  baseRef: string,
  token: string | null
): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers = ghHeaders(token, "application/vnd.github.v3+json");
    const refRes = await fetch(
      `${GH_API}/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { headers }
    );
    if (refRes.ok) return { ok: true };
    if (refRes.status !== 404) {
      const body = await refRes.json().catch(() => null);
      return { ok: false, error: ghError(refRes.status, body, "branch check failed") };
    }
    const baseRes = await fetch(
      `${GH_API}/repos/${repo}/git/ref/heads/${encodeURIComponent(baseRef)}`,
      { headers }
    );
    if (!baseRes.ok) {
      const body = await baseRes.json().catch(() => null);
      return { ok: false, error: ghError(baseRes.status, body, `base branch ${baseRef} not resolvable`) };
    }
    const baseData = (await baseRes.json()) as { object?: { sha?: string } };
    const baseSha = baseData.object?.sha;
    if (!baseSha) return { ok: false, error: `base branch ${baseRef} has no HEAD sha` };
    const createRes = await fetch(`${GH_API}/repos/${repo}/git/refs`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    });
    if (createRes.ok) return { ok: true };
    const body = await createRes.json().catch(() => null);
    return { ok: false, error: ghError(createRes.status, body, `could not create branch ${branch}`) };
  } catch (err) {
    return { ok: false, error: `Branch ensure failed: ${(err as Error).message}` };
  }
}

export interface CommitOutcome {
  ok: boolean;
  commitSha?: string;
  error?: string;
}

/**
 * Commit one file to a branch via the Contents PUT. Fetches the blob sha
 * AT THE TARGET BRANCH first (the branch was just created from baseRef,
 * but re-resolving at the branch is the TOCTOU-safe sequence the
 * commit-file route uses).
 */
export async function commitTargetFile(opts: {
  repo: string;
  path: string;
  branch: string;
  content: string;
  message: string;
  token: string | null;
}): Promise<CommitOutcome> {
  const { repo, path, branch, content, message, token } = opts;
  try {
    const headers = ghHeaders(token, "application/vnd.github.v3+json");
    const url = `${GH_API}/repos/${repo}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;

    // Blob sha at the target branch (404 → file does not exist there → null sha = create).
    let sha: string | null = null;
    const existingRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
    
    if (existingRes.ok) {
      const data = await existingRes.json();
      sha = (data as { sha?: string }).sha ?? null;
    } else if (existingRes.status === 404) {
      // File does not exist, sha remains null (create operation)
    } else {
      // Handle other HTTP errors (4xx/5xx)
      const body = await existingRes.json().catch(() => null);
      return { ok: false, error: ghError(existingRes.status, body, `Failed to resolve existing file at ${path} on branch ${branch}`) };
    }

    const putRes = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf-8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    
    if (!putRes.ok) {
      const body = await putRes.json().catch(() => null);
      return { ok: false, error: ghError(putRes.status, body, `Contents PUT failed for ${path} on branch ${branch}`) };
    }
    
    const data = await putRes.json();
    return { ok: true, commitSha: (data as { commit?: { sha?: string } }).commit?.sha };
  } catch (err) {
    // Catch network errors, JSON parsing errors, etc.
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Commit failed due to runtime error: ${errorMessage}` };
  }
}

/** GET /branches (up to 3 pages × 100) → branch names. */
export async function listTargetBranches(
  repo: string,
  token: string | null
): Promise<string[]> {
  const names: string[] = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(
        `${GH_API}/repos/${repo}/branches?per_page=100&page=${page}`,
        { headers: ghHeaders(token) }
      );
      if (!res.ok) break;
      const data = (await res.json()) as Array<{ name?: string }>;
      for (const b of data) if (b.name) names.push(b.name);
      if (data.length < 100) break;
    }
  } catch {
    /* network hiccup — return what we have; numbering falls back to 1 */
  }
  return names;
}

/** Next free loop-t-NN number given existing branch names. Pure. */
export function nextTargetBranchNumber(branches: string[]): number {
  let max = 0;
  for (const name of branches) {
    const m = name.match(/^loop-t-(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

// ── Unified diff (pure) ────────────────────────────────────────────────
// The secret-scan gate consumes a unified diff (scanDiff(diffText)). Git
// is not available for remote files, so target mode builds the diff
// itself: trim common prefix/suffix, LCS the remainder (with a size
// guard that falls back to whole-remainder replace), emit standard
// hunks with 3 lines of context.

type DiffOp = { op: " " | "-" | "+"; text: string };

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  // Size guard: ~10M-cell DP is too slow — fall back to a replace hunk.
  if (a.length * b.length > 10_000_000) {
    return [
      ...a.map((t) => ({ op: "-" as const, text: t })),
      ...b.map((t) => ({ op: "+" as const, text: t })),
    ];
  }
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[i..], b[j..]
  const dp = new Int32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * (n + 1) + j] =
        a[i] === b[j]
          ? dp[(i + 1) * (n + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + j + 1]) {
      ops.push({ op: "-", text: a[i] });
      i++;
    } else {
      ops.push({ op: "+", text: b[j] });
      j++;
    }
  }
  while (i < m) ops.push({ op: "-", text: a[i++] });
  while (j < n) ops.push({ op: "+", text: b[j++] });
  return ops;
}

const CONTEXT = 3;

/**
 * Build a unified diff for (original → proposed). Pure. Capped at
 * maxDiffLines body lines with an explicit truncation marker so the
 * secret-scan gate (and humans) see an honest, bounded artifact.
 */
export function unifiedDiff(
  relPath: string,
  original: string,
  proposed: string,
  maxDiffLines = 400
): string {
  const aLines = original.split("\n");
  const bLines = proposed.split("\n");

  // Trim common prefix/suffix so the DP stays small on localized edits.
  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) start++;
  let endA = aLines.length;
  let endB = bLines.length;
  while (endA > start && endB > start && aLines[endA - 1] === bLines[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return ""; // no changes at all
  const midA = aLines.slice(start, endA);
  const midB = bLines.slice(start, endB);
  const ops: DiffOp[] = [
    ...aLines.slice(0, start).map((t) => ({ op: " " as const, text: t })),
    ...(start < endA || start < endB ? lcsDiff(midA, midB) : []),
    ...aLines.slice(endA).map((t) => ({ op: " " as const, text: t })),
  ];

  // Precompute the original/new file line number for EVERY op — hunk
  // headers must count - and + lines independently once the sequences
  // diverge (slice-index arithmetic alone drifts after the first hunk).
  const aNum: number[] = new Array(ops.length);
  const bNum: number[] = new Array(ops.length);
  let aLine = 1;
  let bLine = 1;
  for (let k = 0; k < ops.length; k++) {
    aNum[k] = aLine;
    bNum[k] = bLine;
    if (ops[k].op !== "+") aLine++;
    if (ops[k].op !== "-") bLine++;
  }

  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];

  let bodyLines = 0;
  let i = 0;
  while (i < ops.length) {
    // Find the next change.
    while (i < ops.length && ops[i].op === " ") i++;
    if (i >= ops.length) break;
    const hunkStart = Math.max(0, i - CONTEXT);

    // Extend through the change cluster (context gaps <= CONTEXT merge
    // clusters into one hunk), then add up to CONTEXT trailing context.
    let j = i;
    let runCtx = 0;
    let lastChangeEnd = i;
    while (j < ops.length) {
      if (ops[j].op !== " ") {
        runCtx = 0;
        lastChangeEnd = j + 1;
        j++;
      } else {
        runCtx++;
        j++;
        if (runCtx > CONTEXT) break;
      }
    }
    const hunkEnd = Math.min(ops.length, lastChangeEnd + CONTEXT);
    const slice = ops.slice(hunkStart, hunkEnd);

    let aCount = 0;
    let bCount = 0;
    for (const o of slice) {
      if (o.op !== "+") aCount++;
      if (o.op !== "-") bCount++;
    }
    // Standard convention: zero-count sides point at the line BEFORE.
    let aFrom = aNum[hunkStart];
    let bFrom = bNum[hunkStart];
    if (aCount === 0) aFrom = Math.max(0, aFrom - 1);
    if (bCount === 0) bFrom = Math.max(0, bFrom - 1);
    out.push(`@@ -${aFrom},${aCount} +${bFrom},${bCount} @@`);

    let hitCap = false;
    for (const o of slice) {
      if (++bodyLines > maxDiffLines) {
        hitCap = true;
        break;
      }
      out.push(`${o.op}${o.text}`);
    }
    if (hitCap) {
      out.push("[diff truncated by target-mode]");
      break;
    }
    i = hunkEnd;
  }
  return out.join("\n");
}
