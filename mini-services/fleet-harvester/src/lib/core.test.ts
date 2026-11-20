import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURATED_PRESETS,
  appendPresetToSources,
  deriveLogPaths,
  matchesRepoFilter,
  parseSources,
  validateDestination,
} from './sources';
import {
  classifyHeuristic,
  compileRegexSafe,
  DEFAULT_FAIL_PATTERN,
  DEFAULT_OK_PATTERN,
  detectRevertedShas,
  reconcileDualVerdicts,
} from './classifier';
import { formatClockTimer, formatDurationMs, formatSplitArchives } from './formatter';
import { DEMO_COMMITS, DEMO_ENGINES } from './demoData';
import {
  buildUnredactedEngineRecord,
  scanEngineAst,
  scoreEngineFilePath,
  selectEngineTreePaths,
} from './engineHarvester';
import { computeAiBatchCooldownMs, computeGitHubCooldown, fetchWithTimeout } from './rateLimiter';
import type { ClassifiedCommit, LlmVerdict } from '../types/git';

test('parseSources normalizes URLs, owner/repo slugs, and usernames without duplicates', () => {
  const parsed = parseSources(
    'torvalds, https://github.com/vercel/next.js.git, vercel/next.js\nhttps://github.com/anthropics/'
  );
  assert.equal(parsed.length, 3);
  assert.deepEqual(
    parsed.map((p) => p.raw),
    ['torvalds', 'vercel/next.js', 'anthropics']
  );
  assert.equal(parsed[0].type, 'owner');
  assert.equal(parsed[1].type, 'repo');
});

test('appendPresetToSources merges additions without duplicating existing entries', () => {
  const merged = appendPresetToSources('vercel/next.js, torvalds', [
    'vercel/next.js',
    'infiniflow/ragflow',
  ]);
  assert.equal(merged, 'vercel/next.js, torvalds, infiniflow/ragflow');
});

test('validateDestination rejects malformed repo, whitespace branch, and trailing slash path', () => {
  assert.doesNotThrow(() =>
    validateDestination('craighckby-stack/V1', 'main', 'memory/commit-history.json')
  );
  assert.throws(() => validateDestination('invalid-repo', 'main', 'memory/log.json'));
  assert.throws(() => validateDestination('owner/repo', 'main branch', 'memory/log.json'));
  assert.throws(() => validateDestination('owner/repo', 'main', 'memory/'));
  assert.throws(() => validateDestination('owner/repo', 'main', '../secret.json'));
});

test('deriveLogPaths produces split successful, failed, and engines file names for each format', () => {
  assert.deepEqual(deriveLogPaths('memory/commit-history.json', 'json'), {
    successful: 'memory/commit-history.successful.json',
    failed: 'memory/commit-history.failed.json',
    engines: 'memory/commit-history.engines.json',
  });
  assert.deepEqual(deriveLogPaths('logs/archive.md', 'markdown'), {
    successful: 'logs/archive.successful.md',
    failed: 'logs/archive.failed.md',
    engines: 'logs/archive.engines.md',
  });
  assert.deepEqual(deriveLogPaths('export', 'csv'), {
    successful: 'export.successful.csv',
    failed: 'export.failed.csv',
    engines: 'export.engines.csv',
  });
});

test('matchesRepoFilter filters repositories case-insensitively', () => {
  assert.equal(matchesRepoFilter('craighckby-stack/V1', ''), true);
  assert.equal(matchesRepoFilter('craighckby-stack/V1', 'v1, ragflow'), true);
  assert.equal(matchesRepoFilter('vercel/next.js', 'v1, ragflow'), false);
});

test('detectRevertedShas catches both explicit SHA revert lines and subject reverts', () => {
  const reverted = detectRevertedShas(DEMO_COMMITS);
  assert.equal(reverted.has('f402a88e712b90c3d4112233445566778899aabb'), true);
  assert.equal(reverted.has('8a4f21c9d03e7b11a5f42d8b2e7e0190c31f44a1'), false);
});

