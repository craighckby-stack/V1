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
import { readFileSync, existsSync } from "fs";
import { resolve, relative, sep } from "path";
import { scriptKindForPath } from "./code-analysis";

import { PROJECT_ROOT } from "../core/paths";
const TSCONFIG_PATH = resolve(PROJECT_ROOT, "tsconfig.json");

/** The out-of-src mutation scope (saturation.ts v6). Files under here
 *  are NOT in the root tsconfig program (tsconfig.json excludes
 *  mini-services so Next dev never compiles worker code), so the
 *  full-project typecheck below would silently skip them — the
 *  substituted file would never even be parsed and the gate would
 *  pass anything. */
const MINI_SERVICES_ROOT = resolve(PROJECT_ROOT, "mini-services");

/** Bun's ambient types (the `Bun` global, `import.meta.dir`, …).
 *  bun-types is a root devDependency; its .d.ts is added as a program
 *  ROOT for mini-services checks. It must NEVER join the full src
 *  program: its `fetch` augmentation conflicts with the DOM lib's
 *  fetch in client components (verified: adding it alongside src/ →
 *  TS2741 in src/app/page.tsx) — which is exactly why mini-services
 *  get their own SCOPED program instead of a tsconfig include. */
const BUN_TYPES_ENTRY = resolve(
  PROJECT_ROOT,
  "node_modules",
  "bun-types",
  "index.d.ts",
);

/** True when the mutated file lives in the out-of-src scope and needs
 *  the scoped-program path. */
function isMiniServicesPath(absPath: string): boolean {
  return absPath.startsWith(MINI_SERVICES_ROOT + sep);
}

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

  // ── Out-of-src scope (v6, 2026-11-22): mini-services files get a
  // SCOPED program instead of the full-project one. Roots = the
  // mutated file + bun-types + the same automatic @types entries the
  // root program gets (extracted from the parsed config's fileNames —
  // that's how the full-program path receives node/react types).
  // Transitive imports (the worker imports deep into src/) are pulled
  // in by the program walker and checked too. Verified clean against
  // all four services' index.ts before enabling the scope.
  const programRoots = isMiniServicesPath(absPath)
    ? [
        absPath,
        ...(existsSync(BUN_TYPES_ENTRY) ? [BUN_TYPES_ENTRY] : []),
        ...fileNames.filter((f) =>
          f.includes(`${sep}node_modules${sep}@types${sep}`),
        ),
      ]
    : fileNames;

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
  const program = ts.createProgram(programRoots, options, host);

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
