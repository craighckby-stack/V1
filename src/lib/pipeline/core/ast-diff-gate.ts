import * as ts from "typescript";

export interface AstSymbol {
  name: string;
  type:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "const"
    | "method"
    | "arrow"
    | "enum"
    | "namespace"
    | "reexport";
  line?: number;
  exported: boolean;
}

export interface AstDiffViolation {
  code: "BRANDING_INJECTION" | "AST_SYMBOL_DROPPED" | "AST_STRUCTURAL_DRIFT" | "UNRESOLVED_AST_IMPORT";
  message: string;
  severity: "high" | "medium" | "low";
}

export interface AstSymbolMap {
  originalCount: number;
  proposedCount: number;
  retainedCount: number;
  missingSymbols: AstSymbol[];
}

export interface AstDiffResult {
  passed: boolean;
  astScore: number;
  symbolMap: AstSymbolMap;
  brandingInjections: string[];
  structuralDriftRatio: number;
  violations: AstDiffViolation[];
  parserUsed: "typescript" | "regex-fallback";
}

const SYSTEM_PERSONA_BRANDING_TERMS: readonly string[] = [
  "dalek caan",
  "dalek_caan",
  "dalekcaan",
  "omega engine",
  "omega_engine",
  "cognitive dominance",
  "grog engine",
  "grog_engine",
  "recursive evolution loop",
  "nexus neural network",
] as const;

const HIGH_SEVERITY_THRESHOLD = 2;
const DRIFT_THRESHOLD = 0.65;
const MIN_PASSING_SCORE = 50;
const BASE_RETENTION_WEIGHT = 60;
const BASE_QUALITY_WEIGHT = 40;
const BRANDING_PENALTY = 20;
const HIGH_VIOLATION_PENALTY = 25;
const MAX_SCORE = 100;

const TS_LIKE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", ""] as const;
type TsLikeExtension = typeof TS_LIKE_EXTENSIONS[number];

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function symbolKindFromDeclaration(node: ts.Node): AstSymbol["type"] | null {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
      return "function";
    case ts.SyntaxKind.ClassDeclaration:
      return "class";
    case ts.SyntaxKind.InterfaceDeclaration:
      return "interface";
    case ts.SyntaxKind.TypeAliasDeclaration:
      return "type";
    case ts.SyntaxKind.EnumDeclaration:
      return "enum";
    case ts.SyntaxKind.ModuleDeclaration:
      return "namespace";
    case ts.SyntaxKind.VariableDeclaration:
      return "const";
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
      return "arrow";
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return "method";
    case ts.SyntaxKind.ExportSpecifier:
    case ts.SyntaxKind.ExportAssignment:
      return "reexport";
    default:
      return null;
  }
}

function declarationName(node: ts.Node): string | null {
  if ("name" in node && node.name) {
    const name = (node as { name: ts.Identifier | ts.PrivateIdentifier | ts.StringLiteralLike }).name;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) {
      return name.text;
    }
  }
  return null;
}

function extractSymbolsFromTs(sourceFile: ts.SourceFile): AstSymbol[] {
  const symbols: AstSymbol[] = [];
  
  const visit = (node: ts.Node): void => {
    let kind: AstSymbol["type"] | null = null;
    let name: string | null = null;

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      kind = symbolKindFromDeclaration(node);
      name = declarationName(node);
    } else if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const decl of node.declarationList.declarations) {
        const declName = ts.isIdentifier(decl.name) ? decl.name.text : null;
        if (!declName) continue;
        let varKind: AstSymbol["type"] = "const";
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          varKind = "arrow";
        }
        symbols.push({
          name: declName,
          type: varKind,
          line: ts.getLineAndCharacterOfPosition(sourceFile, decl.getStart()).line + 1,
          exported,
        });
      }
      ts.forEachChild(node, visit);
      return;
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        const specName = spec.propertyName?.text ?? spec.name.text;
        symbols.push({
          name: specName,
          type: "reexport",
          line: ts.getLineAndCharacterOfPosition(sourceFile, spec.getStart()).line + 1,
          exported: true,
        });
      }
      ts.forEachChild(node, visit);
      return;
    } else if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      kind = "method";
      name = declarationName(node);
    }

    if (kind && name) {
      symbols.push({
        name,
        type: kind,
        line: ts.getLineAndCharacterOfPosition(sourceFile, node.getStart()).line + 1,
        exported: isExported(node),
      });
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return symbols;
}

