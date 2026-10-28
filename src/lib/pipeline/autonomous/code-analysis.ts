/**
 * Parser-aware source analysis — the shared "truth layer" for the loop's
 * mechanical gates.
 *
 * Why this module exists (audit 2, "confirmed by running the code"):
 * the old checks counted RAW characters:
 *   - detectTruncation counted raw open/close braces and block-comment
 *     delimiters, so valid files whose imbalance lived inside string
 *     literals or regexes (structural-validator.ts: 34 vs 35 braces inside
 *     strings) were rejected as "truncated" on every attempt — and each
 *     false rejection recorded a postmortem claiming "the LLM hit its
 *     output token limit", which was then fed into the NEXT prompt as a
 *     constraint.
 *   - extractExports stripped comments BEFORE strings, so a `"http://..."`
 *     inside a string literal lost the rest of its line to the line-comment
 *     regex; the string regex then paired quotes across lines and swallowed
 *     real `export` declarations (sanitizer.ts's `sanitizeAndGovern` went
 *     missing from the list the test-writer is told is EXACT).
 *   - isCosmeticChange / halt.normalizeCode had the same `//`-in-string
 *     blindness, so `"https://old.example"` → `"https://new.example"`
 *     normalized as a zero-diff.
 *
 * All of these are instances of ONE bug: regexes guessing at TypeScript
 * lexical structure. The TypeScript compiler ships the real lexer
 * (ts.createScanner) and the real parser (ts.createSourceFile) — use them.
 */

import * as ts from "typescript";

/** Pick the parser's ScriptKind from a file path (extension-sensitive). */
export function scriptKindForPath(filePath?: string): ts.ScriptKind {
  const p = (filePath ?? "").toLowerCase();
  if (p.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (p.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface MaskMode {
  /** Mask block comments and line comments. */
  comments: boolean;
  /** Mask string and template literals. */
  strings: boolean;
  /** Mask regex literals. */
  regex: boolean;
}

/**
 * Can a `/` at the current position START a regex literal (as opposed to
 * being division)? Standard lexer heuristic: after an identifier, a
 * literal, `)`, `]` or `}` a `/` is division (except after the handful of
 * keywords that can precede a regex); after any other operator or `(` it
 * is a regex start. Conservative where ambiguous (`)` and `}` are treated
 * as division — misreading a rare trailing regex as division leaves its
 * contents visible, which is the safe direction for masking).
 */
function regexAllowedAfter(prev: ts.SyntaxKind): boolean {
  switch (prev) {
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.CloseParenToken:
    case ts.SyntaxKind.CloseBracketToken:
    case ts.SyntaxKind.CloseBraceToken:
      return false;
    default:
      // Keyword range check (FirstKeyword..LastKeyword are public enum
      // markers; ts.isKeywordKind is not part of the public API surface).
      if (prev >= ts.SyntaxKind.FirstKeyword && prev <= ts.SyntaxKind.LastKeyword) {
        switch (prev) {
          case ts.SyntaxKind.ReturnKeyword:
          case ts.SyntaxKind.TypeOfKeyword:
          case ts.SyntaxKind.VoidKeyword:
          case ts.SyntaxKind.DeleteKeyword:
          case ts.SyntaxKind.InstanceOfKeyword:
          case ts.SyntaxKind.InKeyword:
          case ts.SyntaxKind.OfKeyword:
          case ts.SyntaxKind.NewKeyword:
          case ts.SyntaxKind.CaseKeyword:
          case ts.SyntaxKind.DoKeyword:
          case ts.SyntaxKind.ElseKeyword:
          case ts.SyntaxKind.YieldKeyword:
          case ts.SyntaxKind.AwaitKeyword:
          case ts.SyntaxKind.ThrowKeyword:
            return true;
          default:
            return false;
        }
      }
      return true; // operators / punctuation / unknown → regex position
  }
}

/**
 * Token-scan `source` and blank out (replace with spaces, keeping
 * newlines) the token classes selected in `mode`. Returns the masked
 * source; unmasked regions are byte-identical to the input.
 *
 * Only PROPERLY TERMINATED literals/comments are masked. An "unterminated
 * string" in otherwise-valid code is almost always a stray apostrophe in
 * JSX text (e.g. `don't`) confusing the standalone scanner — masking that
 * span would hide real code, so it is left visible. (Real truncation is
 * detectTruncation's job, and that uses the full parser.)
 */
export function maskTokens(source: string, mode: MaskMode): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ false, ts.LanguageVariant.Standard, source);
  const chars = source.split("");
  const mask = (start: number, end: number) => {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  };

  let prev: ts.SyntaxKind = ts.SyntaxKind.Unknown;

  // Template substitution tracking — mirrors what the PARSER does: after a
  // TemplateHead/TemplateMiddle (`...${), the closing `}` of the
  // substitution comes back from scan() as a plain CloseBraceToken and must
  // be rescanned with reScanTemplateToken() to continue the template.
  // Without this, the template's closing backtick was scanned as a NEW
  // template start and consumed everything up to the NEXT backtick — for
  // sanitizer.ts that swallowed 30+ lines of real code (the exact class of
  // bug this module exists to prevent). Nested braces inside the
  // substitution are tracked so only the matching `}` resumes the template.
  let inTemplateSubstitution = false;
  let templateBraceDepth = 0;

  for (;;) {
    let kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;

    if (kind === ts.SyntaxKind.OpenBraceToken && inTemplateSubstitution) {
      templateBraceDepth++;
    } else if (kind === ts.SyntaxKind.CloseBraceToken && inTemplateSubstitution) {
      if (templateBraceDepth === 0) {
        kind = scanner.reScanTemplateToken(false); // TemplateMiddle or TemplateTail (not a tagged template)
        if (kind === ts.SyntaxKind.TemplateTail) inTemplateSubstitution = false;
        // TemplateMiddle: its trailing ${ reopens the substitution below
      } else {
        templateBraceDepth--;
      }
    }

    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle) {
      inTemplateSubstitution = true;
      templateBraceDepth = 0;
    }

    if (kind === ts.SyntaxKind.SlashToken && mode.regex && regexAllowedAfter(prev)) {
      kind = scanner.reScanSlashToken();
    }
    const start = scanner.getTokenStart();
    const end = scanner.getTextPos();
    const text = source.slice(start, end);

    switch (kind) {
      case ts.SyntaxKind.SingleLineCommentTrivia:
        if (mode.comments) mask(start, end);
        break;
      case ts.SyntaxKind.MultiLineCommentTrivia:
        if (mode.comments && text.endsWith("*/")) mask(start, end);
        break;
      case ts.SyntaxKind.StringLiteral:
        if (mode.strings && text.length >= 2 && text.endsWith(text[0])) mask(start, end);
        break;
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        if (mode.strings && text.endsWith("`")) mask(start, end);
        break;
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
        if (mode.strings && text.endsWith("${")) mask(start, end);
        break;
      case ts.SyntaxKind.TemplateTail:
        if (mode.strings && text.endsWith("`")) mask(start, end);
        break;
      case ts.SyntaxKind.RegularExpressionLiteral:
        // A complete regex literal: /body/flags. Only mask when it really
        // closes (starts and ends with `/`, optional trailing flags).
        if (mode.regex && /^\/[\s\S]*\/[a-z]*$/i.test(text)) mask(start, end);
        break;
      default:
        break;
    }
    prev = kind;
  }

  return chars.join("");
}

