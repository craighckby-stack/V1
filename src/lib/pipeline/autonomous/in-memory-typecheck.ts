/**
 * In-memory TypeScript typecheck for refactored files.
 *
 * Uses the TypeScript compiler API to typecheck refactored code IN MEMORY —
 * the code is never written to disk until it passes. This prevents Turbopack
 * from ever seeing broken code (the root cause of stale browser errors).
 *
 * Performs a FULL project typecheck with the refactored file substituted in,
 * so type errors in consumers are also caught.
 */

import * as ts from "typescript";
import { readFileSync } from "fs";
import { resolve, relative } from "path";

const PROJECT_ROOT = "/home/z/my-project";
const TSCONFIG_PATH = resolve(PROJECT_ROOT, "tsconfig.json");

let cachedFileNames: string[] | null = null;
let cachedCompilerOptions: ts.CompilerOptions | null = null;

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

  // Scope the program to PROJECT code only. Reference folders (examples/,
  // skills/) ship with pre-existing type errors that would reject every
  // refactor even when the refactor is fine — the gate must only judge the
  // code the system owns and can actually break.
  cachedFileNames = parsedConfig.fileNames.filter(
    (f) => !f.includes("/examples/") && !f.includes("/skills/")
  );
  cachedCompilerOptions = { ...parsedConfig.options, noEmit: true };
  return { fileNames: cachedFileNames, options: cachedCompilerOptions };
}

/**
 * Typecheck a refactored file IN MEMORY against the full project.
 * Nothing is written to disk.
 */
export function typecheckRefactor(
  filePath: string,
  refactoredCode: string
): { ok: boolean; errors: string[] } {
  const { fileNames, options } = loadTsConfig();
  const absPath = resolve(filePath);

  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (
    fileName: string,
    languageVersion: ts.ScriptTarget,
    onError?: (message: string) => void,
    shouldCreateNewSourceFile?: boolean
  ): ts.SourceFile | undefined => {
    if (resolve(fileName) === absPath) {
      return ts.createSourceFile(
        fileName,
        refactoredCode,
        languageVersion,
        true,
        ts.ScriptKind.TS
      );
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  const program = ts.createProgram(fileNames, options, host);

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
 * Quick syntax-only check (fast pre-filter).
 */
export function syntaxCheck(code: string): { ok: boolean; error?: string } {
  const sourceFile = ts.createSourceFile(
    "refactored.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    const first = diagnostics[0];
    const msg = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    return { ok: false, error: `Syntax error: ${msg}` };
  }
  return { ok: true };
}
