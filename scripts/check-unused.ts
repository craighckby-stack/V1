import * as ts from "typescript";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const DIR = "/home/z/my-project/src/lib/pipeline";
function scan(dir: string, files: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) scan(f, files);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(f);
  }
}
const files: string[] = [];
scan(DIR, files);

let total = 0;
for (const file of files) {
  const text = readFileSync(file, "utf-8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const importNames: { name: string; line: number; pos: number }[] = [];
  sf.forEachChild((n) => {
    if (ts.isImportDeclaration(n)) {
      const bc = n.importClause;
      if (!bc) return;
      if (bc.name) {
        importNames.push({ name: bc.name.text, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, pos: n.getStart() });
      }
      if (bc.namedBindings && ts.isNamedImports(bc.namedBindings)) {
        for (const el of bc.namedBindings.elements) {
          const used = (el.propertyName ?? el.name).text;
          importNames.push({ name: el.name.text, line: sf.getLineAndCharacterOfPosition(el.getStart()).line + 1, pos: el.getStart() });
          void used;
        }
      }
      if (bc.namedBindings && ts.isNamespaceImport(bc.namedBindings)) {
        importNames.push({ name: bc.namedBindings.name.text, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, pos: n.getStart() });
      }
    }
  });
  // For each imported name, check if it appears as an identifier elsewhere
  for (const imp of importNames) {
    // Naive: count occurrences of the name as a word in the text, excluding the import line
    const lines = text.split("\n");
    const importLine = lines[imp.line - 1] ?? "";
    const restOfFile = lines.filter((_, i) => i !== imp.line - 1).join("\n");
    const re = new RegExp(`\\b${imp.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    const restCount = (restOfFile.match(re) ?? []).length;
    if (restCount === 0) {
      total++;
      if (total <= 15) console.log(`  ${file.replace("/home/z/my-project/","")}:${imp.line} — unused import "${imp.name}"`);
    }
  }
}
console.log(`Total unused imports found: ${total}`);
