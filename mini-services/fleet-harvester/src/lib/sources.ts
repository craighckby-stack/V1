import type { ArchiveFormat } from '../types/git';

export interface TopPreset {
  value: string;
  label: string;
}

export const CURATED_PRESETS: TopPreset[] = [
  { value: 'craighckby-stack', label: '#1 craighckby-stack (Your account)' },
  { value: 'infiniflow/ragflow', label: '#2 infiniflow/ragflow (Largest open-source RAG system)' },
  { value: 'torvalds/linux', label: '#3 torvalds/linux (Most-committed Linux kernel)' },
  { value: 'microsoft/vscode', label: '#4 microsoft/vscode (Top committed editor)' },
  { value: 'vercel/next.js', label: '#5 vercel/next.js (Top committed web framework)' },
  { value: 'facebook/react', label: '#6 facebook/react (Core UI library)' },
  { value: 'huggingface/transformers', label: '#7 huggingface/transformers (Top committed AI/ML hub)' },
  { value: 'kubernetes/kubernetes', label: '#8 kubernetes/kubernetes (Cloud infrastructure)' },
  { value: 'python/cpython', label: '#9 python/cpython (Python runtime)' },
  { value: 'rust-lang/rust', label: '#10 rust-lang/rust (Rust compiler)' },
  { value: 'IBM/mcp-context-forge', label: '#11 IBM/mcp-context-forge (IBM — Enterprise AI & MCP forge)' },
  { value: 'deepseek-ai/DeepSeek-V3', label: '#12 deepseek-ai/DeepSeek-V3 (DeepSeek — Flagship LLM)' },
  { value: 'google-deepmind/deepmind-research', label: '#13 google-deepmind/deepmind-research (DeepMind — Research archive)' },
  { value: 'trekhleb/javascript-algorithms', label: '#14 trekhleb/javascript-algorithms (JavaScript — Core JS algorithms)' },
  { value: 'firebase/firebase-js-sdk', label: '#15 firebase/firebase-js-sdk (Firebase — Official JS SDK)' },
  { value: 'langchain-ai/langchain', label: '#16 langchain-ai/langchain (Huge RAG — LangChain framework)' },
  { value: 'run-llama/llama_index', label: '#17 run-llama/llama_index (Huge RAG — LlamaIndex framework)' },
  { value: 'langgenius/dify', label: '#18 langgenius/dify (Huge RAG — Dify LLM & RAG platform)' },
  { value: 'open-webui/open-webui', label: '#19 open-webui/open-webui (Huge RAG — Open WebUI RAG workspace)' },
  { value: 'Mintplex-Labs/anything-llm', label: '#20 Mintplex-Labs/anything-llm (Huge RAG — AnythingLLM private RAG)' },
  { value: 'FlowiseAI/Flowise', label: '#21 FlowiseAI/Flowise (Huge RAG — Visual RAG & agent builder)' },
  { value: 'HKUDS/LightRAG', label: '#22 HKUDS/LightRAG (Huge RAG — Graph-enhanced LightRAG)' },
  { value: 'deepset-ai/haystack', label: '#23 deepset-ai/haystack (Huge RAG — Haystack RAG pipelines)' },
];

export const TOP_10_PRESETS: TopPreset[] = CURATED_PRESETS;

export const TOOL_TAG = 'via GitHistory Sync';
export const DEFAULT_BASE_PATH = 'memory/commit-history.json';

export interface ParsedSource {
  type: 'repo' | 'owner';
  owner: string;
  repo?: string;
  raw: string;
}

/**
 * Parses comma- or newline-separated GitHub usernames, orgs, owner/repo slugs,
 * or full GitHub URLs into normalized, deduplicated targets.
 */
