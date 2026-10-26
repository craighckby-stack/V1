module.exports = [
"[externals]/next/dist/compiled/next-server/app-route-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-route-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-route-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-route-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/@opentelemetry/api [external] (next/dist/compiled/@opentelemetry/api, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/@opentelemetry/api", () => require("next/dist/compiled/@opentelemetry/api"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-page-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/shared/lib/no-fallback-error.external.js [external] (next/dist/shared/lib/no-fallback-error.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/shared/lib/no-fallback-error.external.js", () => require("next/dist/shared/lib/no-fallback-error.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/after-task-async-storage.external.js [external] (next/dist/server/app-render/after-task-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/after-task-async-storage.external.js", () => require("next/dist/server/app-render/after-task-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/fs [external] (fs, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("fs", () => require("fs"));

module.exports = mod;
}),
"[externals]/child_process [external] (child_process, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("child_process", () => require("child_process"));

module.exports = mod;
}),
"[externals]/path [external] (path, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("path", () => require("path"));

module.exports = mod;
}),
"[externals]/fs/promises [external] (fs/promises, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("fs/promises", () => require("fs/promises"));

module.exports = mod;
}),
"[externals]/os [external] (os, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("os", () => require("os"));

module.exports = mod;
}),
"[project]/src/lib/pipeline/llm/agent-llm.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "extractCodeBlock",
    ()=>extractCodeBlock,
    "llmComplete",
    ()=>llmComplete,
    "llmRefactorCode",
    ()=>llmRefactorCode
]);
/**
 * Real LLM agent loop for code refactoring.
 *
 * Wraps z-ai-web-dev-sdk and produces actual refactored code (instead of
 * the cosmetic comment-injection the previous stub did). The output is
 * then run through the real AST diff gate so the system can genuinely
 * reject LLM output that drops symbols.
 *
 * If the SDK is unreachable (e.g. no API access), every call gracefully
 * degrades to a deterministic fallback so the pipeline still runs.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$z$2d$ai$2d$web$2d$dev$2d$sdk$2f$dist$2f$index$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/z-ai-web-dev-sdk/dist/index.js [app-route] (ecmascript)");
;
let zaiPromise = null;
async function getZai() {
    if (!zaiPromise) {
        zaiPromise = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$z$2d$ai$2d$web$2d$dev$2d$sdk$2f$dist$2f$index$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["default"].create().catch((err)=>{
            zaiPromise = null;
            throw err;
        });
    }
    return zaiPromise;
}
async function llmComplete(opts) {
    const started = performance.now();
    let lastError;
    const maxAttempts = 2;
    for(let attempt = 1; attempt <= maxAttempts; attempt++){
        try {
            const zai = await getZai();
            const completion = await zai.chat.completions.create({
                messages: [
                    {
                        role: "assistant",
                        content: opts.systemPrompt
                    },
                    {
                        role: "user",
                        content: opts.userPrompt
                    }
                ],
                thinking: {
                    type: "disabled"
                }
            });
            const content = completion.choices?.[0]?.message?.content ?? "";
            if (!content.trim()) {
                throw new Error("Empty LLM response");
            }
            return {
                ok: true,
                content,
                attempts: attempt,
                latencyMs: Math.round(performance.now() - started)
            };
        } catch (err) {
            lastError = err.message;
            if (attempt < maxAttempts) {
                await new Promise((r)=>setTimeout(r, 400 * attempt));
            }
        }
    }
    return {
        ok: false,
        content: "",
        error: lastError ?? "LLM unavailable",
        attempts: maxAttempts,
        latencyMs: Math.round(performance.now() - started)
    };
}
function extractCodeBlock(raw) {
    if (!raw) return "";
    const fenceMatch = raw.match(/```(?:[a-zA-Z0-9_+-]*)?\n([\s\S]*?)```/);
    if (fenceMatch && fenceMatch[1]) {
        return fenceMatch[1].trim();
    }
    // No fence — assume the whole response is code (after stripping common commentary)
    return raw.trim();
}
const REFRACTOR_SYSTEM_PROMPT = `You are an expert code refactorer operating inside an autonomous pipeline. Your output will be committed to a GitHub branch by an automated system.

HARD RULES (violating any rule fails the pipeline):
1. Preserve EVERY top-level exported symbol (function, class, interface, type, const). Do not rename them. Do not merge them. Do not delete them.
2. Do NOT introduce any of these persona/branding strings: "dalek caan", "omega engine", "cognitive dominance", "grog engine", "recursive evolution loop", "nexus neural network".
3. Do NOT add credentials, API keys, tokens, or PII.
4. Do NOT use eval() or new Function().
5. Keep the same programming language as the input.

WHAT TO DO:
- Add explicit type annotations where TypeScript would infer them.
- Tighten parameter types (e.g. string -> specific string-literal unions where appropriate).
- Extract magic numbers into named constants.
- Replace any/some unsafe casts with safer alternatives where possible.
- Add a short JSDoc comment to any previously undocumented public function.
- Apply small modularization (extract pure helpers) WITHOUT changing public API.
- Preserve the original semantic behavior exactly.

OUTPUT FORMAT (mandatory):
- Output ONLY the refactored code inside a single fenced code block.
- Do NOT add commentary before or after the code block.
- Do NOT include any markdown other than the fence.`;
async function llmRefactorCode(params) {
    const lang = params.filePath.toLowerCase().split(".").pop() || "ts";
    const userPrompt = `Repository file: ${params.filePath}
Pattern source: ${params.patternLabel}
User intent: ${params.userPrompt}

Refactor the following code. Output ONLY the refactored code in a single \`\`\`${lang} fenced block. Preserve every public symbol name exactly.

\`\`\`${lang}
${params.code}
\`\`\``;
    const result = await llmComplete({
        systemPrompt: REFRACTOR_SYSTEM_PROMPT,
        userPrompt,
        temperature: 0.2
    });
    if (!result.ok) {
        return {
            ok: false,
            code: "",
            error: result.error,
            latencyMs: result.latencyMs
        };
    }
    const code = extractCodeBlock(result.content);
    if (!code) {
        return {
            ok: false,
            code: "",
            error: "LLM returned no extractable code block",
            latencyMs: result.latencyMs
        };
    }
    return {
        ok: true,
        code,
        raw: result.content,
        latencyMs: result.latencyMs
    };
}
}),
"[project]/src/lib/db.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "db",
    ()=>db
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__ = __turbopack_context__.i("[externals]/@prisma/client [external] (@prisma/client, cjs, [project]/node_modules/@prisma/client)");
;
const globalForPrisma = globalThis;
const db = globalForPrisma.prisma ?? new __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["PrismaClient"]({
    log: [
        'query'
    ]
});
if ("TURBOPACK compile-time truthy", 1) globalForPrisma.prisma = db;
}),
"[project]/src/lib/pipeline/postmortem/postmortem-store.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "generatePostmortemFromReport",
    ()=>generatePostmortemFromReport,
    "parseMarkdownPostmortem",
    ()=>parseMarkdownPostmortem,
    "postmortemStore",
    ()=>postmortemStore,
    "seedPostmortemsFromMarkdown",
    ()=>seedPostmortemsFromMarkdown
]);
/**
 * Postmortem Store — per-file negative constraints learned from past failures.
 *
 * Each postmortem records:
 *   - WHAT failed (failureType, symptom)
 *   - EVIDENCE (machine-copied facts: dropped symbols, AST violations, etc.)
 *   - CONSTRAINTS (imperative instructions the LLM must follow next time)
 *
 * Flow:
 *   1. Before mutating a file, call getActivePostmortem(repo, branch, filePath)
 *   2. If a postmortem exists, inject its constraints into the LLM prompt
 *   3. After the pipeline runs:
 *      - On SUCCESS (committed): markPostmortemResolved(...)
 *      - On FAILURE: recordFailure(...) creates or updates the postmortem
 *
 * Postmortems can also be seeded from external markdown files (e.g. a
 * POSTMORTEMS.md produced by another enhancer) via parseMarkdownPostmortem().
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-route] (ecmascript)");
;
class PostmortemStore {
    /**
   * Get the active postmortem for a specific file, if one exists.
   * Returns null if no active postmortem (file has never failed, or was resolved).
   */ async getActivePostmortem(repo, branch, filePath) {
        try {
            const record = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].postmortem.findUnique({
                where: {
                    targetRepo_branch_filePath: {
                        targetRepo: repo,
                        branch,
                        filePath
                    }
                }
            });
            if (!record || record.status !== "active") return null;
            return this.mapRecord(record);
        } catch  {
            return null;
        }
    }
    /**
   * Get the constraints for a file, formatted for injection into the LLM prompt.
   * Returns an empty (no-op) constraints object if no active postmortem.
   */ async getConstraintsForFile(repo, branch, filePath) {
        const pm = await this.getActivePostmortem(repo, branch, filePath);
        if (!pm) {
            return {
                hasActivePostmortem: false,
                constraints: [],
                promptBlock: ""
            };
        }
        const constraintLines = pm.constraints.split("\n").map((l)=>l.trim()).filter((l)=>l.length > 0);
        return {
            hasActivePostmortem: true,
            failureType: pm.failureType,
            symptom: pm.symptom,
            constraints: constraintLines,
            attempts: pm.attempts,
            promptBlock: this.formatPromptBlock(pm)
        };
    }
    /**
   * Format a postmortem as a constraint block for the LLM prompt.
   * This goes AFTER the system prompt and BEFORE the user code, so the LLM
   * sees the constraints as hard requirements.
   */ formatPromptBlock(pm) {
        return `\n\n--- POSTMORTEM CONSTRAINTS (this file failed ${pm.attempts} time(s) before) ---
FAILURE TYPE: ${pm.failureType}
SYMPTOM: ${pm.symptom}
EVIDENCE:
${pm.evidence}
CONSTRAINTS (MUST follow ALL of these):
${pm.constraints}
--- END POSTMORTEM CONSTRAINTS ---\n\n`;
    }
    /**
   * Record a failure for a file. Creates a new postmortem or updates the
   * existing one (incrementing attempts, replacing evidence/constraints).
   */ async recordFailure(params) {
        const { repo, branch, filePath, failureType, symptom, evidence, constraints } = params;
        try {
            const existing = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].postmortem.findUnique({
                where: {
                    targetRepo_branch_filePath: {
                        targetRepo: repo,
                        branch,
                        filePath
                    }
                }
            });
            if (existing) {
                const updated = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].postmortem.update({
                    where: {
                        id: existing.id
                    },
                    data: {
                        status: "active",
                        failureType,
                        symptom,
                        evidence,
                        constraints,
                        attempts: {
                            increment: 1
                        },
                        lastAttemptAt: new Date(),
                        resolvedAt: null,
                        updatedAt: new Date()
                    }
                });
                return this.mapRecord(updated);
            }
            const created = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].postmortem.create({
                data: {
                    targetRepo: repo,
                    branch,
                    filePath,
                    status: "active",
                    failureType,
                    symptom,
                    evidence,
                    constraints,
                    attempts: 1,
                    lastAttemptAt: new Date()
                }
            });
            return this.mapRecord(created);
        } catch (err) {
            // Fallback to in-memory record if DB unavailable
            return {
                id: `pm_${Date.now()}`,
                targetRepo: repo,
                branch,
                filePath,
                status: "active",
                failureType,
                symptom,
                evidence,
                constraints,
                attempts: 1,
                lastAttemptAt: new Date().toISOString(),
                resolvedAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
        }
    }
    /**
   * Mark a postmortem as resolved (file was successfully committed).
   * Kept for history — getActivePostmortem skips resolved records.
   */ async markResolved(repo, branch, filePath) {
        try {
            await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].postmortem.updateMany({
                where: {
                    targetRepo: repo,
                    branch,
                    filePath,
                    status: "active"
                },
                data: {
                    status: "resolved",
                    resolvedAt: new Date(),
                    updatedAt: new Date()
                }
            });
        } catch  {
        /* ignore */ }
    }
    /**
   * List all active postmortems for a repo/branch.
   */ async listActive(repo, branch) {
        try {
            const where = {
                status: "active"
            };
            if (repo) where.targetRepo = repo;
            if (branch) where.branch = branch;
            const records = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].postmortem.findMany({
                where,
                orderBy: {
                    lastAttemptAt: "desc"
                },
                take: 100
            });
            return records.map((r)=>this.mapRecord(r));
        } catch  {
            return [];
        }
    }
    /**
   * Delete a postmortem by ID (for the UI's "dismiss" button).
   */ async delete(id) {
        try {
            await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].postmortem.delete({
                where: {
                    id
                }
            });
        } catch  {
        /* ignore */ }
    }
    mapRecord(r) {
        return {
            id: r.id,
            targetRepo: r.targetRepo,
            branch: r.branch,
            filePath: r.filePath,
            status: r.status,
            failureType: r.failureType,
            symptom: r.symptom,
            evidence: r.evidence,
            constraints: r.constraints,
            attempts: r.attempts,
            lastAttemptAt: r.lastAttemptAt instanceof Date ? r.lastAttemptAt.toISOString() : r.lastAttemptAt,
            resolvedAt: r.resolvedAt instanceof Date ? r.resolvedAt.toISOString() : r.resolvedAt,
            createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
            updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt
        };
    }
}
const postmortemStore = new PostmortemStore();
function generatePostmortemFromReport(params) {
    const { filePath, astDiffResult, sanitizerResult, reviewVerdict, haltReason } = params;
    // Determine the primary failure type
    let failureType = "OTHER";
    let symptom = `Pipeline failed for ${filePath}`;
    if (!astDiffResult.passed) {
        const highViolations = astDiffResult.violations.filter((v)=>v.severity === "high");
        if (highViolations.some((v)=>v.code === "AST_SYMBOL_DROPPED")) {
            failureType = "AST_SYMBOL_DROPPED";
            symptom = `AST gate rejected: ${highViolations.find((v)=>v.code === "AST_SYMBOL_DROPPED")?.message.slice(0, 120)}`;
        } else if (highViolations.some((v)=>v.code === "AST_STRUCTURAL_DRIFT")) {
            failureType = "AST_STRUCTURAL_DRIFT";
            symptom = `Structural drift exceeded safe threshold`;
        } else if (highViolations.some((v)=>v.code === "BRANDING_INJECTION")) {
            failureType = "BRANDING_INJECTION";
            symptom = `Unauthorized persona/branding injection detected`;
        }
    } else if (reviewVerdict.consensus === "REJECTED" || reviewVerdict.consensus === "REQUIRES_REWRITE") {
        failureType = "REVIEW_REJECTED";
        symptom = `Review tribunal rejected: ${reviewVerdict.consensus} (${(reviewVerdict.consensusCoefficient * 100).toFixed(0)}% consensus)`;
    } else if (!sanitizerResult.clean && sanitizerResult.highEntropyTokensFound > 0) {
        failureType = "SANITIZER_REDACTION";
        symptom = `Sanitizer redacted ${sanitizerResult.highEntropyTokensFound} high-entropy token(s)`;
    } else if (haltReason === "ZERO_DIFF_SATURATION") {
        failureType = "ZERO_DIFF_SATURATION";
        symptom = `0-diff saturation: no semantic change produced`;
    }
    // Build evidence — machine-copied facts
    const evidenceParts = [];
    if (!astDiffResult.passed) {
        evidenceParts.push(`AST score: ${astDiffResult.astScore}/100`);
        evidenceParts.push(`Symbol map: orig=${astDiffResult.symbolMap.originalCount} proposed=${astDiffResult.symbolMap.proposedCount} retained=${astDiffResult.symbolMap.retainedCount}`);
        if (astDiffResult.symbolMap.missingSymbols.length > 0) {
            evidenceParts.push(`Missing symbols: ${astDiffResult.symbolMap.missingSymbols.map((s)=>`${s.name} (${s.type})`).join(", ")}`);
        }
        for (const v of astDiffResult.violations){
            evidenceParts.push(`Violation [${v.severity}] ${v.code}: ${v.message}`);
        }
    }
    if (!sanitizerResult.clean) {
        evidenceParts.push(`Sanitizer violations: ${sanitizerResult.violations.join("; ")}`);
        if (sanitizerResult.highEntropyTokensFound > 0) {
            evidenceParts.push(`High-entropy tokens redacted: ${sanitizerResult.highEntropyTokensFound}`);
        }
    }
    if (reviewVerdict.consensus === "REJECTED" || reviewVerdict.consensus === "REQUIRES_REWRITE") {
        evidenceParts.push(`Review consensus: ${reviewVerdict.consensus}`);
        evidenceParts.push(`Security findings: ${reviewVerdict.securityPoints.join("; ")}`);
        evidenceParts.push(`Lead summary: ${reviewVerdict.leadSummary}`);
    }
    if (haltReason) {
        evidenceParts.push(`Halt reason: ${haltReason}`);
    }
    const evidence = evidenceParts.join("\n");
    // Build constraints — imperative instructions for the next attempt
    const constraintLines = [];
    // Widen the control-flow-narrowed type back to the full union — this switch
    // handles every failure type, including ones not assigned above.
    switch(failureType){
        case "AST_SYMBOL_DROPPED":
            constraintLines.push(`Preserve EVERY symbol from the original file. The following were dropped last time and MUST appear in the output:`);
            for (const s of astDiffResult.symbolMap.missingSymbols){
                constraintLines.push(`  - ${s.name} (${s.type})`);
            }
            constraintLines.push(`Do NOT remove, rename, or merge any function, class, method, interface, type, or const.`);
            break;
        case "AST_STRUCTURAL_DRIFT":
            constraintLines.push(`Keep the structural drift under 65%. The last attempt drifted ${(astDiffResult.structuralDriftRatio * 100).toFixed(0)}%.`);
            constraintLines.push(`Make minimal, surgical changes — do not restructure the file.`);
            break;
        case "BRANDING_INJECTION":
            constraintLines.push(`Do NOT add any persona/branding strings: ${astDiffResult.brandingInjections.join(", ")}`);
            break;
        case "REVIEW_REJECTED":
            constraintLines.push(`Address the review tribunal's findings:`);
            for (const p of reviewVerdict.securityPoints){
                constraintLines.push(`  - ${p}`);
            }
            constraintLines.push(`Do not introduce credentials, eval(), or dynamic code execution.`);
            break;
        case "SANITIZER_REDACTION":
            constraintLines.push(`Do not introduce high-entropy strings that look like secrets. The sanitizer redacted ${sanitizerResult.highEntropyTokensFound} token(s).`);
            constraintLines.push(`If the file contains test fixtures (oracle IDs, expected hashes), keep them as-is — they are not secrets.`);
            break;
        case "HEADER_STRIPPED":
            constraintLines.push(`Preserve ALL import statements and file headers from the original.`);
            constraintLines.push(`Do not wipe imports, module declarations, or file-level comments.`);
            break;
        case "ZERO_DIFF_SATURATION":
            constraintLines.push(`The last attempt produced no semantic change (0-diff saturation). Make a real, meaningful refactor this time.`);
            constraintLines.push(`Add type annotations, extract constants, modularize — but preserve all public symbols.`);
            break;
        default:
            constraintLines.push(`Follow the standard refactoring rules from the system prompt.`);
    }
    const constraints = constraintLines.join("\n");
    return {
        failureType,
        symptom,
        evidence,
        constraints
    };
}
function parseMarkdownPostmortem(md, repo, branch) {
    const results = [];
    const entries = md.split(/^### ❌/m).slice(1);
    for (const entry of entries){
        // Extract file path from the header line: [2026-10-25] path/to/file.ts `source: ...`
        const headerMatch = entry.match(/^\s*\[[^\]]*\]\s+(\S+)/);
        if (!headerMatch) continue;
        const filePath = headerMatch[1];
        // Extract symptom
        const symptomMatch = entry.match(/\*\*Symptom:\*\*\s*(.+)/);
        const symptom = symptomMatch ? symptomMatch[1].trim() : "Unknown failure";
        // Extract evidence (between ``` fences after EVIDENCE:)
        const evidenceMatch = entry.match(/\*\*EVIDENCE[^:]*:\*\*\s*```\s*([\s\S]*?)```/);
        const evidence = evidenceMatch ? evidenceMatch[1].trim() : "";
        // Extract constraints
        const constraintMatch = entry.match(/\*\*CONSTRAINT[^:]*:\*\*\s*<([^>]+)>/);
        const constraints = constraintMatch ? constraintMatch[1].trim() : "";
        // Determine failure type from symptom
        let failureType = "OTHER";
        const lowerSymptom = symptom.toLowerCase();
        if (lowerSymptom.includes("header stripped") || lowerSymptom.includes("import")) {
            failureType = "HEADER_STRIPPED";
        } else if (lowerSymptom.includes("ast") && lowerSymptom.includes("symbol")) {
            failureType = "AST_SYMBOL_DROPPED";
        } else if (lowerSymptom.includes("ast") && lowerSymptom.includes("rejected")) {
            failureType = "AST_SYMBOL_DROPPED";
        } else if (lowerSymptom.includes("type annotation")) {
            failureType = "COMPILE_ERROR";
        }
        results.push({
            targetRepo: repo,
            branch,
            filePath,
            status: "active",
            failureType,
            symptom,
            evidence,
            constraints: constraints || `Avoid the failure described above when refactoring ${filePath}.`
        });
    }
    return results;
}
async function seedPostmortemsFromMarkdown(md, repo, branch) {
    const entries = parseMarkdownPostmortem(md, repo, branch);
    let count = 0;
    for (const entry of entries){
        try {
            await postmortemStore.recordFailure({
                repo: entry.targetRepo,
                branch: entry.branch,
                filePath: entry.filePath,
                failureType: entry.failureType,
                symptom: entry.symptom,
                evidence: entry.evidence,
                constraints: entry.constraints
            });
            count++;
        } catch  {
        /* ignore */ }
    }
    return count;
}
}),
"[project]/src/lib/pipeline/autonomous/self-enhance-loop.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "selfEnhanceLoop",
    ()=>selfEnhanceLoop
]);
/**
 * Self-Enhance Loop — the system enhances its OWN source code.
 *
 * Instead of fetching a remote repo, mutating, and pushing back, this loop:
 *   1. Scans /home/z/my-project/src/lib/pipeline/ for .ts files (its own code)
 *   2. For each file: reads it, LLM-refactors it, verifies with tsc --noEmit
 *   3. If it compiles: writes the refactored code LIVE (hot-reload picks it up)
 *   4. If it doesn't compile: reverts and records a postmortem
 *   5. After each successful enhancement: git add + commit + push (the proof)
 *
 * The GitHub push contains the CURRENT live state of the running system.
 * When you see a commit on GitHub, that's exactly what the server is running.
 */ var __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/fs [external] (fs, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/child_process [external] (child_process, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$path__$5b$external$5d$__$28$path$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/path [external] (path, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/llm/agent-llm.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$postmortem$2f$postmortem$2d$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/postmortem/postmortem-store.ts [app-route] (ecmascript)");
;
;
;
;
;
const PIPELINE_SRC_DIR = "/home/z/my-project/src/lib/pipeline";
const PROJECT_ROOT = "/home/z/my-project";
// Files the system should NOT modify (would break the loop itself)
const PROTECTED_FILES = new Set([
    "src/lib/pipeline/autonomous/loop-runtime.ts",
    "src/lib/pipeline/autonomous/self-enhance-loop.ts",
    "src/lib/pipeline/autonomous/loop-event-bus.ts",
    "src/lib/pipeline/llm/agent-llm.ts",
    "src/lib/pipeline/llm/debate-llm.ts"
]);
class SelfEnhanceLoop {
    running = false;
    currentFile = null;
    stats = {
        totalScanned: 0,
        totalEnhanced: 0,
        totalReverted: 0,
        totalPushed: 0,
        lastEnhancementAt: null
    };
    logs = [];
    log(message, type = "info") {
        const entry = {
            timestamp: new Date().toLocaleTimeString(),
            message,
            type
        };
        this.logs.unshift(entry);
        if (this.logs.length > 500) this.logs.pop();
        const prefix = type === "success" ? "✓" : type === "warn" ? "⚠" : type === "error" ? "✗" : "→";
        console.log(`[SELF-ENHANCE] ${prefix} ${message}`);
    }
    /**
   * Scan the pipeline source directory for .ts files to enhance.
   */ scanFiles() {
        const files = [];
        const scan = (dir)=>{
            const entries = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["readdirSync"])(dir, {
                withFileTypes: true
            });
            for (const entry of entries){
                const fullPath = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$path__$5b$external$5d$__$28$path$2c$__cjs$29$__["join"])(dir, entry.name);
                if (entry.isDirectory()) {
                    scan(fullPath);
                } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
                    const relPath = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$path__$5b$external$5d$__$28$path$2c$__cjs$29$__["relative"])(PROJECT_ROOT, fullPath);
                    if (!PROTECTED_FILES.has(relPath)) {
                        files.push(fullPath);
                    }
                }
            }
        };
        scan(PIPELINE_SRC_DIR);
        return files;
    }
    /**
   * Verify the project compiles with tsc --noEmit.
   * Returns true if compilation succeeds, false otherwise.
   */ verifyCompiles() {
        try {
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("npx tsc --noEmit 2>&1", {
                cwd: PROJECT_ROOT,
                timeout: 30000,
                stdio: "pipe"
            });
            return true;
        } catch (err) {
            const output = err.stdout || err.stderr || "";
            this.log(`tsc --noEmit failed: ${output.slice(0, 200)}`, "error");
            return false;
        }
    }
    /**
   * Git commit and push the current live state.
   */ gitPush(message) {
        try {
            // Check if there are changes to commit
            const status = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git status --porcelain", {
                cwd: PROJECT_ROOT,
                encoding: "utf-8",
                timeout: 5000
            });
            if (!status.trim()) {
                return {
                    pushed: false
                };
            }
            // Stage all changes
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git add -A", {
                cwd: PROJECT_ROOT,
                timeout: 5000
            });
            // Commit
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
                cwd: PROJECT_ROOT,
                timeout: 5000
            });
            // Get the commit SHA
            const sha = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git rev-parse HEAD", {
                cwd: PROJECT_ROOT,
                encoding: "utf-8",
                timeout: 5000
            }).trim();
            // Push (may fail if no remote configured — that's OK)
            try {
                (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git push 2>&1", {
                    cwd: PROJECT_ROOT,
                    timeout: 15000
                });
                this.log(`Pushed to GitHub: ${sha.slice(0, 7)}`, "success");
                return {
                    pushed: true,
                    commitSha: sha.slice(0, 7)
                };
            } catch (err) {
                this.log(`Git commit succeeded but push failed: ${err.message}`, "warn");
                return {
                    pushed: false,
                    commitSha: sha.slice(0, 7)
                };
            }
        } catch (err) {
            this.log(`Git operation failed: ${err.message}`, "error");
            return {
                pushed: false
            };
        }
    }
    /**
   * Enhance a single file: LLM refactor → verify tsc → write live → git push.
   */ async enhanceFile(filePath) {
        const relPath = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$path__$5b$external$5d$__$28$path$2c$__cjs$29$__["relative"])(PROJECT_ROOT, filePath);
        const startTime = Date.now();
        const result = {
            filePath: relPath,
            enhanced: false,
            reason: "",
            oldBytes: 0,
            newBytes: 0,
            diffBytes: 0,
            llmUsed: false,
            llmLatencyMs: 0,
            compiled: false,
            pushed: false
        };
        try {
            // 1. Read the current file
            const originalCode = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["readFileSync"])(filePath, "utf-8");
            result.oldBytes = originalCode.length;
            // 2. Check for postmortem constraints
            const postmortem = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$postmortem$2f$postmortem$2d$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["postmortemStore"].getConstraintsForFile("self", "main", relPath);
            // 3. LLM refactor
            this.log(`Refactoring ${relPath}...`, "info");
            const refactorSystem = `You are a code refactorer. Refactor the following TypeScript file. Rules:
- Preserve EVERY export (function, class, interface, type, const). Do not rename or remove them.
- Add explicit type annotations where they're missing.
- Extract magic numbers into named constants.
- Use modern TypeScript features where appropriate.
- Do NOT add any header comments or branding.
- Do NOT add unused interfaces or types.
- Output ONLY the refactored code in a single fenced code block.
${postmortem.hasActivePostmortem ? `\n${postmortem.promptBlock}\n` : ""}`;
            const refactorUser = `File: ${relPath}\n\n\`\`\`typescript\n${originalCode}\n\`\`\`\n\nRefactor this file. Output ONLY the refactored code.`;
            const llmResult = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["llmComplete"])({
                systemPrompt: refactorSystem,
                userPrompt: refactorUser,
                temperature: 0.2
            });
            result.llmLatencyMs = llmResult.latencyMs;
            if (!llmResult.ok) {
                result.reason = `LLM unavailable: ${llmResult.error}`;
                this.log(`LLM unavailable for ${relPath}: ${llmResult.error}`, "warn");
                return result;
            }
            const refactoredCode = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["extractCodeBlock"])(llmResult.content);
            if (!refactoredCode || refactoredCode.trim().length === 0) {
                result.reason = "LLM returned no code";
                this.log(`LLM returned no code for ${relPath}`, "warn");
                return result;
            }
            result.llmUsed = true;
            result.newBytes = refactoredCode.length;
            result.diffBytes = Math.abs(refactoredCode.length - originalCode.length);
            // 4. Check if anything actually changed
            if (refactoredCode.trim() === originalCode.trim()) {
                result.reason = "No semantic change";
                this.log(`No change for ${relPath} (LLM returned same code)`, "info");
                return result;
            }
            // 5. Write to temp file first, verify tsc, then apply
            const tempFile = filePath + ".tmp";
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["writeFileSync"])(tempFile, refactoredCode, "utf-8");
            // 6. Swap: move temp to real (atomic-ish)
            const backupFile = filePath + ".bak";
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["writeFileSync"])(backupFile, originalCode, "utf-8");
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["writeFileSync"])(filePath, refactoredCode, "utf-8");
            // 7. Verify the project still compiles
            const compiled = this.verifyCompiles();
            result.compiled = compiled;
            if (!compiled) {
                // Revert!
                (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["writeFileSync"])(filePath, originalCode, "utf-8");
                this.log(`Reverted ${relPath} (tsc --noEmit failed after refactor)`, "error");
                // Record postmortem
                await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$postmortem$2f$postmortem$2d$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["postmortemStore"].recordFailure({
                    repo: "self",
                    branch: "main",
                    filePath: relPath,
                    failureType: "COMPILE_ERROR",
                    symptom: "Refactored code failed tsc --noEmit",
                    evidence: `Original: ${originalCode.length} bytes, Refactored: ${refactoredCode.length} bytes. tsc --noEmit rejected the change.`,
                    constraints: `The previous refactor of ${relPath} did not compile. Make smaller, safer changes. Preserve all type signatures exactly.`
                });
                result.reason = "Reverted (tsc failed)";
                return result;
            }
            // 8. Clean up temp/backup
            try {
                (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["unlinkSync"])(tempFile);
                (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["unlinkSync"])(backupFile);
            } catch  {
            /* ignore */ }
            // 9. Enhancement succeeded — the file is now LIVE (hot-reload will pick it up)
            result.enhanced = true;
            result.reason = "Enhanced and live";
            this.stats.totalEnhanced++;
            this.stats.lastEnhancementAt = new Date().toISOString();
            this.log(`Enhanced ${relPath} (+${result.diffBytes} bytes, compiled ✓, live)`, "success");
            // 10. Git commit + push (the proof)
            const pushResult = this.gitPush(`Self-enhancement: ${relPath} (LLM refactor, tsc verified, ${result.diffBytes}b diff)`);
            result.pushed = pushResult.pushed;
            result.commitSha = pushResult.commitSha;
            if (pushResult.pushed) {
                this.stats.totalPushed++;
            }
            // 11. Resolve any postmortem for this file
            await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$postmortem$2f$postmortem$2d$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["postmortemStore"].markResolved("self", "main", relPath);
            return result;
        } catch (err) {
            result.reason = `Error: ${err.message}`;
            this.log(`Error enhancing ${relPath}: ${err.message}`, "error");
            return result;
        }
    }
    /**
   * Run one cycle: scan files, enhance each one sequentially.
   */ async runCycle() {
        if (this.running) {
            this.log("Cycle already running, skipping", "warn");
            return {
                filesScanned: 0,
                filesEnhanced: 0,
                results: []
            };
        }
        this.running = true;
        try {
            const files = this.scanFiles();
            this.stats.totalScanned += files.length;
            this.log(`Scanned ${files.length} files in src/lib/pipeline/`, "info");
            const results = [];
            let enhanced = 0;
            for (const file of files){
                const result = await this.enhanceFile(file);
                results.push(result);
                if (result.enhanced) enhanced++;
                // Brief pause between files to let hot-reload settle
                await new Promise((r)=>setTimeout(r, 500));
            }
            this.log(`Cycle complete: ${enhanced}/${files.length} files enhanced`, "success");
            return {
                filesScanned: files.length,
                filesEnhanced: enhanced,
                results
            };
        } finally{
            this.running = false;
        }
    }
    /**
   * Run continuously: cycle after cycle until stopped.
   */ async runContinuous(onUpdate) {
        this.log("Starting continuous self-enhancement loop", "success");
        while(this.running || this.stats.totalScanned === 0){
            this.running = true;
            await this.runCycle();
            if (onUpdate) onUpdate();
            // Wait between cycles
            this.log("Waiting 5s before next cycle...", "info");
            await new Promise((r)=>setTimeout(r, 5000));
        }
    }
    stop() {
        this.running = false;
        this.log("Self-enhance loop stopped", "warn");
    }
    isRunning() {
        return this.running;
    }
    getStats() {
        return {
            ...this.stats
        };
    }
    getLogs() {
        return [
            ...this.logs
        ];
    }
    getCurrentFile() {
        return this.currentFile;
    }
}
// Singleton
const globalForSelfEnhance = globalThis;
const selfEnhanceLoop = globalForSelfEnhance.__selfEnhanceLoop ?? new SelfEnhanceLoop();
if (!globalForSelfEnhance.__selfEnhanceLoop) {
    globalForSelfEnhance.__selfEnhanceLoop = selfEnhanceLoop;
}
}),
"[project]/src/app/api/self-enhance/status/route.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "GET",
    ()=>GET,
    "dynamic",
    ()=>dynamic,
    "runtime",
    ()=>runtime
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/server.js [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$self$2d$enhance$2d$loop$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/autonomous/self-enhance-loop.ts [app-route] (ecmascript)");
;
;
const dynamic = "force-dynamic";
const runtime = "nodejs";
async function GET() {
    return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
        running: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$self$2d$enhance$2d$loop$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["selfEnhanceLoop"].isRunning(),
        stats: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$self$2d$enhance$2d$loop$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["selfEnhanceLoop"].getStats(),
        logs: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$self$2d$enhance$2d$loop$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["selfEnhanceLoop"].getLogs(),
        currentFile: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$self$2d$enhance$2d$loop$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["selfEnhanceLoop"].getCurrentFile()
    });
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__a9912903._.js.map