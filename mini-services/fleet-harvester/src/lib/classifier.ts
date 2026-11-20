import type {
  AiStrategy,
  ClassifiedCommit,
  HeuristicResult,
  LlmVerdict,
  RawCommit,
} from '../types/git';

export const DEFAULT_FAIL_PATTERN =
  '\\b(wip|broken|breaks?|failed|failing|rejected|rolled back|rollback|regression|does not work)\\b';
export const DEFAULT_OK_PATTERN = '\\b(accepted|passed|improved|verified)\\b';

export function compileRegexSafe(
  pattern: string,
  fallback: string
): { regex: RegExp; error?: string } {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return { regex: new RegExp(fallback, 'i') };
  }
  try {
    return { regex: new RegExp(trimmed, 'i') };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid regular expression';
    return { regex: new RegExp(fallback, 'i'), error: message };
  }
}

/**
 * Detects SHAs (full or 7+ char prefixes) referenced in revert commits so the original commit
 * is flagged as reverted later.
 */
export function detectRevertedShas(commits: RawCommit[]): Set<string> {
  const reverted = new Set<string>();
  const prefixToShas = new Map<string, string[]>();
  const subjectToShas = new Map<string, string[]>();

  for (const commit of commits) {
    const lowerSha = commit.sha.toLowerCase();
    const prefix7 = lowerSha.slice(0, 7);
    const shaList = prefixToShas.get(prefix7) ?? [];
    shaList.push(lowerSha);
    prefixToShas.set(prefix7, shaList);

    const subject = commit.message.split('\n')[0].trim().toLowerCase();
    const list = subjectToShas.get(subject) ?? [];
    list.push(lowerSha);
    subjectToShas.set(subject, list);
  }

  const revertLineRx = /This reverts commit ([0-9a-f]{7,40})/gi;
  const revertHeaderRx = /^\s*Revert\s+"([^"]+)"/i;

  for (const commit of commits) {
    let match: RegExpExecArray | null;
    revertLineRx.lastIndex = 0;
    while ((match = revertLineRx.exec(commit.message)) !== null) {
      const refSha = match[1].toLowerCase();
      const candidates = prefixToShas.get(refSha.slice(0, 7));
      if (candidates) {
        for (const fullSha of candidates) {
          if (fullSha.startsWith(refSha)) {
            reverted.add(fullSha);
          }
        }
      }
    }

    const headerMatch = revertHeaderRx.exec(commit.message);
    if (headerMatch) {
      const revertedSubject = headerMatch[1].trim().toLowerCase();
      const targets = subjectToShas.get(revertedSubject);
      if (targets) {
        const selfSha = commit.sha.toLowerCase();
        for (const t of targets) {
          if (t !== selfSha) {
            reverted.add(t);
          }
        }
      }
    }
  }

  return reverted;
}

/**
 * Precedence:
 * 1. Reverted later -> failed (high)
 * 2. CI failed -> failed (high)
 * 3. Failure regex match -> failed (high)
 * 4. CI passed -> successful (high)
 * 5. Success regex match -> successful (high)
 * 6. Ambiguous -> needsAi = true (default tentative successful, low confidence)
 */
export function classifyHeuristic(
  commit: RawCommit,
  options: {
    revertedShas: Set<string>;
    failRx: RegExp;
    okRx: RegExp;
  }
): HeuristicResult {
  const shaLower = commit.sha.toLowerCase();

  if (options.revertedShas.has(shaLower)) {
    return {
      classification: 'failed',
      confidence: 'high',
      source: 'heuristic:reverted',
      reason: 'Commit was later reverted in repository history.',
      needsAi: false,
    };
  }

  if (commit.ciState === 'failure') {
    return {
      classification: 'failed',
      confidence: 'high',
      source: 'heuristic:ci-failed',
      reason: 'Associated CI check suite or status reported failure.',
      needsAi: false,
    };
  }

  if (options.failRx.test(commit.message)) {
    return {
      classification: 'failed',
      confidence: 'high',
      source: 'heuristic:regex-fail',
      reason: 'Commit message matched failure keyword pattern.',
      needsAi: false,
    };
  }

  if (commit.ciState === 'success') {
    return {
      classification: 'successful',
      confidence: 'high',
      source: 'heuristic:ci-passed',
      reason: 'Associated CI checks passed.',
      needsAi: false,
    };
  }

  if (options.okRx.test(commit.message)) {
    return {
      classification: 'successful',
      confidence: 'high',
      source: 'heuristic:regex-ok',
      reason: 'Commit message matched explicit acceptance/verification pattern.',
      needsAi: false,
    };
  }

  return {
    classification: 'successful',
    confidence: 'low',
    source: 'heuristic:default',
    reason: 'No explicit heuristic failure/CI signal; queued for AI classification.',
    needsAi: true,
  };
}

export interface ReconcileResult {
  classified: ClassifiedCommit;
  needsTieBreaker: boolean;
}

/**
 * Reconciles heuristic baseline with Gemini and/or NVIDIA verdicts under the chosen strategy.
 */
