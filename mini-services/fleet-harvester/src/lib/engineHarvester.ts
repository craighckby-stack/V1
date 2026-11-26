import type { EngineRole, RawCommit, SiphonedEngine } from '../types/git';

export interface GitTreeNode {
  path: string;
  type: 'blob' | 'tree' | string;
  size?: number;
  sha?: string;
}

const SUPPORTED_EXT_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
};

const EXCLUDED_PATH_PATTERN =
  /(^|\/)(node_modules|vendor|dist|build|out|target|\.next|\.git|__pycache__|\.venv|venv|coverage|fixtures?|mocks?|__tests__|tests?|spec|examples?|docs?|stories|storybook|migrations?|locale|locales|i18n|assets|public|static|benchmarks?)(\/|$)/i;

const EXCLUDED_FILE_PATTERN =
  /(\.min\.|\.bundle\.|\.d\.ts$|\.(test|spec|stories|mock|fixture)\.[a-z]+$|_test\.(go|py|rs|ts|js)$|test_[^/]+\.py$|setup\.py$|conftest\.py$)/i;

const HIGH_VALUE_ENGINE_KEYWORDS =
  /(engine|agent|loop|kernel|runtime|orchestrat|pipeline|graph|workflow|executor|mutation|tribunal|gate|retriever|retrieval|rag|vector|embed|indexer|rerank|sandbox|memory|router|scheduler|state_machine|statemachine|queue|worker|harness|eval|core)/i;

const MEDIUM_VALUE_DIR_PATTERN =
  /(^|\/)(src|core|pkg|internal|lib|app|server|backend|api|packages|modules|services)(\/|$)/i;

const MAX_ENGINE_FILE_BYTES = 500_000;

export function detectEngineLanguage(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  for (const [ext, lang] of Object.entries(SUPPORTED_EXT_MAP)) {
    if (lower.endsWith(ext)) return lang;
  }
  return null;
}

/**
 * Scores a repository tree blob path to identify high-signal runtime engines
 * without touching tests, build outputs, docs, or gigantic minified bundles.
 * Returns <= 0 when the file should be skipped.
 */
export function scoreEngineFilePath(filePath: string, size?: number): number {
  const clean = filePath.replace(/^\/+/, '');
  const lang = detectEngineLanguage(clean);
  if (!lang) return 0;

  const numericSize = (typeof size === 'number' && size >= 0) ? size : undefined;

  if (numericSize !== undefined && (numericSize <= 40 || numericSize > MAX_ENGINE_FILE_BYTES)) {
    return 0;
  }

  if (EXCLUDED_PATH_PATTERN.test(clean) || EXCLUDED_FILE_PATTERN.test(clean)) {
    return 0;
  }

  const fileName = clean.split('/').pop() || clean;
  if (/^(index|__init__|mod|main|types|constants|config|settings)\.[a-z]+$/i.test(fileName)) {
    // Allow main/index only if inside an explicit engine/core/loop folder
    if (!/(engine|loop|kernel|runtime|agent|orchestrat|rag|retriev|pipeline|sandbox|memory)/i.test(clean)) {
      return 0;
    }
  }

  let score = 0;
  const pathMatches = clean.match(HIGH_VALUE_ENGINE_KEYWORDS);
  if (pathMatches) {
    score += pathMatches.length * 30;
  }

  if (HIGH_VALUE_ENGINE_KEYWORDS.test(fileName)) {
    score += 45;
  }

  if (MEDIUM_VALUE_DIR_PATTERN.test(clean)) {
    score += 12;
  }

  // Prefer substantive files (> 1.5KB) over tiny helpers
  if (numericSize !== undefined) {
    if (numericSize >= 2000 && numericSize <= 120_000) score += 18;
    else if (numericSize >= 600) score += 8;
  }

  // Slightly prefer shallower canonical modules over deeply nested leaves
  const depth = clean.split('/').length;
  score -= Math.max(0, depth - 3) * 3;

  return score;
}

/**
 * Selects the top-scored runtime engine paths from a repository Git tree in a single pass.
 */