/** Mask comments only — for comparing code while ignoring comment churn
 *  (isCosmeticChange, normalizeCode). String content stays visible so a
 *  real change inside a string literal — e.g. a URL swap — is still a
 *  detected difference. */
export function stripComments(source: string): string {
  return maskTokens(source, { comments: true, strings: false, regex: false });
}

/** Mask comments, strings, templates AND regex literals — for lexical
 *  scanning of code structure (extractExports). `//` inside a string can
 *  no longer eat the rest of its line. */
export function stripLiteralsAndComments(source: string): string {
  return maskTokens(source, { comments: true, strings: true, regex: true });
}

/** Diagnostics whose end position is within this many chars of EOF are
 *  treated as truncation signatures. Generous: a file cut inside nested
 *  blocks reports one "'}' expected" per unclosed block, all at EOF. */
const TRUNCATION_EOF_WINDOW = 300;

/**
 * Detect truncated LLM output using the REAL parser.
 *
 * A file that parses cleanly is never truncated (this alone fixes the
 * false positives: brace imbalance inside strings/regexes never reaches
 * the parser). A file with parse errors is "truncated" only when the
 * errors sit at/near the end of the output (or are unterminated-literal
 * errors) — the shape a cut-off generation produces. Errors elsewhere are
 * ordinary broken code: NOT flagged here, so the syntax/typecheck gates
 * reject it with an honest message instead of a bogus "token limit"
 * postmortem.
 *
 * @param code      The LLM's output (post fence-extraction).
 * @param original  The original file content (enables the "drastically
 *                  shorter AND unterminated" length heuristic — a file cut
 *                  exactly at a clean statement boundary parses fine, and
 *                  length is the only signal for that).
 * @param filePath  Real path of the target file — picks ScriptKind.TSX
 *                  for .tsx sources so JSX parses correctly.
 */
export function detectTruncation(
  code: string,
  original: string = "",
  filePath?: string
): { truncated: boolean; reason?: string } {
  if (!code || !code.trim()) {
    return { truncated: true, reason: "empty output" };
  }

  const kind = scriptKindForPath(filePath);
  const probeName = kind === ts.ScriptKind.TSX ? "probe.tsx" : kind === ts.ScriptKind.JSX ? "probe.jsx" : "probe.ts";

  let diagnostics: ts.Diagnostic[] = [];
  try {
    const sf = ts.createSourceFile(probeName, code, ts.ScriptTarget.Latest, false, kind);
    diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  } catch {
    // Parser itself choked (shouldn't happen) — don't guess truncation;
    // let the syntax gate report the real error.
    diagnostics = [];
  }

  if (diagnostics.length > 0) {
    const len = code.length;
    const eofAdjacent = diagnostics.some((d) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (/unterminated/i.test(msg)) return true;
      const end = (d.start ?? 0) + (d.length ?? 0);
      const distanceFromEof = len - end;
      return distanceFromEof >= 0 && distanceFromEof <= TRUNCATION_EOF_WINDOW;
    });
    if (eofAdjacent) {
      const first = diagnostics[0];
      const msg = ts.flattenDiagnosticMessageText(first.messageText, "\n");
      return { truncated: true, reason: `parse error at end of output: ${msg.slice(0, 120)}` };
    }
    // Errors exist but are NOT EOF-adjacent → ordinary broken code, not
    // truncation. Fall through to the length check, then report clean.
  }

  // Length heuristic (kept from the original implementation): drastically
  // shorter than the original AND not properly terminated.
  if (original && code.length < original.length * 0.5) {
    const trimmed = code.trimEnd();
    if (!trimmed.endsWith("}") && !trimmed.endsWith(";")) {
      return {
        truncated: true,
        reason: `output too short (${code.length}b vs ${original.length}b original) and not properly terminated`,
      };
    }
  }

  return { truncated: false };
}
