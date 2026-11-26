import type {
  BranchScope,
  CiState,
  GitHubUser,
  RawCommit,
  RepoSummary,
  SiphonedEngine,
} from '../types/git';
import {
  buildUnredactedEngineRecord,
  type GitTreeNode,
  selectEngineTreePaths,
} from './engineHarvester';
import { computeGitHubCooldown, fetchWithTimeout, sleepWithAbort } from './rateLimiter';
import { matchesRepoFilter, parseSources, TOOL_TAG } from './sources';

const GITHUB_API = 'https://api.github.com';
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

export interface GitHubResponse<T> {
  data: T;
  headers: Headers;
}

type LogCallback = (msg: string, level?: 'info' | 'warn' | 'success') => void;
type WaitCallback = (reason: string, waitMs: number) => void;

async function ghRequest<T>(
  pathOrUrl: string,
  token: string,
  init: RequestInit = {},
  options: { retries?: number; onLog?: LogCallback; onWait?: WaitCallback; skipCooldown?: boolean } = {}
): Promise<GitHubResponse<T>> {
  const retries = options.retries ?? 2;
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GITHUB_API}${pathOrUrl}`;
  const trimmedToken = token.trim();
  const isAuthenticated = Boolean(trimmedToken);
  const signal = init.signal ?? undefined;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          ...(trimmedToken ? { Authorization: `Bearer ${trimmedToken}` } : {}),
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.headers || {}),
        },
      },
      GITHUB_REQUEST_TIMEOUT_MS
    );
  } catch (networkErr) {
    const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
    if (signal?.aborted || msg === 'Operation cancelled.') {
      throw networkErr;
    }
    if (retries > 0) {
      const waitMsg = `GitHub request interrupted (${msg}) — retrying in 2.5s...`;
      options.onLog?.(waitMsg, 'warn');
      options.onWait?.(waitMsg, 2500);
      await sleepWithAbort(2500, signal);
      return ghRequest<T>(pathOrUrl, token, init, { ...options, retries: retries - 1 });
    }
    throw networkErr;
  }

  const decision = computeGitHubCooldown({
    status: res.status,
    remainingHeader: res.headers.get('X-RateLimit-Remaining'),
    resetHeader: res.headers.get('X-RateLimit-Reset'),
    retryAfterHeader: res.headers.get('Retry-After'),
    isAuthenticated,
  });

  if ((res.status === 403 || res.status === 429) && retries > 0) {
    if (decision.fatalError) {
      throw new Error(decision.fatalError);
    }
    if (decision.shouldRetry && decision.waitMs > 0) {
      if (decision.reason) {
        options.onLog?.(decision.reason, 'warn');
        options.onWait?.(decision.reason, decision.waitMs);
      }
      await sleepWithAbort(decision.waitMs, signal);
      return ghRequest<T>(pathOrUrl, token, init, { ...options, retries: retries - 1 });
    }
  }

  if (!res.ok) {
    let msg = `GitHub API error (${res.status})`;
    try {
      const errBody = (await res.json()) as { message?: string };
      if (errBody?.message) msg = `${errBody.message} (HTTP ${res.status})`;
    } catch {
      // ignore non-json body
    }
    throw new Error(msg);
  }

  // Apply polite pacing cooldown after successful requests so pagination never bursts secondary limits
  if (!options.skipCooldown && decision.waitMs > 0) {
    if (decision.reason) {
      options.onLog?.(decision.reason, 'warn');
      if (decision.waitMs >= 1500) {
        options.onWait?.(decision.reason, decision.waitMs);
      }
    }
    await sleepWithAbort(decision.waitMs, signal);
  }

  if (res.status === 204) {
    return { data: undefined as T, headers: res.headers };
  }

  const data = (await res.json()) as T;
  return { data, headers: res.headers };
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return null;
}

export async function verifyGitHubToken(token: string): Promise<{
  user: GitHubUser;
  scopes: string | null;
}> {
  const { data: user, headers } = await ghRequest<GitHubUser>(
    '/user',
    token,
    {},
    { skipCooldown: true }
  );
  if (!user || !user.login) {
    throw new Error('GitHub /user response did not include a valid account login.');
  }
  return {
    user,
    scopes: headers.get('X-OAuth-Scopes'),
  };
}

interface RawGhRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  fork: boolean;
  default_branch: string;
  html_url?: string;
}

function toRepoSummary(r: RawGhRepo): RepoSummary {
  return {
    full_name: r.full_name,
    name: r.name,
    owner: r.owner.login,
    private: r.private,
    fork: r.fork,
    default_branch: r.default_branch || 'main',
    html_url: r.html_url,
  };
}

export interface DiscoverOptions {
  includeMine: boolean;
  includePrivate: boolean;
  includeForks: boolean;
  sources: string;
  repoFilter: string;
  signal?: AbortSignal;
}

export async function discoverRepositories(
  token: string,
  options: DiscoverOptions,
  onLog: LogCallback
): Promise<{ repos: RepoSummary[]; externalOwners: Set<string> }> {
  const repoMap = new Map<string, RepoSummary>();
  const externalOwners = new Set<string>();
  const hasToken = Boolean(token?.trim());

  // 1. Discover personal/member repositories if requested and token is available
  const personalRepoDiscoveryPromise = options.includeMine && hasToken
    ? (async () => {
        let nextUrl: string | null =
          `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`;
        while (nextUrl) {
          if (options.signal?.aborted) throw new Error('Operation cancelled.');
          const { data, headers } = await ghRequest<RawGhRepo[]>(
            nextUrl,
            token,
            { signal: options.signal },
            { onLog }
          );
          for (const r of data) {
            if (!options.includePrivate && r.private) continue;
            if (!options.includeForks && r.fork) continue;
            if (!matchesRepoFilter(r.full_name, options.repoFilter)) continue;
            repoMap.set(r.full_name.toLowerCase(), toRepoSummary(r));
          }
          nextUrl = parseNextLink(headers.get('Link'));
        }
        onLog(`Discovered ${repoMap.size} personal/member repositories.`, 'info');
      })()
    : (async () => {
        if (options.includeMine && !hasToken) {
            onLog(
              'No GitHub token verified — skipping private/personal repository discovery and scanning public sources.',
              'info'
            );
        }
    })();

  // 2. Process external sources concurrently with personal discovery
  const externalTargets = parseSources(options.sources);
  
  const externalProcessingPromises = externalTargets.map(async (target) => {
    if (options.signal?.aborted) throw new Error('Operation cancelled.');
    
    if (target.type === 'repo' && target.repo) {
      const slug = `${target.owner}/${target.repo}`;
      if (!matchesRepoFilter(slug, options.repoFilter)) return;
      if (repoMap.has(slug.toLowerCase())) return;
      
      try {
        const { data } = await ghRequest<RawGhRepo>(
          `/repos/${target.owner}/${target.repo}`,
          token,
          { signal: options.signal },
          { onLog }
        );
        if (!options.includeForks && data.fork) return;
        if (!options.includePrivate && data.private) return;
        
        const key = data.full_name.toLowerCase();
        repoMap.set(key, toRepoSummary(data));
        externalOwners.add(key);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onLog(`Skipped ${slug}: ${msg}`, 'warn');
      }
    } else {
      let nextUrl: string | null = `/users/${target.owner}/repos?per_page=100&type=public&sort=updated`;
      let added = 0;
      try {
        while (nextUrl) {
          if (options.signal?.aborted) throw new Error('Operation cancelled.');
          const { data, headers } = await ghRequest<RawGhRepo[]>(
            nextUrl,
            token,
            { signal: options.signal },
            { onLog }
          );
          for (const r of data) {
            if (!options.includeForks && r.fork) continue;
            if (!matchesRepoFilter(r.full_name, options.repoFilter)) continue;
            const key = r.full_name.toLowerCase();
            if (!repoMap.has(key)) {
              repoMap.set(key, toRepoSummary(r));
              externalOwners.add(key);
              added += 1;
            }
          }
          nextUrl = parseNextLink(headers.get('Link'));
        }
        onLog(`Added ${added} public repos from @${target.owner}.`, 'info');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onLog(`Could not list repos for ${target.owner}: ${msg}`, 'warn');
      }
    }
  });

  // Run personal discovery and external processing in parallel
  await Promise.all([personalRepoDiscoveryPromise, Promise.all(externalProcessingPromises)]);

  return {
    repos: Array.from(repoMap.values()),
    externalOwners,
  };
}

interface RawGhBranch {
  name: string;
}

interface RawGhCommit {
  sha: string;
  html_url?: string;
  author?: { login?: string } | null;
  commit: {
    message: string;
    author?: {
      name?: string;
      email?: string;
      date?: string;
    } | null;
  };
}

function encodeRepoFilePath(filePath: string): string {
  return filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

async function fetchRawEngineSource(
  token: string,
  repo: RepoSummary,
  branch: string,
  filePath: string,
  signal?: AbortSignal
): Promise<{ rawUrl: string; fullCode: string }> {
  if (!repo.full_name || !filePath || !branch) {
    throw new Error('Invalid input: repo.full_name, filePath, or branch cannot be empty.');
  }
  const encodedBranch = encodeURIComponent(branch);
  const encodedPath = encodeRepoFilePath(filePath);
  const rawUrl = `https://raw.githubusercontent.com/${repo.full_name}/${encodedBranch}/${encodedPath}`;
  const trimmedToken = token.trim();

  if (!repo.private) {
    const res = await fetchWithTimeout(rawUrl, { signal }, GITHUB_REQUEST_TIMEOUT_MS);
    if (res.ok) {
      return { rawUrl, fullCode: await res.text() };
    }
  }

  // Fallback for private repositories (or raw CDN miss) via raw GitHub Contents accept header
  const contentsUrl = `${GITHUB_API}/repos/${repo.full_name}/contents/${encodedPath}?ref=${encodedBranch}`;
  const apiRes = await fetchWithTimeout(
    contentsUrl,
    {
      signal,
      headers: {
        Accept: 'application/vnd.github.raw+json',
        ...(trimmedToken ? { Authorization: `Bearer ${trimmedToken}` } : {}),
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
    GITHUB_REQUEST_TIMEOUT_MS
  );
  if (!apiRes.ok) {
    throw new Error(`HTTP ${apiRes.status} fetching raw source for ${filePath} in ${repo.full_name}`);
  }
  return { rawUrl, fullCode: await apiRes.text() };
}

export async function extractCommitsForRepo(
  token: string,
  repo: RepoSummary,
  options: {
    author: string;
    sinceDate: string;
    untilDate: string;
    skipOwn: boolean;
    includeEmails: boolean;
    branchScope?: BranchScope;
    siphonEngines?: boolean;
    maxEnginesPerRepo?: number;
    signal?: AbortSignal;
    onLog?: LogCallback;
    onProgress?: (progress: {
      branchesScanned: number;
      uniqueCommits: number;
      enginesSiphoned: number;
      currentBranch: string;
      page: number;
      stageDetail?: string;
    }) => void;
  }
): Promise<{ commits: RawCommit[]; branchCount: number; engines: SiphonedEngine[] }> {
  const defaultBranch = repo.default_branch || 'main';
  const branchScope: BranchScope = options.branchScope ?? 'all';
  let orderedBranches: string[] = [defaultBranch];

  if (branchScope === 'first') {
    try {
      const { data } = await ghRequest<RawGhBranch[]>(
        `/repos/${repo.full_name}/branches?per_page=10`,
        token,
        { signal: options.signal },
        {
          onLog: options.onLog,
          onWait: (reason) =>
            options.onProgress?.({
              branchesScanned: 0,
              uniqueCommits: 0,
              enginesSiphoned: 0,
              currentBranch: defaultBranch,
              page: 1,
              stageDetail: reason,
            }),
        }
      );
      if (data.length > 0 && data[0]?.name) {
        orderedBranches = [data[0].name];
      }
    } catch {
      orderedBranches = [defaultBranch];
    }
  } else if (branchScope === 'all') {
    const branches: string[] = [];
    let branchUrl: string | null = `/repos/${repo.full_name}/branches?per_page=100`;

    try {
      while (branchUrl) {
        if (options.signal?.aborted) throw new Error('Operation cancelled.');
        const { data, headers } = await ghRequest<RawGhBranch[]>(
          branchUrl,
          token,
          { signal: options.signal },
          { onLog: options.onLog }
        );
        for (const b of data) {
          if (b.name !== defaultBranch) branches.push(b.name);
        }
        branchUrl = parseNextLink(headers.get('Link'));
      }
    } catch {
      // Fall back cleanly to default branch if branches listing fails
    }

    // Always scan the repository's default branch first, followed by every other branch
    orderedBranches = [defaultBranch, ...branches];
  }

  const commitMap = new Map<string, RawCommit>();
  const params = new URLSearchParams({ per_page: '100' });
  if (options.author.trim()) params.set('author', options.author.trim());
  if (options.sinceDate) params.set('since', `${options.sinceDate}T00:00:00Z`);
  if (options.untilDate) params.set('until', `${options.untilDate}T23:59:59Z`);

  let branchesScanned = 0;

  for (const branch of orderedBranches) {
    if (options.signal?.aborted) throw new Error('Operation cancelled.');
    branchesScanned += 1;
    let page = 0;
    const branchParams = new URLSearchParams(params);
    branchParams.set('sha', branch);
    let commitUrl: string | null = `/repos/${repo.full_name}/commits?${branchParams.toString()}`;

    options.onProgress?.({
      branchesScanned,
      uniqueCommits: commitMap.size,
      enginesSiphoned: 0,
      currentBranch: branch,
      page: 1,
      stageDetail: `branch ${branchesScanned}/${orderedBranches.length} (${branch}) · page 1 (${commitMap.size} commits)`,
    });

    while (commitUrl) {
      if (options.signal?.aborted) throw new Error('Operation cancelled.');
      page += 1;
      try {
        const { data, headers } = await ghRequest<RawGhCommit[]>(
          commitUrl,
          token,
          { signal: options.signal },
          {
            onLog: options.onLog,
            onWait: (reason) =>
              options.onProgress?.({
                branchesScanned,
                uniqueCommits: commitMap.size,
                enginesSiphoned: 0,
                currentBranch: branch,
                page,
                stageDetail: `branch ${branchesScanned}/${orderedBranches.length} (${branch}) · ${reason}`,
              }),
          }
        );

        for (const item of data) {
          const msg = item.commit?.message ?? '';
          if (options.skipOwn && msg.includes(TOOL_TAG)) continue;

          const existing = commitMap.get(item.sha);
          if (existing) {
            if (!existing.branches.includes(branch)) {
              existing.branches.push(branch);
            }
          } else {
            commitMap.set(item.sha, {
              sha: item.sha,
              repo: repo.full_name,
              isPrivate: repo.private,
              branches: [branch],
              message: msg,
              authorName: item.commit?.author?.name || item.author?.login || 'Unknown',
              authorLogin: item.author?.login,
              authorEmail: options.includeEmails ? item.commit?.author?.email : undefined,
              date: item.commit?.author?.date || new Date().toISOString(),
              htmlUrl: item.html_url,
              ciState: 'unknown',
            });
          }
        }

        options.onProgress?.({
          branchesScanned,
          uniqueCommits: commitMap.size,
          enginesSiphoned: 0,
          currentBranch: branch,
          page,
          stageDetail: `branch ${branchesScanned}/${orderedBranches.length} (${branch}) · page ${page} (${commitMap.size} commits)`,
        });

        commitUrl = parseNextLink(headers.get('Link'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('409') || msg.toLowerCase().includes('empty')) {
          break;
        }
        throw err;
      }
    }

    // Brief inter-branch cooldown on multi-branch repos to stay clear of secondary limits
    if (branchesScanned < orderedBranches.length) {
      await sleepWithAbort(150, options.signal);
    }
  }

  const commitList = Array.from(commitMap.values());
  const engines: SiphonedEngine[] = [];

  if (options.siphonEngines !== false) {
    const targetBranch = orderedBranches[0] || defaultBranch;
    try {
      options.onProgress?.({
        branchesScanned,
        uniqueCommits: commitList.length,
        enginesSiphoned: 0,
        currentBranch: targetBranch,
        page: 1,
        stageDetail: `siphoning engines (${targetBranch})`,
      });

      const { data: treeData } = await ghRequest<{ tree?: GitTreeNode[]; truncated?: boolean }>(
        `/repos/${repo.full_name}/git/trees/${encodeURIComponent(targetBranch)}?recursive=1`,
        token,
        { signal: options.signal },
        { onLog: options.onLog }
      );

      const selectedNodes = selectEngineTreePaths(
        treeData.tree ?? [],
        options.maxEnginesPerRepo ?? 12
      );

      for (let i = 0; i < selectedNodes.length; i += 1) {
        if (options.signal?.aborted) throw new Error('Operation cancelled.');
        const node = selectedNodes[i];
        try {
          const { rawUrl, fullCode } = await fetchRawEngineSource(
            token,
            repo,
            targetBranch,
            node.path,
            options.signal
          );
          const record = buildUnredactedEngineRecord({
            repo: repo.full_name,
            branch: targetBranch,
            filePath: node.path,
            rawUrl,
            treeSha: node.sha,
            fullCode,
            repoCommits: commitList,
          });
          engines.push(record);
          options.onProgress?.({
            branchesScanned,
            uniqueCommits: commitList.length,
            enginesSiphoned: engines.length,
            currentBranch: targetBranch,
            page: 1,
            stageDetail: `siphoned engine ${i + 1}/${selectedNodes.length}: ${node.path}`,
          });
          if (i + 1 < selectedNodes.length) {
            await sleepWithAbort(120, options.signal);
          }
        } catch (fileErr) {
          const msg = fileErr instanceof Error ? fileErr.message : String(fileErr);
          options.onLog?.(`Skipped engine ${repo.full_name}/${node.path}: ${msg}`, 'warn');
        }
      }
    } catch (treeErr) {
      const msg = treeErr instanceof Error ? treeErr.message : String(treeErr);
      if (!msg.includes('409') && !msg.toLowerCase().includes('empty')) {
        options.onLog?.(`Engine siphon skipped for ${repo.full_name}: ${msg}`, 'warn');
      }
    }
  }

  return {
    commits: commitList,
    branchCount: branchesScanned,
    engines,
  };
}

export async function lookupCommitCiState(
  token: string,
  repoFullName: string,
  sha: string,
  signal?: AbortSignal,
  onLog?: LogCallback
): Promise<CiState> {
  try {
    const { data: checks } = await ghRequest<{
      total_count: number;
      check_runs: Array<{ status: string; conclusion: string | null }>;
    }>(
      `/repos/${repoFullName}/commits/${sha}/check-runs?per_page=30`,
      token,
      { signal },
      { onLog }
    );

    if (checks.total_count > 0 && checks.check_runs.length > 0) {
      const conclusions = checks.check_runs.map((r) => r.conclusion);
      if (
        conclusions.some((c) =>
          ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(c || '')
        )
      ) {
        return 'failure';
      }
      if (checks.check_runs.some((r) => r.status !== 'completed')) {
        return 'pending';
      }
      if (conclusions.every((c) => ['success', 'neutral', 'skipped'].includes(c || ''))) {
        return 'success';
      }
    }

    const { data: status } = await ghRequest<{ state: string }>(
      `/repos/${repoFullName}/commits/${sha}/status`,
      token,
      { signal },
      { onLog }
    );
    if (status.state === 'failure' || status.state === 'error') return 'failure';
    if (status.state === 'success') return 'success';
    if (status.state === 'pending') return 'pending';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function encodeBase64Utf8(content: string): string {
  // Adapted from the original GitHistory-Sync btoa(binary) form for the
  // Node/Bun runtime: Buffer handles UTF-8 -> base64 in one call without
  // the manual byte->binary-string loop the browser version needed.
  return Buffer.from(content, 'utf8').toString('base64');
}

export async function pushSplitArchivesToGitHub(
  token: string,
  params: {
    repo: string;
    branch: string;
    autoCreatePrivate: boolean;
    files: Array<{ path: string; content: string; label: string }>;
  },
  onLog: LogCallback
): Promise<void> {
  const [owner, repoName] = params.repo.split('/');

  let repoExists = true;
  try {
    await ghRequest(`/repos/${params.repo}`, token, {}, { onLog });
  } catch {
    repoExists = false;
  }

  if (!repoExists) {
    if (!params.autoCreatePrivate) {
      throw new Error(`Destination repository ${params.repo} does not exist.`);
    }
    onLog(`Creating private repository ${params.repo}...`, 'info');
    await ghRequest(
      '/user/repos',
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: repoName,
          private: true,
          auto_init: true,
          description: `Commit history archive created ${TOOL_TAG}`,
        }),
      },
      { onLog }
    );
    onLog(`Created private repository ${owner}/${repoName}.`, 'success');
  }

  for (const file of params.files) {
    let existingSha: string | undefined;
    try {
      const { data } = await ghRequest<{ sha?: string }>(
        `/repos/${params.repo}/contents/${encodeURIComponent(file.path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(params.branch)}`,
        token,
        {},
        { onLog }
      );
      existingSha = data.sha;
    } catch {
      existingSha = undefined;
    }

    await ghRequest(
      `/repos/${params.repo}/contents/${encodeURIComponent(file.path).replace(/%2F/g, '/')}`,
      token,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `chore(archive): sync ${file.label} commit log ${TOOL_TAG}`,
          content: encodeBase64Utf8(file.content),
          branch: params.branch,
          ...(existingSha ? { sha: existingSha } : {}),
        }),
      },
      { onLog }
    );
    onLog(`Pushed ${file.path} to ${params.repo}@${params.branch}.`, 'success');
  }
}
