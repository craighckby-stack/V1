import type { GitHubUser, RawCommit, RepoSummary, SiphonedEngine } from '../types/git';
import { buildUnredactedEngineRecord } from './engineHarvester';

export const DEMO_USER: GitHubUser = {
  login: 'craighckby-stack',
  name: 'Craig H.',
  public_repos: 14,
  total_private_repos: 4,
};

export const DEMO_REPOS: RepoSummary[] = [
  {
    full_name: 'craighckby-stack/V1',
    name: 'V1',
    owner: 'craighckby-stack',
    private: true,
    fork: false,
    default_branch: 'main',
    html_url: 'https://github.com/craighckby-stack/V1',
  },
  {
    full_name: 'infiniflow/ragflow',
    name: 'ragflow',
    owner: 'infiniflow',
    private: false,
    fork: false,
    default_branch: 'main',
    html_url: 'https://github.com/infiniflow/ragflow',
  },
  {
    full_name: 'vercel/next.js',
    name: 'next.js',
    owner: 'vercel',
    private: false,
    fork: false,
    default_branch: 'canary',
    html_url: 'https://github.com/vercel/next.js',
  },
];

export const DEMO_COMMITS: RawCommit[] = [
  {
    sha: '8a4f21c9d03e7b11a5f42d8b2e7e0190c31f44a1',
    repo: 'craighckby-stack/V1',
    isPrivate: true,
    branches: ['main', 'feat/dual-ai'],
    message: 'feat(sync): add multi-branch commit deduplication and split archive writer\n\nVerified against 3 branches with zero duplicate SHAs.',
    authorName: 'Craig H.',
    authorLogin: 'craighckby-stack',
    authorEmail: 'craighckby@gmail.com',
    date: '2026-11-18T19:42:10Z',
    ciState: 'success',
  },
  {
    sha: '3b91c0441122e77a8c90123d4e5f6a7b8c9d0e11',
    repo: 'craighckby-stack/V1',
    isPrivate: true,
    branches: ['fix/auth-race'],
    message: 'wip: experimental token cache middleware (broken on Safari private mode)',
    authorName: 'Craig H.',
    authorLogin: 'craighckby-stack',
    authorEmail: 'craighckby@gmail.com',
    date: '2026-11-17T14:11:05Z',
    ciState: 'failure',
  },
  {
    sha: 'f402a88e712b90c3d4112233445566778899aabb',
    repo: 'craighckby-stack/V1',
    isPrivate: true,
    branches: ['main'],
    message: 'refactor(classifier): adjust branch scan batching window for GitHub rate limits',
    authorName: 'Craig H.',
    authorLogin: 'craighckby-stack',
    authorEmail: 'craighckby@gmail.com',
    date: '2026-11-16T09:18:33Z',
    ciState: 'unknown',
  },
  {
    sha: '9c71e2b3a4f50987654321fedcba9876543210aa',
    repo: 'craighckby-stack/V1',
    isPrivate: true,
    branches: ['main'],
    message: 'Revert "refactor(classifier): adjust branch scan batching window for GitHub rate limits"\n\nThis reverts commit f402a88e712b90c3d4112233445566778899aabb due to pagination skip under 30+ branches.',
    authorName: 'Craig H.',
    authorLogin: 'craighckby-stack',
    authorEmail: 'craighckby@gmail.com',
    date: '2026-11-16T11:04:19Z',
    ciState: 'success',
  },
  {
    sha: 'c20911ad773e412098ab34cd56ef789012345678',
    repo: 'infiniflow/ragflow',
    isPrivate: false,
    branches: ['main'],
    message: 'perf(retrieval): tune hybrid vector + BM25 reranker chunk window',
    authorName: 'Kevin Hu',
    authorLogin: 'kevinhu',
    authorEmail: 'kevinhu@example.com', // Added placeholder email for consistency if missing
    date: '2026-11-15T22:09:44Z',
    ciState: 'unknown',
  },
  {
    sha: 'd55102be884c1234567890abcdef1234567890cd',
    repo: 'infiniflow/ragflow',
    isPrivate: false,
    branches: ['main', 'release/v0.14'],
    message: 'fix(parser): guard PDF table extraction against malformed colspan cells (verified)',
    authorName: 'Zhichao L.',
    authorLogin: 'zhichaol',
    authorEmail: 'zhichaol@example.com', // Added placeholder email for consistency if missing
    date: '2026-11-14T16:30:00Z',
    ciState: 'success',
  },
  {
    sha: 'e77319df995a00112233445566778899aabbccdd',
    repo: 'vercel/next.js',
    isPrivate: false,
    branches: ['canary'],
    message: 'turbopack: skip stale persistent cache entry when lockfile hash shifts',
    authorName: 'Tobias Koppers',
    authorLogin: 'sokra',
    authorEmail: 'sokra@vercel.com', // Added placeholder email for consistency if missing
    date: '2026-11-13T10:15:27Z',
    ciState: 'unknown',
  },
  {
    sha: 'a11844bc220f99887766554433221100ffeeddcc',
    repo: 'vercel/next.js',
    isPrivate: false,
    branches: ['canary', 'fix/flight-stream'],
    message: 'test(flight): add regression coverage for aborted RSC stream boundaries',
    authorName: 'Jiachi Liu',
    authorLogin: 'huozhi',
    authorEmail: 'huozhi@example.com', // Added placeholder email for consistency if missing
    date: '2026-11-12T18:52:01Z',
    ciState: 'failure',
  },
];