export function parseSources(input: string | null | undefined): ParsedSource[] {
  if (!input) return [];
  
  const tokens = input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const results: ParsedSource[] = [];

  // Regex to match GitHub URLs and capture owner/repo, or just owner/repo slugs.
  // Handles: https://github.com/owner/repo, github.com/owner/repo, owner/repo
  // Captures: (owner)/(repo)
  const githubSlugRegex = /^((?:https?:\/\/(?:www\.)?github\.com\/)?([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+))(?:\.git)?$/i;

  for (const token of tokens) {
    let cleanToken = token;
    let match = cleanToken.match(githubSlugRegex);

    if (match) {
      // match[2] is owner, match[3] is repo
      cleanToken = `${match[2]}/${match[3]}`;
    } else {
      // Strip trailing .git if not matched by URL regex
      cleanToken = cleanToken.replace(/\.git$/i, '');
    }
    
    cleanToken = cleanToken.replace(/^\/+|\/+$/g, '');
    
    if (!cleanToken) continue;

    const parts = cleanToken.split('/').filter(Boolean);
    
    if (parts.length >= 2) {
      const owner = parts[0];
      // Ensure repo captures the entire path after the owner
      const repo = parts.slice(1).join('/'); 
      const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ type: 'repo', owner, repo, raw: `${owner}/${repo}` });
      }
    } else if (parts.length === 1) {
      const owner = parts[0];
      const key = owner.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ type: 'owner', owner, raw: owner });
      }
    }
  }

  return results;
}

/**
 * Appends new preset tokens to an existing sources string without duplicating entries.
 */
export function appendPresetToSources(existing: string | null | undefined, additions: string[]): string {
  const existingString = existing ?? '';
  
  const current = parseSources(existingString);
  const existingKeys = new Set(current.map((c) => c.raw.toLowerCase()));
  const merged = [...current.map((c) => c.raw)];

  if (additions.length === 0) return existingString;

  // Parse all additions once
  const parsedAdditions = parseSources(additions.join(', '));

  for (const item of parsedAdditions) {
    const key = item.raw.toLowerCase();
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      merged.push(item.raw);
    }
  }

  return merged.join(', ');
}

/**
 * Validates destination repository, branch, and file path.
 * Throws a descriptive Error if invalid.
 */
export function validateDestination(repo: string, branch: string, filePath: string): void {
  const trimmedRepo = repo.trim();
  const trimmedBranch = branch.trim();
  const trimmedPath = filePath.trim();

  if (!/^[A-Za-z0-9._-]+[A-Za-z0-9._-]+$/.test(trimmedRepo)) {
    throw new Error(`Invalid repository format: "${repo}". Repository must look like "owner/repository" (e.g., craighckby-stack/V1).`);
  }
  if (!trimmedBranch || /\s/.test(trimmedBranch)) {
    throw new Error(`Invalid branch name: "${branch}". Branch name cannot be empty or contain spaces.`);
  }
  if (!trimmedPath || trimmedPath.startsWith('/') || trimmedPath.endsWith('/')) {
    throw new Error(`Invalid file path: "${filePath}". File path must point to a relative file (e.g., ${DEFAULT_BASE_PATH}).`);
  }
  for (const seg of trimmedPath.split('/').filter(Boolean)) {
    if (seg === '.' || seg === '..' || seg.includes('..')) {
      throw new Error(`Invalid path segment in "${filePath}": segment "${seg}" is forbidden.`);
    }
  }
}

/**
 * Derives the split archive file paths (.successful.<ext>, .failed.<ext>, .engines.<ext>) from a base path and format.
 */
export function deriveLogPaths(
  basePath: string,
  format: ArchiveFormat
): { successful: string; failed: string; engines: string } {
  const extMap: Record<ArchiveFormat, string> = {
    json: 'json',
    markdown: 'md',
    csv: 'csv',
  };
  const ext = extMap[format];
  // Use DEFAULT_BASE_PATH if basePath is null/undefined or empty after trimming
  const clean = (basePath ? basePath.trim() : DEFAULT_BASE_PATH).replace(/^\/+/, '');
  const lastSlash = clean.lastIndexOf('/');
  const dir = lastSlash >= 0 ? clean.slice(0, lastSlash + 1) : '';
  const file = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
  const stem =
    file
      .replace(/\.(json|md|markdown|csv)$/i, '')
      .replace(/\.(successful|failed|engines)$/i, '') || 'commit-history';

  return {
    successful: `${dir}${stem}.successful.${ext}`,
    failed: `${dir}${stem}.failed.${ext}`,
    engines: `${dir}${stem}.engines.${ext}`,
  };
}

/**
 * Filters repositories by comma-separated substring patterns.
 */
export function matchesRepoFilter(fullName: string, filterText: string): boolean {
  if (typeof filterText !== 'string' || !filterText.trim()) return true;
  
  const tokens = filterText
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  
  if (tokens.length === 0) return true;
  const target = fullName.toLowerCase();
  return tokens.some((tok) => target.includes(tok));
}