test('classifyHeuristic respects precedence: reverted > ci fail > fail rx > ci pass > ok rx > ambiguous', () => {
  const revertedShas = detectRevertedShas(DEMO_COMMITS);
  const { regex: failRx } = compileRegexSafe(DEFAULT_FAIL_PATTERN, DEFAULT_FAIL_PATTERN);
  const { regex: okRx } = compileRegexSafe(DEFAULT_OK_PATTERN, DEFAULT_OK_PATTERN);

  // Reverted commit whose CI state was unknown -> failed via reverted rule
  const revertedCommit = DEMO_COMMITS.find((c) => c.sha.startsWith('f402a88'))!;
  const resReverted = classifyHeuristic(revertedCommit, { revertedShas, failRx, okRx });
  assert.equal(resReverted.classification, 'failed');
  assert.equal(resReverted.source, 'heuristic:reverted');
  assert.equal(resReverted.needsAi, false);

  // CI failure overrides neutral message
  const ciFailCommit = DEMO_COMMITS.find((c) => c.sha.startsWith('a11844b'))!;
  const resCiFail = classifyHeuristic(ciFailCommit, { revertedShas, failRx, okRx });
  assert.equal(resCiFail.classification, 'failed');
  assert.equal(resCiFail.source, 'heuristic:ci-failed');

  // Ambiguous commit with unknown CI and neutral message -> queued for AI
  const ambigCommit = DEMO_COMMITS.find((c) => c.sha.startsWith('c20911a'))!;
  const resAmbig = classifyHeuristic(ambigCommit, { revertedShas, failRx, okRx });
  assert.equal(resAmbig.needsAi, true);
  assert.equal(resAmbig.confidence, 'low');
});

test('reconcileDualVerdicts upgrades consensus matches and triggers tie-breaker on disagreements', () => {
  const ambigCommit = DEMO_COMMITS.find((c) => c.sha.startsWith('c20911a'))!;
  const heuristic = {
    classification: 'successful' as const,
    confidence: 'low' as const,
    source: 'heuristic:default',
    reason: 'Ambiguous',
    needsAi: true,
  };
  const gemOk: LlmVerdict = {
    sha: ambigCommit.sha,
    classification: 'successful',
    confidence: 'medium',
    reason: 'Clean performance tuning',
    footprint: 'perf',
    model: 'gemini-4-carbon',
  };
  const nvOk: LlmVerdict = {
    sha: ambigCommit.sha,
    classification: 'successful',
    confidence: 'medium',
    reason: 'No regression cues',
    footprint: 'perf',
    model: 'nvidia/nemotron-3.5-bolt-e4b',
  };
  const nvFail: LlmVerdict = {
    sha: ambigCommit.sha,
    classification: 'failed',
    confidence: 'high',
    reason: 'Risky window tweak',
    footprint: 'perf',
    model: 'nvidia/nemotron-3.5-bolt-e4b',
  };

  const aligned = reconcileDualVerdicts(ambigCommit, heuristic, gemOk, nvOk, 'consensus');
  assert.equal(aligned.needsTieBreaker, false);
  assert.equal(aligned.classified.confidence, 'high');
  assert.equal(aligned.classified.source, 'dual-ai:consensus');

  const split = reconcileDualVerdicts(ambigCommit, heuristic, gemOk, nvFail, 'consensus');
  assert.equal(split.needsTieBreaker, true);
  assert.equal(split.classified.source, 'dual-ai:disagreement');

  const resolved = reconcileDualVerdicts(ambigCommit, heuristic, gemOk, nvFail, 'consensus', {
    ...gemOk,
    classification: 'failed',
    reason: 'Tie-breaker confirmed regression risk',
  });
  assert.equal(resolved.needsTieBreaker, false);
  assert.equal(resolved.classified.classification, 'failed');
  assert.equal(resolved.classified.source, 'dual-ai:tie-breaker');
});

