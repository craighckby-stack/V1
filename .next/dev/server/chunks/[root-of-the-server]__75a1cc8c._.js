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
"[project]/src/lib/pipeline/autonomous/chat-task.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "applyTaskPlan",
    ()=>applyTaskPlan,
    "proposeTaskPlan",
    ()=>proposeTaskPlan
]);
/**
 * Chat Task — turns the terminal into a chat-driven coding agent.
 *
 * Instead of the autonomous loop running blindly, the user types a goal in
 * plain English. This module:
 *   1. Gathers codebase context (file list, recent git changes)
 *   2. Sends the user's goal + context to the LLM
 *   3. The LLM proposes a plan: which files to change, what to change, why
 *   4. Returns the plan to the user for approval
 *   5. On approval, applies the changes through the verify-typecheck-push pipeline
 *
 * This is Direction 1 from DIRECTIONS.md — the user IS the feedback signal.
 */ var __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/fs [external] (fs, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/child_process [external] (child_process, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$path__$5b$external$5d$__$28$path$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/path [external] (path, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/llm/agent-llm.ts [app-route] (ecmascript)");
;
;
;
;
const PROJECT_ROOT = "/home/z/my-project";
/**
 * Gather codebase context for the LLM:
 * - List of source files with sizes
 * - Recent git log (last 5 commits)
 * - Current git status
 */ function gatherContext() {
    const lines = [];
    // 1. Source files
    const srcDir = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$path__$5b$external$5d$__$28$path$2c$__cjs$29$__["join"])(PROJECT_ROOT, "src");
    const files = [];
    const scan = (dir, depth = 0)=>{
        if (depth > 3) return;
        try {
            const entries = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["readdirSync"])(dir, {
                withFileTypes: true
            });
            for (const entry of entries){
                if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
                const full = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$path__$5b$external$5d$__$28$path$2c$__cjs$29$__["join"])(dir, entry.name);
                if (entry.isDirectory()) {
                    scan(full, depth + 1);
                } else if (/\.(ts|tsx)$/.test(entry.name)) {
                    const rel = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$path__$5b$external$5d$__$28$path$2c$__cjs$29$__["relative"])(PROJECT_ROOT, full);
                    try {
                        const size = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["statSync"])(full).size;
                        files.push(`${rel} (${size}b)`);
                    } catch  {
                        files.push(rel);
                    }
                }
            }
        } catch  {
        // ignore
        }
    };
    scan(srcDir);
    lines.push("SOURCE FILES:");
    lines.push(files.slice(0, 50).join("\n"));
    // 2. Recent commits
    try {
        const log = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git log --oneline -5", {
            cwd: PROJECT_ROOT,
            encoding: "utf-8",
            timeout: 5000
        }).trim();
        lines.push("\nRECENT COMMITS:");
        lines.push(log);
    } catch  {
    // ignore
    }
    // 3. Git status
    try {
        const status = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git status --porcelain", {
            cwd: PROJECT_ROOT,
            encoding: "utf-8",
            timeout: 5000
        }).trim();
        lines.push("\nGIT STATUS:");
        lines.push(status || "(clean)");
    } catch  {
    // ignore
    }
    return lines.join("\n");
}
async function proposeTaskPlan(userGoal) {
    const context = gatherContext();
    const systemPrompt = `You are a senior coding agent working inside a Next.js project. The user will describe a goal. Your job is to propose a plan to achieve it.

You have access to the project's file list, recent commits, and git status. You do NOT see file contents yet — you're proposing which files to touch and why.

Output format (mandatory):
First, write your understanding of the goal (1-2 sentences).
Then, list the files to modify or create, with a reason for each.
Then, provide a short summary.

Use this exact format:

UNDERSTANDING: <your understanding of what the user wants>

FILES:
- <path> — <modify|create> — <why>
- <path> — <modify|create> — <why>

SUMMARY: <one sentence summary of the plan>

Rules:
- Only propose changes to files in the src/ directory
- Be conservative — propose the minimum changes needed
- If the goal is unclear, say so in UNDERSTANDING and propose what you think they meant
- Max 5 files per plan
- Paths must be relative to the project root (e.g. src/lib/foo.ts)`;
    const userPrompt = `CODEBASE CONTEXT:
${context}

USER GOAL:
${userGoal}

Propose a plan to achieve this goal.`;
    const result = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["llmComplete"])({
        systemPrompt,
        userPrompt,
        temperature: 0.3
    });
    if (!result.ok) {
        return {
            ok: false,
            userGoal,
            understanding: "",
            files: [],
            summary: "",
            error: result.error ?? "LLM unavailable"
        };
    }
    return parsePlan(result.content, userGoal);
}
/**
 * Parse the LLM's plan response into structured data.
 */ function parsePlan(raw, userGoal) {
    const plan = {
        ok: true,
        userGoal,
        understanding: "",
        files: [],
        summary: ""
    };
    const understandingMatch = raw.match(/UNDERSTANDING:\s*(.+)/i);
    if (understandingMatch) plan.understanding = understandingMatch[1].trim();
    const summaryMatch = raw.match(/SUMMARY:\s*(.+)/i);
    if (summaryMatch) plan.summary = summaryMatch[1].trim();
    // Parse files: lines starting with "- path — action — reason" or "- path - action - reason"
    const filesSection = raw.match(/FILES:\s*\n([\s\S]*?)(?:\n\n|\nSUMMARY:|$)/i);
    if (filesSection) {
        const fileLines = filesSection[1].split("\n").filter((l)=>l.trim().startsWith("-"));
        for (const line of fileLines){
            // Match: - path — modify — reason  (em dash)
            // or:    - path - modify - reason  (hyphen)
            const match = line.match(/^-\s*(\S+)\s*[—-]\s*(modify|create)\s*[—-]\s*(.+)/i);
            if (match) {
                plan.files.push({
                    path: match[1].trim(),
                    action: match[2].toLowerCase(),
                    reason: match[3].trim()
                });
            }
        }
    }
    if (!plan.understanding && plan.files.length === 0) {
        plan.ok = false;
        plan.error = "Could not parse LLM plan";
    }
    return plan;
}
async function applyTaskPlan(plan) {
    const results = [];
    for (const file of plan.files){
        const fullPath = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$path__$5b$external$5d$__$28$path$2c$__cjs$29$__["join"])(PROJECT_ROOT, file.path);
        let originalCode = "";
        try {
            originalCode = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["readFileSync"])(fullPath, "utf-8");
        } catch  {
            if (file.action === "modify") {
                results.push({
                    path: file.path,
                    applied: false,
                    reason: "File not found (action was 'modify')",
                    diffBytes: 0
                });
                continue;
            }
        // create — start from empty
        }
        // Ask the LLM to generate the new file content
        const systemPrompt = `You are a coding agent applying a specific change to a TypeScript file. The user approved a plan. Your job is to output the COMPLETE new file content that achieves the goal.

Rules:
- Preserve every existing export (function, class, interface, type, const) — do not rename or remove
- Only make the changes needed for the task
- Output ONLY the complete file content in a single fenced \`\`\`typescript code block
- Do NOT add header comments, banners, or branding
- If modifying, keep all existing code that isn't part of the change`;
        const userPrompt = `GOAL: ${plan.userGoal}

FILE: ${file.path}
ACTION: ${file.action}
REASON: ${file.reason}

${file.action === "modify" ? `CURRENT CONTENT:\n\`\`\`typescript\n${originalCode}\n\`\`\`` : "(new file)"}

