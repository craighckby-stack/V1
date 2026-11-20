import type { ArchiveFormat, ClassifiedCommit, SiphonedEngine } from '../types/git';

export interface SplitArchiveOutputs {
  successful: string;
  failed: string;
  engines: string;
  successfulCount: number;
  failedCount: number;
  enginesCount: number;
  combinedBytes: number;
}

export interface LoopSynthesisSummary {
  totalCommits: number;
  successfulCount: number;
  failedCount: number;
  enginesCount: number;
  provenPatterns: Array<{ repo: string; sha: string; footprint: string; summary: string }>;
  regressionGuards: Array<{ repo: string; sha: string; footprint: string; reason: string }>;
}

/**
 * Synthesizes LOOP-compatible procedural memory guards from classified commits and siphoned engines.
 */
export function synthesizeLoopSummary(
  commits: ClassifiedCommit[],
  engines: SiphonedEngine[]
): LoopSynthesisSummary {
  const ok = commits.filter((c) => c.classification === 'successful');
  const bad = commits.filter((c) => c.classification === 'failed');

  return {
    totalCommits: commits.length,
    successfulCount: ok.length,
    failedCount: bad.length,
    enginesCount: engines.length,
    provenPatterns: ok.slice(0, 12).map((c) => ({
      repo: c.repo,
      sha: c.sha.slice(0, 7),
      footprint: c.footprint,
      summary: c.message.split('\n')[0].trim(),
    })),
    regressionGuards: bad.slice(0, 12).map((c) => ({
      repo: c.repo,
      sha: c.sha.slice(0, 7),
      footprint: c.footprint,
      reason: c.reason,
    })),
  };
}

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r?\n/g, ' ');
  if (/[",]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

/**
 * Escapes CSV cells while preserving exact newlines inside unredacted full source code.
 */
function escapeCsvPreserveMultiline(value: string): string {
  if (/[\r\n",]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatJsonLog(
  commits: ClassifiedCommit[],
  label: 'successful' | 'failed',
  generatedAt: string,
  includeEmails: boolean
): string {
  const records = commits.map((c) => {
    const base: Record<string, unknown> = {
      sha: c.sha,
      repo: c.repo,
      branches: c.branches,
      date: c.date,
      authorName: c.authorName,
      ...(c.authorLogin ? { authorLogin: c.authorLogin } : {}),
      ...(includeEmails && c.authorEmail ? { authorEmail: c.authorEmail } : {}),
      classification: c.classification,
      confidence: c.confidence,
      source: c.source,
      footprint: c.footprint,
      reason: c.reason,
      message: c.message,
      ...(c.htmlUrl ? { url: c.htmlUrl } : {}),
    };
    return base;
  });

  return JSON.stringify(
    {
      schema: 'githistory-sync/v3',
      bucket: label,
      generatedAt,
      count: records.length,
      commits: records,
    },
    null,
    2
  );
}

function formatJsonEnginesLog(
  engines: SiphonedEngine[],
  commits: ClassifiedCommit[],
  generatedAt: string
): string {
  const loopSummary = synthesizeLoopSummary(commits, engines);
  return JSON.stringify(
    {
      schema: 'githistory-sync/engines-v1',
      bucket: 'engines',
      redacted: false,
      generatedAt,
      count: engines.length,
      loopMemory: loopSummary,
      engines: engines.map((e) => ({
        id: e.id,
        repo: e.repo,
        branch: e.branch,
        ...(e.treeSha ? { treeSha: e.treeSha } : {}),
        filePath: e.filePath,
        rawUrl: e.rawUrl,
        language: e.language,
        role: e.role,
        byteSize: e.byteSize,
        lineCount: e.lineCount,
        classNames: e.classNames,
        functionNames: e.functionNames,
        imports: e.imports,
        relatedCommitShas: e.relatedCommitShas,
        redacted: false,
        harvestedAt: e.harvestedAt,
        fullCode: e.fullCode,
      })),
    },
    null,
    2
  );
}

function formatMarkdownLog(
  commits: ClassifiedCommit[],
  label: 'successful' | 'failed',
  generatedAt: string,
  includeEmails: boolean
): string {
  const title = label === 'successful' ? 'Successful Commit Archive' : 'Failed / Regression Commit Archive';
  const lines: string[] = [
    `# ${title}`,
    '',
    `- Generated: ${generatedAt}`,
    `- Total Commits: ${commits.length}`,
    '',
    '| Date | Repo | Branches | SHA | Footprint | Confidence | Source | Author | Summary | Reason |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const c of commits) {
    const subject = c.message.split('\n')[0].replace(/\|/g, '\\|').trim();
    const reason = c.reason.replace(/\|/g, '\\|').trim();
    const author =
      includeEmails && c.authorEmail ? `${c.authorName} <${c.authorEmail}>` : c.authorName;
    lines.push(
      `| ${c.date.slice(0, 10)} | ${c.repo} | ${c.branches.join(', ')} | \`${c.sha.slice(0, 7)}\` | ${c.footprint} | ${c.confidence} | ${c.source} | ${author.replace(/\|/g, '\\|')} | ${subject} | ${reason} |`
    );
  }

  return lines.join('\n') + '\n';
}

function mdFenceLang(language: string): string {
  const lower = language.toLowerCase();
  if (lower === 'typescript') return 'ts';
  if (lower === 'javascript') return 'js';
  if (lower === 'python') return 'python';
  if (lower === 'go') return 'go';
  if (lower === 'rust') return 'rust';
  return '';
}

function formatMarkdownEnginesLog(
  engines: SiphonedEngine[],
  commits: ClassifiedCommit[],
  generatedAt: string
): string {
  const summary = synthesizeLoopSummary(commits, engines);
  const lines: string[] = [
    '# Full Unredacted Engine Archive & LOOP Synthesis',
    '',
    `- Generated: ${generatedAt}`,
    `- Total Engines: ${engines.length}`,
    `- Redacted: false (100% verbatim full source preserved)`,
    `- Commit Corpus: ${summary.successfulCount} successful · ${summary.failedCount} regression guards`,
    '',
  ];

  if (summary.regressionGuards.length > 0) {
    lines.push('## LOOP Regression Guards (from Failed Commits)', '');
    for (const guard of summary.regressionGuards.slice(0, 6)) {
      lines.push(`- **${guard.repo}** \`${guard.sha}\` [${guard.footprint}]: ${guard.reason}`);
    }
    lines.push('');
  }

  for (const engine of engines) {
    const langTag = mdFenceLang(engine.language);
    // Use a 4-backtick or longer fence if source contains triple backticks
    const fence = engine.fullCode.includes('````')
      ? '`````'
      : engine.fullCode.includes('```')
        ? '````'
        : '```';

    lines.push(
      `## ${engine.repo} — \`${engine.filePath}\``,
      '',
      `- Branch: \`${engine.branch}\` · Language: \`${engine.language}\` · Role: \`${engine.role}\``,
      `- Size: ${engine.lineCount} lines (${engine.byteSize} bytes) · Redacted: \`false\``,
      `- Classes: ${engine.classNames.length > 0 ? engine.classNames.join(', ') : 'none'}`,
      `- Functions: ${engine.functionNames.length > 0 ? engine.functionNames.join(', ') : 'none'}`,
      `- Imports: ${engine.imports.length > 0 ? engine.imports.slice(0, 16).join(', ') : 'none'}`,
      `- Linked Commits: ${engine.relatedCommitShas.length > 0 ? engine.relatedCommitShas.map((s) => `\`${s.slice(0, 7)}\``).join(', ') : 'none'}`,
      `- Raw Source: ${engine.rawUrl}`,
      '',
      `${fence}${langTag}`,
      engine.fullCode,
      fence,
      ''
    );
  }

  return lines.join('\n') + '\n';
}

function formatCsvLog(commits: ClassifiedCommit[], includeEmails: boolean): string {
  const headers = [
    'sha',
    'repo',
    'branches',
    'date',
    'author_name',
    ...(includeEmails ? ['author_email'] : []),
    'classification',
    'confidence',
    'source',
    'footprint',
    'reason',
    'message',
  ];
  const rows = [headers.join(',')];

  for (const c of commits) {
    const cells = [
      c.sha,
      c.repo,
      c.branches.join(';'),
      c.date,
      c.authorName,
      ...(includeEmails ? [c.authorEmail ?? ''] : []),
      c.classification,
      c.confidence,
      c.source,
      c.footprint,
      c.reason,
      c.message,
    ].map((cell) => escapeCsvCell(String(cell)));
    rows.push(cells.join(','));
  }

  return rows.join('\n') + '\n';
}

function formatCsvEnginesLog(engines: SiphonedEngine[]): string {
  const headers = [
    'id',
    'repo',
    'branch',
    'file_path',
    'language',
    'role',
    'line_count',
    'byte_size',
    'redacted',
    'classes',
    'functions',
    'imports',
    'related_commit_shas',
    'raw_url',
    'full_code',
  ];
  const rows = [headers.join(',')];

  for (const e of engines) {
    const cells = [
      escapeCsvCell(e.id),
      escapeCsvCell(e.repo),
      escapeCsvCell(e.branch),
      escapeCsvCell(e.filePath),
      escapeCsvCell(e.language),
      escapeCsvCell(e.role),
      String(e.lineCount),
      String(e.byteSize),
      'false',
      escapeCsvCell(e.classNames.join(';')),
      escapeCsvCell(e.functionNames.join(';')),
      escapeCsvCell(e.imports.join(';')),
      escapeCsvCell(e.relatedCommitShas.join(';')),
      escapeCsvCell(e.rawUrl),
      escapeCsvPreserveMultiline(e.fullCode),
    ];
    rows.push(cells.join(','));
  }

  return rows.join('\n') + '\n';
}

export function formatSplitArchives(
  commits: ClassifiedCommit[],
  format: ArchiveFormat,
  options: { includeEmails: boolean; generatedAt?: string },
  engines: SiphonedEngine[] = []
): SplitArchiveOutputs {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const successfulCommits = commits.filter((c) => c.classification === 'successful');
  const failedCommits = commits.filter((c) => c.classification === 'failed');

  let successful = '';
  let failed = '';
  let enginesOutput = '';

  if (format === 'json') {
    successful = formatJsonLog(successfulCommits, 'successful', generatedAt, options.includeEmails);
    failed = formatJsonLog(failedCommits, 'failed', generatedAt, options.includeEmails);
    enginesOutput = formatJsonEnginesLog(engines, commits, generatedAt);
  } else if (format === 'markdown') {
    successful = formatMarkdownLog(successfulCommits, 'successful', generatedAt, options.includeEmails);
    failed = formatMarkdownLog(failedCommits, 'failed', generatedAt, options.includeEmails);
    enginesOutput = formatMarkdownEnginesLog(engines, commits, generatedAt);
  } else {
    successful = formatCsvLog(successfulCommits, options.includeEmails);
    failed = formatCsvLog(failedCommits, options.includeEmails);
    enginesOutput = formatCsvEnginesLog(engines);
  }

  const encoder = new TextEncoder();
  const combinedBytes =
    encoder.encode(successful).length +
    encoder.encode(failed).length +
    (engines.length > 0 ? encoder.encode(enginesOutput).length : 0);

  return {
    successful,
    failed,
    engines: enginesOutput,
    successfulCount: successfulCommits.length,
    failedCount: failedCommits.length,
    enginesCount: engines.length,
    combinedBytes,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export function formatDurationMs(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  if (safe < 1000) return `${safe}ms`;
  const totalSec = safe / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.floor(totalSec % 60);
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${String(remMins).padStart(2, '0')}m`;
}

export function formatClockTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