test('formatSplitArchives generates valid JSON, Markdown, and escaped CSV for both buckets', () => {
  const sample: ClassifiedCommit[] = [
    {
      ...DEMO_COMMITS[0],
      classification: 'successful',
      confidence: 'high',
      source: 'heuristic:ci-passed',
      reason: 'CI passed',
      footprint: 'feat (sync)',
    },
    {
      ...DEMO_COMMITS[1],
      classification: 'failed',
      confidence: 'high',
      source: 'heuristic:ci-failed',
      reason: 'CI failed, "broken"',
      footprint: 'wip',
    },
  ];

  const jsonOut = formatSplitArchives(sample, 'json', { includeEmails: false });
  assert.equal(jsonOut.successfulCount, 1);
  assert.equal(jsonOut.failedCount, 1);
  const parsedOk = JSON.parse(jsonOut.successful);
  assert.equal(parsedOk.commits[0].authorEmail, undefined);

  const csvOut = formatSplitArchives(sample, 'csv', { includeEmails: true });
  assert.match(csvOut.failed, /"CI failed, ""broken"""/);

  const mdOut = formatSplitArchives(sample, 'markdown', { includeEmails: false });
  assert.match(mdOut.successful, /# Successful Commit Archive/);
  assert.match(mdOut.failed, /# Failed \/ Regression Commit Archive/);
});

test('computeGitHubCooldown applies polite pacing and rate-limit recovery waits', () => {
  const authHealthy = computeGitHubCooldown({
    status: 200,
    remainingHeader: '4900',
    resetHeader: null,
    retryAfterHeader: null,
    isAuthenticated: true,
  });
  assert.equal(authHealthy.waitMs, 180);
  assert.equal(authHealthy.shouldRetry, false);

  const unauthHealthy = computeGitHubCooldown({
    status: 200,
    remainingHeader: '55',
    resetHeader: null,
    retryAfterHeader: null,
    isAuthenticated: true,
  });
  assert.equal(unauthHealthy.waitMs, 450);

  const lowQuota = computeGitHubCooldown({
    status: 200,
    remainingHeader: '12',
    resetHeader: null,
    retryAfterHeader: null,
    isAuthenticated: true,
  });
  assert.equal(lowQuota.waitMs, 1500);

  const retryAfter = computeGitHubCooldown({
    status: 429,
    remainingHeader: '0',
    resetHeader: null,
    retryAfterHeader: '6',
    isAuthenticated: true,
  });
  assert.equal(retryAfter.shouldRetry, true);
  assert.equal(retryAfter.waitMs, 6250);

  const longWait = computeGitHubCooldown({
    status: 403,
    remainingHeader: '0',
    resetHeader: String(Math.floor(Date.now() / 1000) + 600),
    retryAfterHeader: null,
    isAuthenticated: false,
  });
  assert.equal(longWait.shouldRetry, false);
  assert.ok(longWait.fatalError);
});

test('computeAiBatchCooldownMs enforces inter-batch and exponential retry backoff', () => {
  assert.equal(computeAiBatchCooldownMs(0), 1200);
  assert.equal(computeAiBatchCooldownMs(1), 2500);
  assert.equal(computeAiBatchCooldownMs(2), 5000);
  assert.equal(computeAiBatchCooldownMs(1, 7), 7300);
});

test('reconcileDualVerdicts supports gemini-3.1-flash-lite backup verdicts cleanly', () => {
  const ambigCommit = DEMO_COMMITS.find((c) => c.sha.startsWith('c20911a'))!;
  const heuristic = {
    classification: 'successful' as const,
    confidence: 'low' as const,
    source: 'heuristic:default',
    reason: 'Ambiguous',
    needsAi: true,
  };
  const liteVerdict: LlmVerdict = {
    sha: ambigCommit.sha,
    classification: 'successful',
    confidence: 'medium',
    reason: 'Telemetry interval adjustment without regression cues',
    footprint: 'perf',
    model: 'gemini-3.1-flash-lite',
  };

  const singleBackup = reconcileDualVerdicts(ambigCommit, heuristic, liteVerdict, undefined, 'gemini_only');
  assert.equal(singleBackup.classified.source, 'ai:gemini-3.1-flash-lite');
  assert.equal(singleBackup.classified.classification, 'successful');
});

test('CURATED_PRESETS contains all 23 unique curated GitHub sources including expanded RAG repos', () => {
  assert.equal(CURATED_PRESETS.length, 23);
  const values = CURATED_PRESETS.map((p) => p.value);
  assert.equal(new Set(values).size, 23);
  for (const expected of [
    'IBM/mcp-context-forge',
    'deepseek-ai/DeepSeek-V3',
    'google-deepmind/deepmind-research',
    'trekhleb/javascript-algorithms',
    'firebase/firebase-js-sdk',
    'langchain-ai/langchain',
    'run-llama/llama_index',
    'langgenius/dify',
    'open-webui/open-webui',
    'Mintplex-Labs/anything-llm',
    'FlowiseAI/Flowise',
    'HKUDS/LightRAG',
    'deepset-ai/haystack',
  ]) {
    assert.ok(values.includes(expected), `Missing preset: ${expected}`);
  }
});

test('formatClockTimer and formatDurationMs format active and completed durations cleanly', () => {
  assert.equal(formatClockTimer(0), '00:00');
  assert.equal(formatClockTimer(9500), '00:09');
  assert.equal(formatClockTimer(125000), '02:05');
  assert.equal(formatClockTimer(3661000), '1:01:01');
  assert.equal(formatDurationMs(420), '420ms');
  assert.equal(formatDurationMs(4860), '4.9s');
  assert.equal(formatDurationMs(74000), '1m 14s');
});

test('selectEngineTreePaths filters tests/dist/minified and prioritizes core runtime engines', () => {
  const tree = [
    { path: 'node_modules/pkg/engine.ts', type: 'blob', size: 12000 },
    { path: 'src/engine/loop_engine.test.ts', type: 'blob', size: 8000 },
    { path: 'docs/architecture.md', type: 'blob', size: 4000 },
    { path: 'dist/loop_kernel.min.js', type: 'blob', size: 18000 },
    { path: 'src/core/loop_execution_engine.ts', type: 'blob', size: 14000 },
    { path: 'rag/retrieval/hybrid_rerank_engine.py', type: 'blob', size: 9200 },
  ];

  assert.equal(scoreEngineFilePath('node_modules/pkg/engine.ts', 12000), 0);
  assert.equal(scoreEngineFilePath('src/engine/loop_engine.test.ts', 8000), 0);
  assert.equal(scoreEngineFilePath('dist/loop_kernel.min.js', 18000), 0);

  const selected = selectEngineTreePaths(tree, 5);
  assert.equal(selected.length, 2);
  assert.deepEqual(
    selected.map((n) => n.path).sort(),
    ['rag/retrieval/hybrid_rerank_engine.py', 'src/core/loop_execution_engine.ts']
  );
});

test('buildUnredactedEngineRecord preserves 100% verbatim full source with AST symbols and linked commits', () => {
  // Construct source > 2,500 chars with realistic vendor identifiers (deepseek, openai) to prove zero redaction/truncation
  const fillerComments = Array.from({ length: 45 }, (_, i) => `  // deepseek + loop telemetry step ${i}`).join('\n');
  const fullSource = [
    `import { orchestrate } from './orchestrator';`,
    `import { callDeepSeekModel } from './vendors/deepseek';`,
    ``,
    `export class LoopMutationEngine {`,
    `  public async executeCycle(input: string): Promise<string> {`,
    fillerComments,
    `    return callDeepSeekModel(orchestrate(input));`,
    `  }`,
    `}`,
    ``,
    `export function verifyLoopEngineIntegrity(code: string): boolean {`,
    `  return code.includes('END_OF_UNREDACTED_ENGINE_MARKER');`,
    `}`,
    `// END_OF_UNREDACTED_ENGINE_MARKER`,
  ].join('\n');

  assert.ok(fullSource.length > 2000);

  const ast = scanEngineAst(fullSource, 'src/core/loop_mutation_engine.ts');
  assert.equal(ast.language, 'TypeScript');
  assert.equal(ast.role, 'agent-loop');
  assert.ok(ast.classNames.includes('LoopMutationEngine'));
  assert.ok(ast.functionNames.includes('verifyLoopEngineIntegrity'));
  assert.ok(ast.imports.includes('./vendors/deepseek'));

  const record = buildUnredactedEngineRecord({
    repo: 'craighckby-stack/V1',
    branch: 'Original',
    filePath: 'src/core/loop_mutation_engine.ts',
    rawUrl: 'https://raw.githubusercontent.com/craighckby-stack/V1/Original/src/core/loop_mutation_engine.ts',
    fullCode: fullSource,
    repoCommits: [
      {
        sha: 'abc1234567890',
        repo: 'craighckby-stack/V1',
        isPrivate: false,
        branches: ['Original'],
        message: 'feat: harden LoopMutationEngine retry handling',
        authorName: 'Craig H.',
        date: '2026-10-15T10:00:00Z',
      },
    ],
  });

  assert.equal(record.redacted, false);
  assert.equal(record.fullCode, fullSource);
  assert.ok(record.fullCode.includes('callDeepSeekModel'));
  assert.ok(record.fullCode.includes('END_OF_UNREDACTED_ENGINE_MARKER'));
  assert.deepEqual(record.relatedCommitShas, ['abc1234567890']);
});

test('formatSplitArchives exports full unredacted engines and LOOP summary across JSON, Markdown, and CSV', () => {
  const sampleCommits: ClassifiedCommit[] = [
    {
      ...DEMO_COMMITS[0],
      classification: 'successful',
      confidence: 'high',
      source: 'heuristic:ci-passed',
      reason: 'CI passed',
      footprint: 'feat (sync)',
    },
    {
      ...DEMO_COMMITS[1],
      classification: 'failed',
      confidence: 'high',
      source: 'heuristic:ci-failed',
      reason: 'CI failed',
      footprint: 'wip',
    },
  ];

  const jsonOut = formatSplitArchives(sampleCommits, 'json', { includeEmails: false }, DEMO_ENGINES);
  assert.equal(jsonOut.enginesCount, 2);
  const parsedEngines = JSON.parse(jsonOut.engines);
  assert.equal(parsedEngines.redacted, false);
  assert.equal(parsedEngines.engines.length, 2);
  assert.equal(parsedEngines.engines[0].fullCode, DEMO_ENGINES[0].fullCode);
  assert.equal(parsedEngines.loopMemory.failedCount, 1);

  const mdOut = formatSplitArchives(sampleCommits, 'markdown', { includeEmails: false }, DEMO_ENGINES);
  assert.match(mdOut.engines, /Redacted: false/);
  assert.ok(mdOut.engines.includes(DEMO_ENGINES[0].fullCode));
  assert.ok(mdOut.engines.includes(DEMO_ENGINES[1].fullCode));

  const csvOut = formatSplitArchives(sampleCommits, 'csv', { includeEmails: false }, DEMO_ENGINES);
  assert.ok(csvOut.engines.includes('LoopMutationGateEngine'));
  assert.ok(csvOut.engines.includes('hybrid_rerank_fusion'));
});

test('computeGitHubCooldown retries headerless HTTP 403 secondary rate limits cleanly', () => {
  const sec403 = computeGitHubCooldown({
    status: 403,
    remainingHeader: '4120',
    resetHeader: null,
    retryAfterHeader: null,
    isAuthenticated: true,
  });
  assert.equal(sec403.shouldRetry, true);
  assert.equal(sec403.waitMs, 8000);
});

test('fetchWithTimeout aborts hung fetches instead of hanging forever', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchWithTimeout('https://example.invalid/hung', {}, 50),
      /Request timed out/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('detectRevertedShas handles 10,000 commits quickly via prefix indexing', () => {
  const hugeList = Array.from({ length: 10_000 }, (_, i) => ({
    sha: i.toString(16).padStart(40, '0'),
    repo: 'org/huge',
    isPrivate: false,
    branches: ['main'],
    message: i === 500 ? `Revert "fix"\n\nThis reverts commit ${(42).toString(16).padStart(40, '0')}.` : `chore: step ${i}`,
    authorName: 'Dev',
    date: '2026-11-01T00:00:00Z',
  }));
  const started = Date.now();
  const reverted = detectRevertedShas(hugeList);
  const elapsed = Date.now() - started;
  assert.equal(reverted.has((42).toString(16).padStart(40, '0')), true);
  assert.ok(elapsed < 1000, `Expected <1000ms for 10k commits, took ${elapsed}ms`);
});