function extractSymbolsRegex(code: string, filePath?: string): AstSymbol[] {
  const symbols: AstSymbol[] = [];
  const lines = code.split("\n");
  const ext = (filePath ?? "").toLowerCase().split(".").pop() as string;

  const topLevelPatterns: Array<[RegExp, AstSymbol["type"]]> = [
    [/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/, "function"],
    [/(?:export\s+)?class\s+([A-Za-z0-9_$]+)/, "class"],
    [/(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/, "interface"],
    [/(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/, "type"],
    [/(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*[:=]/, "const"],
    [/^\s*def\s+([A-Za-z0-9_]+)/, "function"],
    [/^func\s+([A-Za-z0-9_]+)/, "function"],
  ];

  const methodPatterns: Array<[RegExp, AstSymbol["type"]]> = [];
  if (ext === "java" || ext === "kt" || ext === "cs") {
    methodPatterns.push([
      /^\s*(?:@\w+\s+)*\s*(?:public|private|protected|static|final|synchronized|abstract|native|override)\s+(?:final\s+)?(?:[A-Za-z_][\w<>\[\],?\s]*\s+)+([A-Za-z_]\w*)\s*\(/,
      "method",
    ]);
  }
  if (ext === "py") {
    methodPatterns.push([/^\s+def\s+([A-Za-z_]\w*)\s*\(/, "method"]);
  }
  if (ext === "go") {
    methodPatterns.push([/^func\s+\([^)]*\)\s+([A-Za-z_]\w*)\s*\(/, "method"]);
  }
  if (ext === "rs") {
    methodPatterns.push([/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/, "method"]);
  }
  if (ext === "rb") {
    methodPatterns.push([/^\s+def\s+([A-Za-z_]\w*)/, "method"]);
  }
  if (ext === "php") {
    methodPatterns.push([
      /^\s*(?:public|private|protected|static)\s+(?:static\s+)?function\s+([A-Za-z_]\w*)\s*\(/,
      "method",
    ]);
  }
  if (ext === "cpp" || ext === "cc" || ext === "c" || ext === "h" || ext === "hpp") {
    methodPatterns.push([/^\s*[A-Za-z_][\w:<>*\s]*\s+([A-Za-z_]\w*)\s*\(/, "method"]);
  }

  const skipNames = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "assert", "sizeof"]);

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    let matched = false;

    for (const [pat, type] of topLevelPatterns) {
      const m = line.match(pat);
      if (m && m[1]) {
        if (type === "function" && ext === "go" && /^func\s+\(/.test(line)) {
          continue;
        }
        symbols.push({
          name: m[1],
          type,
          line: idx + 1,
          exported: /\bexport\b/.test(line),
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    for (const [pat, type] of methodPatterns) {
      const m = line.match(pat);
      if (m && m[1]) {
        if (skipNames.has(m[1])) continue;
        symbols.push({
          name: m[1],
          type,
          line: idx + 1,
          exported: false,
        });
        break;
      }
    }
  }
  return symbols;
}

export function extractSymbols(code: string, filePath?: string): AstSymbol[] {
  const ext = (filePath ?? "").toLowerCase().split(".").pop() as string;
  const isTsLike = TS_LIKE_EXTENSIONS.includes(ext as TsLikeExtension);
  
  if (!isTsLike) {
    return extractSymbolsRegex(code, filePath);
  }
  
  try {
    const scriptKind =
      ext === "ts" ? ts.ScriptKind.TS :
      ext === "tsx" ? ts.ScriptKind.TSX :
      ext === "jsx" ? ts.ScriptKind.JSX :
      ts.ScriptKind.JS;
      
    const sourceFile = ts.createSourceFile(
      "input." + (ext || "ts"),
      code,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true,
      scriptKind
    );
    return extractSymbolsFromTs(sourceFile);
  } catch {
    return extractSymbolsRegex(code);
  }
}

function stripSyntheticDecorations(code: string): string {
  return code
    .replace(/\/\*\*[\s\S]*?\*\/\n?/g, "")
    .replace(/\/\/[^\n\r]*\n?/g, "")
    .replace(/^#[^\n\r]*\n?/gm, "")
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    .replace(/export\s+interface\s+ExecutionContract\s*\{[\s\S]*?\}\n*/g, "")
    .trim();
}

function calculateAstScore(
  originalCount: number,
  retainedCount: number,
  brandingInjections: string[],
  violations: AstDiffViolation[]
): number {
  const retentionScore =
    originalCount === 0 ? 100 : (retainedCount / originalCount) * BASE_RETENTION_WEIGHT;
  const penalty =
    brandingInjections.length * BRANDING_PENALTY +
    violations.filter((v) => v.severity === "high").length * HIGH_VIOLATION_PENALTY;
  return Math.max(0, Math.min(MAX_SCORE, Math.round(retentionScore + BASE_QUALITY_WEIGHT - penalty)));
}

function calculateDriftRatio(
  originalCode: string,
  proposedCode: string,
  originalSymbols: AstSymbol[],
  missingSymbols: AstSymbol[]
): number {
  const cleanOrig = stripSyntheticDecorations(originalCode);
  const cleanProp = stripSyntheticDecorations(proposedCode);
  const origLen = cleanOrig.length || originalCode.length;
  const propLen = cleanProp.length || proposedCode.length;
  const lengthRatio = origLen === 0 ? 0 : Math.abs(propLen - origLen) / Math.max(origLen, 400);

  let driftRatio = lengthRatio;
  if (originalSymbols.length > 0) {
    const symbolDrift = missingSymbols.length / originalSymbols.length;
    driftRatio = Math.max(driftRatio, symbolDrift);
  }
  return Math.min(1, driftRatio);
}

export function evaluateAstDiff(originalCode: string, proposedCode: string, filePath?: string): AstDiffResult {
  const originalSymbols = extractSymbols(originalCode, filePath);
  const proposedSymbols = extractSymbols(proposedCode, filePath);
  const ext = (filePath ?? "").toLowerCase().split(".").pop() as string;
  const parserUsed: AstDiffResult["parserUsed"] = TS_LIKE_EXTENSIONS.includes(ext as TsLikeExtension)
    ? "typescript"
    : "regex-fallback";

  const proposedKey = (s: AstSymbol) => `${s.name}:${s.exported ? "exp" : "loc"}`;
  const proposedNames = new Set(proposedSymbols.map(proposedKey));
  const missingSymbols = originalSymbols.filter((s) => !proposedNames.has(proposedKey(s)));
  const retainedCount = originalSymbols.length - missingSymbols.length;

  const violations: AstDiffViolation[] = [];

  if (missingSymbols.length > 0) {
    violations.push({
      code: "AST_SYMBOL_DROPPED",
      message: `Dropped ${missingSymbols.length} original symbol(s): ${missingSymbols
        .map((s) => s.name)
        .slice(0, 5)
        .join(", ")}`,
      severity: missingSymbols.length > HIGH_SEVERITY_THRESHOLD ? "high" : "medium",
    });
  }

  const proposedLower = proposedCode.toLowerCase();
  const brandingInjections: string[] = [];
  for (const term of SYSTEM_PERSONA_BRANDING_TERMS) {
    if (proposedLower.includes(term) && !originalCode.toLowerCase().includes(term)) {
      brandingInjections.push(term);
    }
  }
  if (brandingInjections.length > 0) {
    violations.push({
      code: "BRANDING_INJECTION",
      message: `Detected unauthorized persona/branding injection: ${brandingInjections.join(", ")}`,
      severity: "high",
    });
  }

  const driftRatio = calculateDriftRatio(originalCode, proposedCode, originalSymbols, missingSymbols);
  if (driftRatio > DRIFT_THRESHOLD) {
    violations.push({
      code: "AST_STRUCTURAL_DRIFT",
      message: `Structural drift exceeds safe threshold (${Math.round(driftRatio * 100)}%)`,
      severity: "high",
    });
  }

  const astScore = calculateAstScore(originalSymbols.length, retainedCount, brandingInjections, violations);
  const passed = violations.filter((v) => v.severity === "high").length === 0 && astScore >= MIN_PASSING_SCORE;

  return {
    passed,
    astScore,
    symbolMap: {
      originalCount: originalSymbols.length,
      proposedCount: proposedSymbols.length,
      retainedCount,
      missingSymbols,
    },
    brandingInjections,
    structuralDriftRatio: driftRatio,
    violations,
    parserUsed,
  };
}