export function selectEngineTreePaths(treeNodes: GitTreeNode[], maxPerRepo = 12): GitTreeNode[] {
  if (!Array.isArray(treeNodes)) {
    throw new Error('Input treeNodes must be an array of GitTreeNode');
  }
  if (maxPerRepo < 0) {
    throw new Error('maxPerRepo must be a non-negative number');
  }

  const scored = treeNodes
    .filter(node => node.type === 'blob' && node.path)
    .map(node => ({
      node,
      score: scoreEngineFilePath(node.path, node.size),
    }))
    .filter(item => item.score >= 40);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.node.size ?? 0) - (a.node.size ?? 0);
  });

  const limit = Math.min(maxPerRepo, scored.length);
  return scored.slice(0, limit).map((item) => item.node);
}

export function inferEngineRole(filePath: string, fullCode: string): EngineRole {
  const combined = `${filePath}\n${fullCode.slice(0, 4000)}`.toLowerCase();
  if (/(loop|mutation|tribunal|agent|autonomous|self_mod|self-mod)/.test(combined)) {
    return 'agent-loop';
  }
  if (/(rag|retriev|vector|embed|bm25|rerank|hybrid_search|knowledge_graph|lightrag)/.test(combined)) {
    return 'rag-retrieval';
  }
  if (/(orchestrat|workflow|pipeline|dag|graph|state_machine|scheduler)/.test(combined)) {
    return 'orchestrator';
  }
  if (/(sandbox|container|docker|wasm|isolate|subprocess|executor)/.test(combined)) {
    return 'execution-sandbox';
  }
  if (/(memory|checkpoint|lesson|episodic|store|cache|persist)/.test(combined)) {
    return 'memory-state';
  }
  if (/(router|gateway|proxy|rate_limit|balancer|dispatch)/.test(combined)) {
    return 'router-gateway';
  }
  return 'core-runtime';
}

function uniqueOrdered(items: string[], max = 40): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
      if (out.length >= max) break;
    }
  }
  return out;
}

/**
 * Extracts AST-level structural metadata (classes, functions, imports, line/byte size, role)
 * from complete engine source code WITHOUT altering, redacting, or slicing `fullCode`.
 */
