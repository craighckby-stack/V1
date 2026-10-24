/**
 * AST Verification & Syntax Gate Helper
 * Structural diffing between original and proposed code, verifying that
 * AST symbols aren't dropped and detecting unwanted branding injections.
 */

export interface AstSymbol {
  name: string;
  type: "function" | "class" | "interface" | "type" | "const" | "method";
  line?: number;
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
];

export function extractSymbols(code: string): AstSymbol[] {
  const symbols: AstSymbol[] = [];
  const lines = code.split("\n");

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;

    const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
    if (fnMatch) {
      symbols.push({ name: fnMatch[1]!, type: "function", line: idx + 1 });
      continue;
    }

    const classMatch = line.match(/(?:export\s+)?class\s+([A-Za-z0-9_$]+)/);
    if (classMatch) {
      symbols.push({ name: classMatch[1]!, type: "class", line: idx + 1 });
      continue;
    }

    const ifaceMatch = line.match(/(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
    if (ifaceMatch) {
      symbols.push({ name: ifaceMatch[1]!, type: "interface", line: idx + 1 });
      continue;
    }

    const typeMatch = line.match(/(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/);
    if (typeMatch) {
      symbols.push({ name: typeMatch[1]!, type: "type", line: idx + 1 });
      continue;
    }

    const constMatch = line.match(/(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*[:=]/);
    if (constMatch) {
      symbols.push({ name: constMatch[1]!, type: "const", line: idx + 1 });
    }
  }

  return symbols;
}

export function evaluateAstDiff(originalCode: string, proposedCode: string): AstDiffResult {
  const originalSymbols = extractSymbols(originalCode);
  const proposedSymbols = extractSymbols(proposedCode);

  const proposedNames = new Set(proposedSymbols.map(s => s.name));
  const missingSymbols = originalSymbols.filter(s => !proposedNames.has(s.name));
  const retainedCount = originalSymbols.length - missingSymbols.length;

  const violations: AstDiffViolation[] = [];

  if (missingSymbols.length > 0) {
    violations.push({
      code: "AST_SYMBOL_DROPPED",
      message: `Dropped ${missingSymbols.length} original symbol(s): ${missingSymbols
        .map(s => s.name)
        .slice(0, 5)
        .join(", ")}`,
      severity: missingSymbols.length > 2 ? "high" : "medium",
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

  const stripSyntheticDecorations = (code: string) => {
    return code
      .replace(/\/\*\*[\s\S]*?\*\/\n?/g, "")
      .replace(/\/\/[^\n\r]*\n?/g, "")
      .replace(/^#[^\n\r]*\n?/gm, "")
      .replace(/<!--[\s\S]*?-->\n?/g, "")
      .replace(/export\s+interface\s+ExecutionContract\s*\{[\s\S]*?\}\n*/g, "")
      .trim();
  };

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

  if (driftRatio > 0.65) {
    violations.push({
      code: "AST_STRUCTURAL_DRIFT",
      message: `Structural drift exceeds safe threshold (${Math.round(driftRatio * 100)}%)`,
      severity: "high",
    });
  }

  const retentionScore =
    originalSymbols.length === 0 ? 100 : (retainedCount / originalSymbols.length) * 60;
  const penalty =
    brandingInjections.length * 20 + violations.filter(v => v.severity === "high").length * 25;
  const astScore = Math.max(0, Math.min(100, Math.round(retentionScore + 40 - penalty)));

  const passed =
    violations.filter(v => v.severity === "high").length === 0 && astScore >= 50;

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
    structuralDriftRatio: Math.min(1, driftRatio),
    violations,
  };
}