Output the COMPLETE new content for this file that achieves the goal.`;
        const llmResult = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["llmComplete"])({
            systemPrompt,
            userPrompt,
            temperature: 0.2
        });
        if (!llmResult.ok) {
            results.push({
                path: file.path,
                applied: false,
                reason: `LLM failed: ${llmResult.error}`,
                diffBytes: 0
            });
            continue;
        }
        const newCode = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["extractCodeBlock"])(llmResult.content);
        if (!newCode || newCode.trim().length === 0) {
            results.push({
                path: file.path,
                applied: false,
                reason: "LLM returned no code",
                diffBytes: 0
            });
            continue;
        }
        // Basic truncation check
        const opens = (newCode.match(/{/g) || []).length;
        const closes = (newCode.match(/}/g) || []).length;
        if (opens !== closes) {
            results.push({
                path: file.path,
                applied: false,
                reason: `Rejected (unbalanced braces: ${opens} { vs ${closes} })`,
                diffBytes: 0
            });
            continue;
        }
        // Write the file
        try {
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$fs__$5b$external$5d$__$28$fs$2c$__cjs$29$__["writeFileSync"])(fullPath, newCode, "utf-8");
            const diffBytes = Math.abs(newCode.length - originalCode.length);
            results.push({
                path: file.path,
                applied: true,
                reason: `Applied (${diffBytes}b diff)`,
                diffBytes
            });
        } catch (err) {
            results.push({
                path: file.path,
                applied: false,
                reason: `Write failed: ${err.message}`,
                diffBytes: 0
            });
        }
    }
    // Verify the project still compiles
    let compiled = false;
    try {
        (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("npx tsc --noEmit 2>&1", {
            cwd: PROJECT_ROOT,
            timeout: 30000,
            stdio: "pipe"
        });
        compiled = true;
    } catch  {
        compiled = false;
    }
    if (!compiled) {
        // Revert all changes
        try {
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git checkout -- .", {
                cwd: PROJECT_ROOT,
                timeout: 5000,
                stdio: "pipe"
            });
        } catch  {
        // ignore
        }
        return {
            ok: false,
            results: results.map((r)=>({
                    ...r,
                    applied: false,
                    reason: `Reverted (tsc failed): ${r.reason}`
                })),
            pushed: false,
            error: "Project failed to compile after changes — all changes reverted"
        };
    }
    // Commit and push
    let pushed = false;
    let commitSha;
    try {
        const status = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git status --porcelain", {
            cwd: PROJECT_ROOT,
            encoding: "utf-8",
            timeout: 5000
        });
        if (status.trim()) {
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git add -A", {
                cwd: PROJECT_ROOT,
                timeout: 5000
            });
            const commitMsg = `Chat task: ${plan.userGoal.slice(0, 60)}\n\n${plan.summary}`;
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])(`git commit -m "${commitMsg.replace(/"/g, '\\"').slice(0, 200)}"`, {
                cwd: PROJECT_ROOT,
                timeout: 5000,
                stdio: "pipe"
            });
            commitSha = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git rev-parse HEAD", {
                cwd: PROJECT_ROOT,
                encoding: "utf-8",
                timeout: 5000
            }).trim().slice(0, 7);
            // Try to push using the configured remote (auth via env if available)
            try {
                // Check if origin is configured
                const remote = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git remote", {
                    cwd: PROJECT_ROOT,
                    encoding: "utf-8",
                    timeout: 5000,
                    stdio: "pipe"
                }).trim();
                if (remote.includes("origin")) {
                    (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git push origin main 2>&1", {
                        cwd: PROJECT_ROOT,
                        timeout: 15000,
                        stdio: "pipe"
                    });
                    pushed = true;
                }
            } catch  {
                pushed = false;
            }
        }
    } catch (err) {
        return {
            ok: true,
            results,
            pushed: false,
            commitSha,
            error: `Changes applied but git failed: ${err.message}`
        };
    }
    return {
        ok: true,
        results,
        pushed,
        commitSha
    };
}
}),
"[project]/src/app/api/self-enhance/chat-task/propose/route.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "POST",
    ()=>POST,
    "dynamic",
    ()=>dynamic,
    "runtime",
    ()=>runtime
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/server.js [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$chat$2d$task$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/autonomous/chat-task.ts [app-route] (ecmascript)");
;
;
const dynamic = "force-dynamic";
const runtime = "nodejs";
async function POST(req) {
    try {
        const body = await req.json();
        if (!body.goal || !body.goal.trim()) {
            return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
                ok: false,
                error: "A goal is required"
            }, {
                status: 400
            });
        }
        const plan = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$chat$2d$task$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["proposeTaskPlan"])(body.goal.trim());
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json(plan);
    } catch (err) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
            ok: false,
            error: err.message
        }, {
            status: 500
        });
    }
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__75a1cc8c._.js.map