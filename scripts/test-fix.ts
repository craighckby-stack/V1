import * as ts from "typescript";
import { readFileSync } from "fs";

const file = "/home/z/my-project/src/lib/pipeline/autonomous/chat-task.ts";
const code = readFileSync(file, "utf-8");
const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);

sf.forEachChild((node) => {
  if (ts.isImportDeclaration(node)) {
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    if (line === 17) {
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const elements = clause.namedBindings.elements;
        const lines = code.split("\n");
        const restOfFile = lines.filter((_, i) => i !== 16).join("\n");
        for (const el of elements) {
          const re = new RegExp(`\\b${el.name.text}\\b`, "g");
          const count = (restOfFile.match(re) ?? []).length;
          console.log(`  ${el.name.text}: ${count} uses outside import`);
        }
        console.log("  import text:", code.split("\n")[16]);
      }
    }
  }
});