export function scanEngineAst(fullCode: string, filePath: string): {
  language: string;
  role: EngineRole;
  byteSize: number;
  lineCount: number;
  classNames: string[];
  functionNames: string[];
  imports: string[];
} {
  if (!fullCode) {
    return {
      language: detectEngineLanguage(filePath) || 'Source',
      role: 'core-runtime',
      byteSize: 0,
      lineCount: 0,
      classNames: [],
      functionNames: [],
      imports: [],
    };
  }

  const language = detectEngineLanguage(filePath) || 'Source';
  const role = inferEngineRole(filePath, fullCode);
  const byteSize = new TextEncoder().encode(fullCode).length;
  const lineCount = fullCode.length === 0 ? 0 : fullCode.split(/\r?\n/).length;

  const classes: string[] = [];
  const functions: string[] = [];
  const imports: string[] = [];

  if (language === 'Python') {
    const pyClassRx = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
    let m: RegExpExecArray | null;
    try {
      while ((m = pyClassRx.exec(fullCode)) !== null) classes.push(m[1]);
    } catch {
      // Ignore regex errors on malformed input
    }

    const pyFnRx = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
    let mFn: RegExpExecArray | null;
    try {
      while ((mFn = pyFnRx.exec(fullCode)) !== null) functions.push(mFn[1]);
    } catch {
      // Ignore regex errors on malformed input
    }

    const pyImpRx = /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm;
    let mImp: RegExpExecArray | null;
    try {
      while ((mImp = pyImpRx.exec(fullCode)) !== null) imports.push(mImp[1] || mImp[2]);
    } catch {
      // Ignore regex errors on malformed input
    }
  } else if (language === 'Go') {
    const goTypeRx = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\b/gm;
    let m: RegExpExecArray | null;
    try {
      while ((m = goTypeRx.exec(fullCode)) !== null) classes.push(m[1]);
    } catch {
      // Ignore regex errors on malformed input
    }

    const goFnRx = /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
    let mFn: RegExpExecArray | null;
    try {
      while ((mFn = goFnRx.exec(fullCode)) !== null) functions.push(mFn[1]);
    } catch {
      // Ignore regex errors on malformed input
    }

    const goImpRx = /"([A-Za-z0-9_.\-/]+)"/g;
    const impBlockMatch = fullCode.match(/import\s*(?:\([\s\S]*?\)|"[^"]+")/g);
    if (impBlockMatch) {
      for (const blk of impBlockMatch) {
        let mImp: RegExpExecArray | null;
        try {
          while ((mImp = goImpRx.exec(blk)) !== null) imports.push(mImp[1]);
        } catch {
          // Ignore regex errors on malformed input
        }
      }
    }
  } else if (language === 'Rust') {
    const rsTypeRx = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
    let m: RegExpExecArray | null;
    try {
      while ((m = rsTypeRx.exec(fullCode)) !== null) classes.push(m[1]);
    } catch {
      // Ignore regex errors on malformed input
    }

    const rsFnRx = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
    let mFn: RegExpExecArray | null;
    try {
      while ((mFn = rsFnRx.exec(fullCode)) !== null) functions.push(mFn[1]);
    } catch {
      // Ignore regex errors on malformed input
    }

    const rsUseRx = /^\s*(?:pub\s+)?use\s+([A-Za-z0-9_:]+)/gm;
    let mImp: RegExpExecArray | null;
    try {
      while ((mImp = rsUseRx.exec(fullCode)) !== null) imports.push(mImp[1]);
    } catch {
      // Ignore regex errors on malformed input
    }
  } else {
    // TypeScript / JavaScript
    const tsClassRx = /\b(?:class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let m: RegExpExecArray | null;
    try {
      while ((m = tsClassRx.exec(fullCode)) !== null) classes.push(m[1]);
    } catch {
      // Ignore regex errors on malformed input
    }

    const tsFnRx =
      /(?:^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]|^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>)/gm;
    let mFn: RegExpExecArray | null;
    try {
      while ((mFn = tsFnRx.exec(fullCode)) !== null) functions.push(mFn[1] || mFn[2]);
    } catch {
      // Ignore regex errors on malformed input
    }

    const tsImpRx = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
    let mImp: RegExpExecArray | null;
    try {
      while ((mImp = tsImpRx.exec(fullCode)) !== null) imports.push(mImp[1]);
    } catch {
      // Ignore regex errors on malformed input
    }
  }

  return {
    language,
    role,
    byteSize,
    lineCount,
    classNames: uniqueOrdered(classes),
    functionNames: uniqueOrdered(functions),
    imports: uniqueOrdered(imports),
  };
}

/**
 * Cross-links commits extracted in the same repository pass that reference the
 * siphoned engine file name, module stem, or declared primary class/function.
 */
export function linkCommitsToEngine(
  filePath: string,
  classNames: string[],
  functionNames: string[],
  repoCommits: RawCommit[]
): string[] {
  const fileName = (filePath.split('/').pop() || filePath).toLowerCase();
  const stem = fileName.replace(/\.[a-z0-9]+$/i, '');
  const terms = new Set<string>([filePath.toLowerCase(), fileName]);
  if (stem.length >= 4) terms.add(stem);
  for (const cls of classNames.slice(0, 6)) {
    if (cls.length >= 4) terms.add(cls.toLowerCase());
  }
  for (const fn of functionNames.slice(0, 6)) {
    if (fn.length >= 5) terms.add(fn.toLowerCase());
  }

  const matched: string[] = [];
  for (const commit of repoCommits) {
    const msg = commit.message.toLowerCase();
    const isMatch = Array.from(terms).some(term => msg.includes(term));
    
    if (isMatch) {
      matched.push(commit.sha);
    }

    if (matched.length >= 25) break;
  }

  return matched;
}

/**
 * Builds an unredacted SiphonedEngine record from full raw source text.
 */
export function buildUnredactedEngineRecord(params: {
  repo: string;
  branch: string;
  filePath: string;
  rawUrl: string;
  treeSha?: string;
  fullCode: string;
  repoCommits: RawCommit[];
  harvestedAt?: string;
}): SiphonedEngine {
  const ast = scanEngineAst(params.fullCode, params.filePath);
  const relatedCommitShas = linkCommitsToEngine(
    params.filePath,
    ast.classNames,
    ast.functionNames,
    params.repoCommits
  );

  return {
    id: `${params.repo}@${params.branch}:${params.filePath}`,
    repo: params.repo,
    branch: params.branch,
    ...(params.treeSha ? { treeSha: params.treeSha } : {}),
    filePath: params.filePath,
    rawUrl: params.rawUrl,
    language: ast.language,
    role: ast.role,
    byteSize: ast.byteSize,
    lineCount: ast.lineCount,
    classNames: ast.classNames,
    functionNames: ast.functionNames,
    imports: ast.imports,
    relatedCommitShas,
    redacted: false,
    fullCode: params.fullCode,
    harvestedAt: params.harvestedAt ?? new Date().toISOString(),
  };
}