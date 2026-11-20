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
export function parseSources(input: string): ParsedSource[] {
  const tokens = input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const results: ParsedSource[] = [];

  for (let token of tokens) {
    // Strip trailing .git or URL prefixes
    token = token.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
    token = token.replace(/\.git$/i, '');
    token = token.replace(/^\/+|\/+$/g, '');
    if (!token) continue;

    const parts = token.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1];
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
export function appendPresetToSources(existing: string, additions: string[]): string {
  const current = parseSources(existing);
  const existingKeys = new Set(current.map((c) => c.raw.toLowerCase()));
  const merged = current.map((c) => c.raw);

  for (const add of additions) {
    const parsed = parseSources(add);
    for (const item of parsed) {
      const key = item.raw.toLowerCase();
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        merged.push(item.raw);
      }
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

  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmedRepo)) {
    throw new Error('Repository must look like "owner/repository" (for example craighckby-stack/V1).');
  }
  if (!trimmedBranch || /\s/.test(trimmedBranch)) {
    throw new Error('Branch name cannot be empty or contain spaces.');
  }
  if (!trimmedPath || trimmedPath.startsWith('/') || trimmedPath.endsWith('/')) {
    throw new Error(`File path must point to a relative file (for example ${DEFAULT_BASE_PATH}).`);
  }
  for (const seg of trimmedPath.split('/')) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error(`Invalid path segment "${seg}".`);
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
  const clean = (basePath.trim() || DEFAULT_BASE_PATH).replace(/^\/+/, '');
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
  const tokens = filterText
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const target = fullName.toLowerCase();
  return tokens.some((tok) => target.includes(tok));
}
