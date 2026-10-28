/**
 * In-memory TypeScript typecheck for refactored files.
 *
 * Problem this solves: the self-enhance loop used to write the refactored code
 * to the LIVE file, run `tsc --noEmit`, and revert if it failed. But during
 * the ~30s tsc window, Turbopack's file-watcher saw the broken file and
 * cached the parse error — leaving a stale error in the browser even after
 * the revert.
 *
 * Solution: use the TypeScript compiler API to typecheck the refactored code
 * IN MEMORY. The refactored code is never written to disk until it passes.
 * Turbopack never sees broken code.
 *
 * This performs a FULL project typecheck (same as `tsc --noEmit`) with the
 * refactored file substituted in — so type errors in consumers of the file
 * are also caught.
 */

import * as ts from "typescript";
import { readFileSync } from "fs";
import { resolve, relative } from "path";
import { scriptKindForPath } from "./code-analysis";

const PROJECT_ROOT = "/home/z/my-project";
const TSCONFIG_PATH = resolve(PROJECT_ROOT, "tsconfig.json");

let cachedProgram: ts.Program | null = null;
let cachedFileNames: string[] | null = null;
let cachedCompilerOptions: ts.CompilerOptions | null = null;

/**
 * Load and parse the project's tsconfig once (cached across calls).
 * Returns the file names to typecheck and the compiler options.
 */
function loadTsConfig(): { fileNames: string[]; options: ts.CompilerOptions } {
  if (cachedFileNames && cachedCompilerOptions) {
    return { fileNames: cachedFileNames, options: cachedCompilerOptions };
  }

  const configText = readFileSync(TSCONFIG_PATH, "utf-8");
  const parsed = ts.parseConfigFileTextToJson(TSCONFIG_PATH, configText);
  if (parsed.error) {
    throw new Error(`Failed to parse tsconfig.json: ${parsed.error.messageText}`);
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    parsed.config,
    ts.sys,
    PROJECT_ROOT,
    { noEmit: true },
    TSCONFIG_PATH
  );

  cachedFileNames = parsedConfig.fileNames;
  cachedCompilerOptions = { ...parsedConfig.options, noEmit: true };
  return { fileNames: cachedFileNames, options: cachedCompilerOptions };
}

/**
 * Typecheck a refactored file IN MEMORY against the full project.
 * The refactored code is provided as a string; nothing is written to disk.
 *
 * @param filePath Absolute path to the file being refactored
 * @param refactoredCode The refactored code content
 * @returns { ok: boolean; errors: string[] } — ok=true if no type errors
 */
export function typecheckRefactor(
  filePath: string,
  refactoredCode: string
): { ok: boolean; errors: string[] } {
  const { fileNames, options } = loadTsConfig();
  const absPath = resolve(filePath);

  // Custom compiler host: returns the refactored content for our target file,
  // reads from disk for everything else.
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (
    fileName: string,
    languageVersion: ts.ScriptTarget,
    onError?: (message: string) => void,
    shouldCreateNewSourceFile?: boolean
  ): ts.SourceFile | undefined => {
    // Substitute the refactored code for our target file. ScriptKind must
    // follow the file's real extension: hardcoding ScriptKind.TS made every
    // proposed .tsx refactor fail with JSX parse errors like "'>' expected"
    // before verification even started (audit 2) — so display components
    // could never pass, and every attempt burned an LLM call.
    if (resolve(fileName) === absPath) {
      return ts.createSourceFile(
        fileName,
        refactoredCode,
        languageVersion,
        true,
        scriptKindForPath(fileName)
      );
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  // Create a fresh program with the custom host
  const program = ts.createProgram(fileNames, options, host);

  // Collect all diagnostics (syntax + semantic)
  const allDiagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ];

  const errors = allDiagnostics
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      const rel = d.file ? relative(PROJECT_ROOT, d.file.fileName) : "<unknown>";
      if (d.file && d.start !== undefined) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        return `${rel}(${line + 1},${character + 1}): error TS${d.code}: ${msg}`;
      }
      return `${rel}: error TS${d.code}: ${msg}`;
    });

  return { ok: errors.length === 0, errors };
}

/**
 * Quick syntax-only check (much faster than full typecheck).
 * Used as a pre-filter to catch obvious syntax errors before the full check.
 * @param filePath Real path of the target file — .tsx sources are parsed
 * with ScriptKind.TSX so JSX isn't reported as syntax errors.
 */
export function syntaxCheck(code: string, filePath?: string): { ok: boolean; error?: string } {
  const kind = scriptKindForPath(filePath);
  const sourceFile = ts.createSourceFile(
    kind === ts.ScriptKind.TSX ? "refactored.tsx" : "refactored.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    kind
  );
  // SourceFile has syntactic diagnostics attached during parsing
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    const first = diagnostics[0];
    const msg = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    return { ok: false, error: `Syntax error: ${msg}` };
  }
  return { ok: true };
}
