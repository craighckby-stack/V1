export type ClassificationOutcome = 'successful' | 'failed';
export type LogBucket = ClassificationOutcome | 'engines';
export type BranchScope = 'all' | 'default' | 'first';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type AiStrategy = 'consensus' | 'specialist' | 'gemini_only' | 'nvidia_only';
export type ArchiveFormat = 'json' | 'markdown' | 'csv';
export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface GitHubUser {
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
  public_repos?: number;
  total_private_repos?: number;
}

export interface RepoSummary {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  fork: boolean;
  default_branch: string;
  html_url?: string;
}

export type CiState = 'success' | 'failure' | 'pending' | 'unknown';

export interface RawCommit {
  sha: string;
  repo: string;
  isPrivate: boolean;
  branches: string[];
  message: string;
  authorName: string;
  authorLogin?: string;
  authorEmail?: string;
  date: string;
  htmlUrl?: string;
  ciState?: CiState;
}

export interface LlmVerdict {
  sha: string;
  classification: ClassificationOutcome;
  confidence: ConfidenceLevel;
  reason: string;
  footprint: string;
  model: string;
}

export interface HeuristicResult {
  classification: ClassificationOutcome;
  confidence: ConfidenceLevel;
  source: string;
  reason: string;
  needsAi: boolean;
}

export interface ClassifiedCommit extends RawCommit {
  classification: ClassificationOutcome;
  confidence: ConfidenceLevel;
  source: string;
  reason: string;
  footprint: string;
  geminiVerdict?: LlmVerdict;
  nvidiaVerdict?: LlmVerdict;
  escalatedTieBreaker?: boolean;
}

export type EngineRole =
  | 'agent-loop'
  | 'rag-retrieval'
  | 'orchestrator'
  | 'execution-sandbox'
  | 'memory-state'
  | 'router-gateway'
  | 'core-runtime';

export interface SiphonedEngine {
  id: string;
  repo: string;
  branch: string;
  treeSha?: string;
  filePath: string;
  rawUrl: string;
  language: string;
  role: EngineRole;
  byteSize: number;
  lineCount: number;
  classNames: string[];
  functionNames: string[];
  imports: string[];
  relatedCommitShas: string[];
  redacted: false;
  fullCode: string;
  harvestedAt: string;
}

export interface ActivityEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface FetchStats {
  reposScanned: number;
  reposTotal: number;
  branchesScanned: number;
  uniqueCommits: number;
  enginesSiphoned: number;
  combinedBytes: number;
}

export interface ActiveTaskTimer {
  label: string;
  detail?: string;
  runStartedAt: number;
  itemStartedAt: number;
}

export interface ToastItem {
  id: string;
  message: string;
  variant: 'info' | 'success' | 'warning' | 'error';
}

export interface ExtractionSettings {
  authorFilter: string;
  sources: string;
  extAuthor: string;
  repoFilter: string;
  sinceDate: string;
  untilDate: string;
  branchScope: BranchScope;
  siphonEngines: boolean;
  includePrivate: boolean;
  includeForks: boolean;
  skipOwn: boolean;
  includeEmails: boolean;
  includeMine: boolean;
  ciLookup: boolean;
  failRx: string;
  okRx: string;
  aiStrategy: AiStrategy;
  useGemini: boolean;
  useGeminiBackup: boolean;
  useLlm: boolean;
  nvKey: string;
  nvModel: string;
  nvEndpoint: string;
  nvPrivate: boolean;
}

export interface DestinationSettings {
  targetRepo: string;
  targetBranch: string;
  targetPath: string;
  fileFormat: ArchiveFormat;
  autoCreateRepo: boolean;
}
