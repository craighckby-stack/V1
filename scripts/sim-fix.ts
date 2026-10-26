import { readFileSync, writeFileSync } from "fs";
import { typecheckRefactor } from "@/lib/pipeline/autonomous/in-memory-typecheck";

const file = "/home/z/my-project/src/lib/pipeline/autonomous/chat-task.ts";
const code = readFileSync(file, "utf-8");
// Simulate: replace line 17 (import { join, relative, extname } from "path";)
// with the fixed version
const lines = code.split("\n");
console.log("Original line 17:", JSON.stringify(lines[16]));
const fixed = `import { join, relative } from "path";`;
lines[16] = fixed;
const newCode = lines.join("\n");
console.log("Fixed line 17:", JSON.stringify(lines[16]));
const result = typecheckRefactor(file, newCode);
console.log("typecheck ok:", result.ok);
console.log("errors:", JSON.stringify(result.errors, null, 2));