export function reconcileDualVerdicts(
  commit: RawCommit,
  heuristic: HeuristicResult,
  geminiVerdict: LlmVerdict | undefined,
  nvidiaVerdict: LlmVerdict | undefined,
  strategy: AiStrategy,
  tieBreakerVerdict?: LlmVerdict
): ReconcileResult {
  const defaultFootprint = summarizeFootprint(commit.message);

  if (!heuristic.needsAi) {
    return {
      classified: {
        ...commit,
        classification: heuristic.classification,
        confidence: heuristic.confidence,
        source: heuristic.source,
        reason: heuristic.reason,
        footprint: defaultFootprint,
      },
      needsTieBreaker: false,
    };
  }

  if (tieBreakerVerdict) {
    return {
      classified: {
        ...commit,
        classification: tieBreakerVerdict.classification,
        confidence: 'high',
        source: 'dual-ai:tie-breaker',
        reason: `Tie-breaker escalation (${tieBreakerVerdict.model}): ${tieBreakerVerdict.reason}`,
        footprint: tieBreakerVerdict.footprint || defaultFootprint,
        geminiVerdict,
        nvidiaVerdict,
        escalatedTieBreaker: true,
      },
      needsTieBreaker: false,
    };
  }

  if (geminiVerdict && nvidiaVerdict) {
    if (geminiVerdict.classification === nvidiaVerdict.classification) {
      return {
        classified: {
          ...commit,
          classification: geminiVerdict.classification,
          confidence: 'high',
          source: strategy === 'specialist' ? 'dual-ai:specialist-aligned' : 'dual-ai:consensus',
          reason: `Consensus (${geminiVerdict.model} + ${nvidiaVerdict.model}): ${geminiVerdict.reason}`,
          footprint: geminiVerdict.footprint || nvidiaVerdict.footprint || defaultFootprint,
          geminiVerdict,
          nvidiaVerdict,
        },
        needsTieBreaker: false,
      };
    }

    // Disagreement between Gemini and NVIDIA
    if (strategy === 'consensus') {
      return {
        classified: {
          ...commit,
          classification: geminiVerdict.classification,
          confidence: 'medium',
          source: 'dual-ai:disagreement',
          reason: `Split verdict (Gemini=${geminiVerdict.classification}, NVIDIA=${nvidiaVerdict.classification}) awaiting tie-breaker.`,
          footprint: geminiVerdict.footprint || nvidiaVerdict.footprint || defaultFootprint,
          geminiVerdict,
          nvidiaVerdict,
        },
        needsTieBreaker: true,
      };
    }

    // Specialist split: NVIDIA failure signal overrides low-confidence success if high confidence
    const preferNvidia =
      nvidiaVerdict.classification === 'failed' && nvidiaVerdict.confidence === 'high';
    const chosen = preferNvidia ? nvidiaVerdict : geminiVerdict;
    return {
      classified: {
        ...commit,
        classification: chosen.classification,
        confidence: 'medium',
        source: 'dual-ai:specialist-split',
        reason: `Specialist resolution (${chosen.model}): ${chosen.reason}`,
        footprint: chosen.footprint || defaultFootprint,
        geminiVerdict,
        nvidiaVerdict,
      },
      needsTieBreaker: false,
    };
  }

  if (geminiVerdict) {
    return {
      classified: {
        ...commit,
        classification: geminiVerdict.classification,
        confidence: geminiVerdict.confidence,
        source: `ai:${geminiVerdict.model}`,
        reason: geminiVerdict.reason,
        footprint: geminiVerdict.footprint || defaultFootprint,
        geminiVerdict,
      },
      needsTieBreaker: false,
    };
  }

  if (nvidiaVerdict) {
    return {
      classified: {
        ...commit,
        classification: nvidiaVerdict.classification,
        confidence: nvidiaVerdict.confidence,
        source: `ai:${nvidiaVerdict.model}`,
        reason: nvidiaVerdict.reason,
        footprint: nvidiaVerdict.footprint || defaultFootprint,
        nvidiaVerdict,
      },
      needsTieBreaker: false,
    };
  }

  return {
    classified: {
      ...commit,
      classification: heuristic.classification,
      confidence: heuristic.confidence,
      source: heuristic.source,
      reason: heuristic.reason,
      footprint: defaultFootprint,
    },
    needsTieBreaker: false,
  };
}

export function summarizeFootprint(message: string): string {
  const firstLine = message.split('\n')[0].trim();
  const match = /^([a-zA-Z0-9_-]+)(\([^)]+\))?:\s*(.+)$/.exec(firstLine);
  if (match) {
    const scope = match[2] ? ` ${match[2]}` : '';
    return `${match[1].toLowerCase()}${scope}`;
  }
  if (/fix|bug|patch|hotfix|race/i.test(firstLine)) return 'bugfix';
  if (/feat|add|implement|support/i.test(firstLine)) return 'feature';
  if (/refactor|clean|rename|format/i.test(firstLine)) return 'refactor';
  if (/doc|readme|comment/i.test(firstLine)) return 'docs';
  if (/test|spec|ci|workflow/i.test(firstLine)) return 'ci-test';
  return 'chore';
}