const V1_COMMITS = DEMO_COMMITS.filter((c) => c.repo === 'craighckby-stack/V1');
const RAGFLOW_COMMITS = DEMO_COMMITS.filter((c) => c.repo === 'infiniflow/ragflow');
const _NEXTJS_COMMITS = DEMO_COMMITS.filter((c) => c.repo === 'vercel/next.js');


const V1_LOOP_GATE_ENGINE_CODE = `import type { ClassifiedCommit, SiphonedEngine } from './types';

export interface MutationCandidate {
  id: string;
  targetFile: string;
  patchSummary: string;
  touchedSymbols: string[];
}

export interface GateDecision {
  accepted: boolean;
  reason: string;
  matchedFailureSha?: string;
}

export class LoopMutationGateEngine {
  private readonly failedCommits: ClassifiedCommit[];
  private readonly engines: SiphonedEngine[];

  constructor(failedCommits: ClassifiedCommit[], engines: SiphonedEngine[]) {
    this.failedCommits = failedCommits;
    this.engines = engines;
  }

  public evaluateCandidate(candidate: MutationCandidate): GateDecision {
    const normalizedFile = candidate.targetFile.toLowerCase();
    for (const regression of this.failedCommits) {
      const msgLower = regression.message.toLowerCase();
      if (msgLower.includes(normalizedFile) || candidate.touchedSymbols.some((s) => msgLower.includes(s.toLowerCase()))) {
        return {
          accepted: false,
          reason: \`Blocked by prior regression history: \${regression.reason}\`,
          matchedFailureSha: regression.sha,
        };
      }
    }

    const referenceEngine = this.engines.find((e) => e.filePath.toLowerCase().includes(normalizedFile));
    if (referenceEngine && referenceEngine.redacted === false) {
      return {
        accepted: true,
        reason: \`Verified against full unredacted engine (\${referenceEngine.lineCount} lines).\`,
      };
    }

    return {
      accepted: true,
      reason: 'No known regression conflicts detected in LOOP memory.',
    };
  }
}
`;

const RAGFLOW_RETRIEVER_ENGINE_CODE = `from dataclasses import dataclass
from typing import List, Dict

@dataclass
class RankedChunk:
    chunk_id: str
    vector_score: float
    bm25_score: float
    fused_score: float

def hybrid_rerank_fusion(
    vector_hits: Dict[str, float],
    bm25_hits: Dict[str, float],
    vector_weight: float = 0.65,
    top_k: int = 12,
) -> List[RankedChunk]:
    bm25_weight = 1.0 - vector_weight
    all_ids = set(vector_hits.keys()) | set(bm25_hits.keys())
    scored: List[RankedChunk] = []

    for cid in all_ids:
        v_score = vector_hits.get(cid, 0.0)
        b_score = bm25_hits.get(cid, 0.0)
        fused = (v_score * vector_weight) + (b_score * bm25_weight)
        scored.append(RankedChunk(chunk_id=cid, vector_score=v_score, bm25_score=b_score, fused_score=fused))

    scored.sort(key=lambda item: item.fused_score, reverse=True)
    return scored[:top_k]
`;

export const DEMO_ENGINES: SiphonedEngine[] = [
  buildUnredactedEngineRecord({
    repo: 'craighckby-stack/V1',
    branch: 'Original',
    filePath: 'src/loop_mutation_gate_engine.ts',
    rawUrl: 'https://raw.githubusercontent.com/craighckby-stack/V1/Original/src/loop_mutation_gate_engine.ts',
    fullCode: V1_LOOP_GATE_ENGINE_CODE,
    repoCommits: V1_COMMITS,
    harvestedAt: '2026-11-18T20:00:00Z',
  }),
  buildUnredactedEngineRecord({
    repo: 'infiniflow/ragflow',
    branch: 'main',
    filePath: 'rag/retrieval/hybrid_rerank_engine.py',
    rawUrl: 'https://raw.githubusercontent.com/infiniflow/ragflow/main/rag/retrieval/hybrid_rerank_engine.py',
    fullCode: RAGFLOW_RETRIEVER_ENGINE_CODE,
    repoCommits: RAGFLOW_COMMITS,
    harvestedAt: '2026-11-18T20:00:00Z',
  }),
];