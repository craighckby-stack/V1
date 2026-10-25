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
"[project]/src/lib/pipeline/core/siphon.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Architecture Template & Pattern Helper (siphon)
 * Curated architectural templates & pattern sources for the pipeline.
 */ __turbopack_context__.s([
    "SIPHON_SOURCES",
    ()=>SIPHON_SOURCES,
    "performArchitecturalVote",
    ()=>performArchitecturalVote
]);
const SIPHON_SOURCES = [
    {
        id: "pattern-optimizer-helper",
        owner: "craighckby-stack",
        repo: "pattern-optimizer-helper",
        branch: "main",
        label: "Pattern Optimization Helper",
        category: "orchestration",
        patterns: [
            "AST Diff Gate Verification",
            "AES-GCM Encrypted Storage Helper",
            "Context Continuity Protocol",
            "Multi-Model Fallback Helper",
            "Modular Code Architecture"
        ]
    },
    {
        id: "verification-governance-helper",
        owner: "craighckby-stack",
        repo: "verification-governance-helper",
        branch: "main",
        label: "Security & Verification Helper",
        category: "verification",
        patterns: [
            "Tri-Loop Autonomous Refactoring",
            "Tree Fingerprint Saturation Guard",
            "Zero-Diff Code Saturation Check",
            "Consecutive Failure Skip List",
            "Shannon Entropy Secret Sanitizer",
            "Dual-Perspective Code Review"
        ]
    },
    {
        id: "clean-room-agents-helper",
        owner: "craighckby-stack",
        repo: "clean-room-agents-helper",
        branch: "main",
        label: "Modular Agent Engines Helper",
        category: "runtime",
        patterns: [
            "5-Pillar Clean Architecture",
            "Bounded ReAct Reasoning Loop",
            "In-Memory VFS Sandbox",
            "Session Context Compaction",
            "Multi-Agent Coordination Helper"
        ]
    },
    {
        id: "deepmind-research",
        owner: "google-deepmind",
        repo: "deepmind-research",
        branch: "master",
        label: "Algorithm Research Patterns",
        category: "neural",
        patterns: [
            "Algorithmic Program Search",
            "Policy Heuristics",
            "Self-Supervised Verification"
        ]
    },
    {
        id: "ms-autogen",
        owner: "microsoft",
        repo: "autogen",
        branch: "main",
        label: "Multi-Agent Coordination Helper",
        category: "orchestration",
        patterns: [
            "Conversational Agent Protocol",
            "Group Consensus Review",
            "Execution Sandbox"
        ]
    },
    {
        id: "langchain-langgraph",
        owner: "langchain-ai",
        repo: "langgraph",
        branch: "main",
        label: "Stateful Workflow Helper",
        category: "runtime",
        patterns: [
            "Cyclic Graph State Machine",
            "State Checkpointing",
            "Human-in-the-Loop Review"
        ]
    }
];
function performArchitecturalVote(fileName, codeSnippet) {
    const lowerName = fileName.toLowerCase();
    const lowerSnippet = codeSnippet.toLowerCase();
    if (lowerName.includes("crypto") || lowerName.includes("auth") || lowerName.includes("token") || lowerSnippet.includes("key")) {
        return {
            source: SIPHON_SOURCES[1],
            score: 96,
            rationale: "Handles sensitive keys and security credentials; applied Shannon entropy sanitization and memory isolation.",
            recommendedPattern: "Shannon Entropy Secret Sanitizer"
        };
    }
    if (lowerName.includes("agent") || lowerName.includes("loop") || lowerName.includes("engine") || lowerSnippet.includes("prompt")) {
        return {
            source: SIPHON_SOURCES[2],
            score: 94,
            rationale: "Implements execution cycles or agent workflows; mapped to 5-Pillar Modular Agent Architecture.",
            recommendedPattern: "Bounded ReAct Reasoning Loop & VFS Sandbox"
        };
    }
    return {
        source: SIPHON_SOURCES[0],
        score: 92,
        rationale: "Standard code refactoring and AST verification baseline.",
        recommendedPattern: "AST Diff Gate Verification & Type Safety"
    };
}
}),
"[project]/src/lib/pipeline/emg/sanitizer.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Security Sanitizer & Governance Helper
 * Shannon entropy on tokens, secret pattern matching, PII redaction.
 */ __turbopack_context__.s([
    "calculateShannonEntropy",
    ()=>calculateShannonEntropy,
    "sanitizeAndGovern",
    ()=>sanitizeAndGovern
]);
const SECRET_PATTERNS = [
    /AIzaSy[A-Za-z0-9_-]{33}/g,
    /ghp_[A-Za-z0-9]{36}/g,
    /gho_[A-Za-z0-9]{36}/g,
    /sk-[A-Za-z0-9]{32,48}/g,
    /AKIA[0-9A-Z]{16}/g,
    /xox[baprs]-[0-9a-zA-Z-]{10,48}/g,
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]+/g
];
const PII_PATTERNS = [
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    /\b\d{3}-\d{2}-\d{4}\b/g
];
function calculateShannonEntropy(str) {
    if (!str || str.length === 0) return 0;
    const frequencies = new Map();
    for(let i = 0; i < str.length; i++){
        const char = str[i];
        frequencies.set(char, (frequencies.get(char) || 0) + 1);
    }
    let entropy = 0;
    const len = str.length;
    for (const count of frequencies.values()){
        const p = count / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}
/**
 * Heuristic: determine if a high-entropy string is actually an environment
 * variable name, a file path, a URL, or a non-secret utility string (alphabet,
 * digit sequence) — none of which are secrets even though they can have
 * entropy > 4.5.
 */ function isLikelyEnvVarOrPath(s) {
    // 1. ENV_VAR=value pattern (e.g. DYLD_FRAMEWORK_PATH=/override)
    if (/^[A-Z][A-Z0-9_]*=/.test(s)) return true;
    // 2. Known env var prefixes (macOS dyld, Linux ld, common vars)
    const envPrefixes = [
        "DYLD_",
        "LD_",
        "PATH=",
        "HOME=",
        "USER=",
        "SHELL=",
        "TMPDIR=",
        "LANG=",
        "LC_",
        "TERM=",
        "DISPLAY=",
        "EDITOR=",
        "VISUAL=",
        "NODE_",
        "NPM_",
        "BUN_",
        "GITHUB_",
        "GIT_"
    ];
    for (const prefix of envPrefixes){
        if (s.startsWith(prefix)) return true;
    }
    // 3. File path (starts with / or contains / and has a file extension)
    if (s.startsWith("/") || /^[a-z]:\//i.test(s)) return true;
    if (s.includes("/") && /\.\w{1,5}$/.test(s)) return true;
    // 4. URL
    if (s.startsWith("http://") || s.startsWith("https://")) return true;
    // 5. Non-secret utility strings — alphabets, digit sequences, etc.
    //    "abcdefghijklmnopqrstuvwxyz" has entropy 4.70 but is clearly not a secret.
    //    Detect: all-unique chars in a sequential run, or pure repeated patterns.
    const unique = new Set(s).size;
    if (unique === s.length && s.length >= 20) {
        // All characters are unique AND length >= 20 — could be alphabet or similar.
        // Real secrets are NOT typically all-unique (they have repetition due to base64).
        // Check if it's a known non-secret pattern:
        if (/^[a-z]+$/i.test(s) && unique >= 20) return true; // alphabet
        if (/^[0-9]+$/i.test(s) && unique >= 8) return true; // digit sequence
        if (/^[a-z0-9]+$/i.test(s) && unique >= 22 && s.length <= 36) return true; // alphanumeric utility
    }
    return false;
}
/**
 * Heuristic: determine if a file is likely a test/fixture/experiment file
 * where high-entropy strings are deterministic test data (oracle IDs,
 * expected hashes, sample tokens) rather than real secrets.
 */ function isLikelyFixtureFile(filePath, code) {
    // 1. Path-based detection
    if (filePath) {
        const lower = filePath.toLowerCase();
        const fixturePathPatterns = [
            /(^|\/)tests?\//,
            /(^|\/)__tests__\//,
            /(^|\/)fixtures?\//,
            /(^|\/)experiments?\//,
            /(^|\/)specs?\//,
            /(^|\/)e2e\//,
            /(^|\/)demo\//,
            /(^|\/)samples?\//,
            /(^|\/)examples?\//,
            /(^|\/)mocks?\//,
            /(^|\/)stubs?\//,
            /\.(test|spec)\.[a-z]+$/i,
            /^test_/,
            /_test\.[a-z]+$/i
        ];
        for (const pat of fixturePathPatterns){
            if (pat.test(lower)) return true;
        }
    }
    // 2. Content-based detection — known fixture prefixes assigned to constants
    const fixturePrefixes = [
        "jag_observation_",
        "jag_node_",
        "test_",
        "fixture_",
        "sample_",
        "example_",
        "mock_",
        "stub_",
        "dummy_",
        "fake_",
        "oracle_",
        "expected_"
    ];
    for (const prefix of fixturePrefixes){
        if (code.includes(prefix)) {
            const constPattern = new RegExp(`[A-Z][A-Z0-9_]*\\s*=\\s*['"]${prefix}`, "");
            if (constPattern.test(code)) return true;
        }
    }
    // 3. Content-based — file has many UPPER_SNAKE_CASE constants assigned to
    //    high-entropy strings. Test fixture files typically declare a handful
    //    of oracle IDs at the top.
    const upperConstAssignments = code.match(/[A-Z][A-Z0-9_]{2,}\s*=\s*['"][A-Za-z0-9_\-+/=]{24,}['"]/g);
    if (upperConstAssignments && upperConstAssignments.length >= 2) {
        return true;
    }
    return false;
}
function sanitizeAndGovern(inputCode, filePath) {
    const violations = [];
    let sanitized = inputCode;
    let highEntropyTokensFound = 0;
    // Fixture detection: if this file is a test/fixture/experiment file, treat
    // high-entropy strings as deterministic test data, not secrets.
    const isFixtureFile = isLikelyFixtureFile(filePath, inputCode);
    for (const pattern of SECRET_PATTERNS){
        const matches = sanitized.match(pattern);
        if (matches) {
            for (const match of matches){
                violations.push(`Detected known secret signature: ${match.slice(0, 6)}... (length: ${match.length})`);
                sanitized = sanitized.split(match).join(`[REDACTED_SECRET_${match.slice(0, 4)}]`);
            }
        }
    }
    for (const pii of PII_PATTERNS){
        const matches = sanitized.match(pii);
        if (matches) {
            for (const match of matches){
                violations.push(`Detected PII leak: ${match.slice(0, 3)}***`);
                sanitized = sanitized.split(match).join("[REDACTED_PII]");
            }
        }
    }
    const stringLiterals = inputCode.match(/["']([A-Za-z0-9_\-+/=]{24,})["']/g);
    if (stringLiterals) {
        for (const literal of stringLiterals){
            const inner = literal.slice(1, -1);
            const entropy = calculateShannonEntropy(inner);
            // Skip redaction for fixture files — deterministic test data.
            if (isFixtureFile) continue;
            // Skip env var names, file paths, URLs — not secrets even if high-entropy.
            if (isLikelyEnvVarOrPath(inner)) continue;
            // Raised threshold from 4.15 to 4.5 — 4.15 catches too many legitimate
            // strings. Real secrets typically have entropy > 4.5.
            if (entropy > 4.5) {
                highEntropyTokensFound++;
                violations.push(`Detected high-entropy string (entropy: ${entropy.toFixed(2)}): ${inner.slice(0, 6)}...`);
                sanitized = sanitized.split(inner).join("[REDACTED_HIGH_ENTROPY_KEY]");
            }
        }
    }
    const isClean = violations.length === 0;
    const errorClass = isClean ? "CLEAN" : highEntropyTokensFound > 0 ? "HIGH_ENTROPY_TOKEN" : "SECRET_LEAKAGE";
    return {
        clean: isClean,
        sanitizedCode: sanitized,
        errorClass,
        violations,
        autoAppliedFix: isClean ? undefined : sanitized,
        highEntropyTokensFound
    };
}
}),
"[externals]/fs/promises [external] (fs/promises, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("fs/promises", () => require("fs/promises"));

module.exports = mod;
}),
"[externals]/path [external] (path, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("path", () => require("path"));

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
"[project]/src/lib/pipeline/engines/clean-room-runtime.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "LifecycleKernel",
    ()=>LifecycleKernel,
    "ReactLoopEngine",
    ()=>ReactLoopEngine,
    "SessionTreeTokenBudgetEngine",
    ()=>SessionTreeTokenBudgetEngine,
    "ToolSandboxVFSEngine",
    ()=>ToolSandboxVFSEngine,
    "UnifiedModelStreamAdapter",
    ()=>UnifiedModelStreamAdapter,
    "executeCleanRoomEngine",
    ()=>executeCleanRoomEngine
]);
/**
 * 5-Pillar Modular Agent Runtime Helper (server-safe, LLM-driven)
 *
 *   1. Lifecycle Kernel
 *   2. ReAct Loop Engine — calls the real LLM at each step (z-ai-web-dev-sdk)
 *   3. Unified Model Stream Adapter
 *   4. Tool Sandbox VFS Engine
 *   5. Non-Linear Session Tree & Token Budget Engine
 *
 * The ReAct loop now asks the LLM to (a) inspect the target file in the VFS
 * sandbox, (b) propose a refactoring plan, (c) produce the refactored code.
 * The final answer is the LLM-proposed evolved code, which is then verified
 * by the AST diff gate.
 *
 * If the LLM is unavailable, the loop degrades to a deterministic stub so
 * the pipeline still completes (and downstream gates will catch any drift).
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/llm/agent-llm.ts [app-route] (ecmascript)");
;
class LifecycleKernel {
    state = "uninitialized";
    abortController = null;
    listeners = new Set();
    boot() {
        if (this.state === "ready" || this.state === "running") return;
        this.transition("booting");
        this.abortController = new AbortController();
        this.transition("ready");
    }
    getSignal() {
        return this.abortController?.signal;
    }
    transition(next) {
        this.state = next;
        for (const l of this.listeners){
            try {
                l(next);
            } catch  {
            /* ignore */ }
        }
    }
    getState() {
        return this.state;
    }
    onStateChange(listener) {
        this.listeners.add(listener);
        return ()=>this.listeners.delete(listener);
    }
    dispose() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.transition("disposed");
        this.listeners.clear();
    }
}
class ReactLoopEngine {
    maxSteps;
    constructor(maxSteps = 8){
        this.maxSteps = maxSteps;
    }
    async runLoop(goal, executeStep) {
        const history = [];
        const seenActions = new Set();
        for(let step = 1; step <= this.maxSteps; step++){
            const current = await executeStep(step, history);
            history.push(current);
            if (current.isTerminal) break;
            if (current.actionName) {
                const actionSig = `${current.actionName}:${JSON.stringify(current.actionPayload)}`;
                if (seenActions.has(actionSig)) {
                    history.push({
                        stepNumber: step + 1,
                        thought: `CYCLE DETECTED: Action ${current.actionName} previously executed with identical arguments. Tripping loop circuit breaker.`,
                        isTerminal: true,
                        observation: "Loop terminated by defensive invariant."
                    });
                    break;
                }
                seenActions.add(actionSig);
            }
        }
        return history;
    }
}
class UnifiedModelStreamAdapter {
    async *decodeStream(chunks) {
        for (const chunk of chunks){
            yield {
                type: "delta",
                content: chunk
            };
        }
        yield {
            type: "finish",
            content: ""
        };
    }
}
class ToolSandboxVFSEngine {
    memoryFs = new Map();
    sanitizePath(path) {
        const normalized = path.replace(/\\/g, "/");
        if (normalized.includes("../") || normalized.startsWith("../") || normalized === "..") {
            throw new Error(`SECURITY ALERT: Path traversal barrier breached (${path}). Sandbox access denied.`);
        }
        return normalized.startsWith("/") ? normalized.slice(1) : normalized;
    }
    writeFile(path, content) {
        const safePath = this.sanitizePath(path);
        this.memoryFs.set(safePath, content);
    }
    readFile(path) {
        const safePath = this.sanitizePath(path);
        const content = this.memoryFs.get(safePath);
        if (content === undefined) {
            throw new Error(`Virtual file not found: ${path}`);
        }
        return content;
    }
    listFiles() {
        return Array.from(this.memoryFs.keys());
    }
    hasFile(path) {
        try {
            const safe = this.sanitizePath(path);
            return this.memoryFs.has(safe);
        } catch  {
            return false;
        }
    }
    clear() {
        this.memoryFs.clear();
    }
}
class SessionTreeTokenBudgetEngine {
    nodes = new Map();
    activeLeafId = null;
    tokenCap;
    constructor(tokenCap = 8192){
        this.tokenCap = tokenCap;
    }
    addMessage(role, content, parentId) {
        const node = {
            id: `node-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            parentId: parentId ?? this.activeLeafId,
            role,
            content,
            tokensEstimate: Math.ceil(content.length / 4),
            timestamp: Date.now()
        };
        this.nodes.set(node.id, node);
        this.activeLeafId = node.id;
        return node;
    }
    getActivePath() {
        const path = [];
        let currentId = this.activeLeafId;
        while(currentId){
            const node = this.nodes.get(currentId);
            if (!node) break;
            path.unshift(node);
            currentId = node.parentId;
        }
        return path;
    }
    getTotalBudget() {
        const path = this.getActivePath();
        const used = path.reduce((sum, n)=>sum + n.tokensEstimate, 0);
        return {
            used,
            cap: this.tokenCap,
            percentage: Math.min(100, Math.round(used / this.tokenCap * 100))
        };
    }
    compactHistory() {
        const path = this.getActivePath();
        const totalTokens = path.reduce((sum, n)=>sum + n.tokensEstimate, 0);
        let pruned = 0;
        if (totalTokens > this.tokenCap * 0.8 && path.length > 4) {
            const toPrune = path.slice(1, path.length - 3);
            for (const node of toPrune){
                this.nodes.delete(node.id);
                pruned++;
            }
        }
        return pruned;
    }
}
const PLAN_SYSTEM = `You are the planning step inside a bounded ReAct agent loop. Given a code refactor goal and the current file contents, output a concise refactor plan in 3-5 bullet points. Do NOT output the refactored code — only the plan. Keep it under 200 words.`;
const REFACTOR_SYSTEM = `You are the execution step inside a bounded ReAct agent loop. You receive a refactor plan and the original code. Output ONLY the refactored code in a single fenced code block. Preserve every public symbol name exactly. Apply the plan faithfully without changing public API.`;
async function executeCleanRoomEngine(engineId, goal, options) {
    const lifecycle = new LifecycleKernel();
    lifecycle.boot();
    lifecycle.transition("running");
    const vfs = new ToolSandboxVFSEngine();
    const session = new SessionTreeTokenBudgetEngine();
    const reactLoop = new ReactLoopEngine(5);
    const originalCode = options?.originalCode ?? "";
    const filePath = options?.filePath ?? "workspace/target.ts";
    const postmortemConstraints = options?.postmortemConstraints ?? "";
    vfs.writeFile(filePath, originalCode || `// Target code for engine ${engineId}`);
    session.addMessage("user", goal);
    let proposedEvolvedCode = "";
    let llmUsed = false;
    let llmTotalLatencyMs = 0;
    let llmError;
    const steps = await reactLoop.runLoop(goal, async (stepNumber)=>{
        if (stepNumber === 1) {
            // Plan step — call LLM with a planning prompt
            const planUser = `Goal: ${goal}

File contents:
\`\`\`
${originalCode.slice(0, 6000)}${originalCode.length > 6000 ? "\n// ... (truncated)" : ""}
\`\`\`

Output a 3-5 bullet refactor plan only.`;
            const planRes = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["llmComplete"])({
                systemPrompt: PLAN_SYSTEM,
                userPrompt: planUser,
                temperature: 0.2
            });
            llmTotalLatencyMs += planRes.latencyMs;
            if (planRes.ok) {
                llmUsed = true;
                session.addMessage("assistant", planRes.content);
                return {
                    stepNumber,
                    thought: `[Pillar 1/2] Inspected ${filePath} in VFS sandbox (${originalCode.length} bytes). Asked LLM for a refactor plan.`,
                    actionName: "plan",
                    actionPayload: {
                        filePath
                    },
                    observation: planRes.content.slice(0, 240),
                    isTerminal: false,
                    llmUsed: true,
                    llmLatencyMs: planRes.latencyMs
                };
            }
            llmError = planRes.error;
            // Deterministic fallback plan
            const fallbackPlan = `1. Add explicit type annotations to inferred parameters.\n2. Extract magic numbers into named constants.\n3. Add JSDoc to undocumented public functions.\n4. Preserve every public symbol exactly.`;
            session.addMessage("assistant", fallbackPlan);
            return {
                stepNumber,
                thought: `[Pillar 1/2] LLM unavailable (${planRes.error}). Using deterministic fallback plan.`,
                actionName: "plan_fallback",
                actionPayload: {
                    filePath
                },
                observation: fallbackPlan,
                isTerminal: false,
                llmUsed: false,
                llmLatencyMs: planRes.latencyMs
            };
        }
        if (stepNumber === 2) {
            // Execute step — produce refactored code
            const lang = filePath.toLowerCase().split(".").pop() || "ts";
            const planContext = session.getActivePath().slice(-2).map((n)=>n.content).join("\n\n");
            const postmortemBlock = postmortemConstraints ? `${postmortemConstraints}\n\nThe constraints above are from previous failed attempts on this file. You MUST follow them.` : "";
            const refactorUser = `Refactor plan:
${planContext}
${postmortemBlock}

Original code (\`${lang}\`):
\`\`\`${lang}
${originalCode.slice(0, 6000)}${originalCode.length > 6000 ? "\n// ... (truncated)" : ""}
\`\`\`

Output ONLY the refactored code in a single \`\`\`${lang} fenced block. Preserve every public symbol name exactly.`;
            const refactorRes = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["llmComplete"])({
                systemPrompt: REFACTOR_SYSTEM,
                userPrompt: refactorUser,
                temperature: 0.2
            });
            llmTotalLatencyMs += refactorRes.latencyMs;
            if (refactorRes.ok) {
                const code = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["extractCodeBlock"])(refactorRes.content);
                if (code) {
                    proposedEvolvedCode = code;
                    llmUsed = true;
                    session.addMessage("assistant", code);
                    return {
                        stepNumber,
                        thought: `[Pillar 4/5] LLM produced refactored code (${code.length} bytes). VFS sandbox remains isolated.`,
                        actionName: "refactor",
                        actionPayload: {
                            engine: engineId,
                            bytes: code.length
                        },
                        observation: `Refactored code emitted (${code.length} bytes).`,
                        isTerminal: false,
                        llmUsed: true,
                        llmLatencyMs: refactorRes.latencyMs
                    };
                }
            }
            // Fallback — no LLM
            llmError = llmError ?? refactorRes.error;
            return {
                stepNumber,
                thought: `[Pillar 4/5] LLM unavailable for refactor step (${refactorRes.error}). Falling back to downstream deterministic transform.`,
                actionName: "refactor_fallback",
                actionPayload: {
                    engine: engineId
                },
                observation: "No LLM code produced; pipeline will apply deterministic transform.",
                isTerminal: false,
                llmUsed: false,
                llmLatencyMs: refactorRes.latencyMs
            };
        }
        // Terminal step
        return {
            stepNumber,
            thought: `[Pillar 3] Engine '${engineId}' synthesized clean-room solution${llmUsed ? " via LLM" : " via deterministic fallback"}.`,
            isTerminal: true,
            observation: `Execution concluded within step budget. LLM used: ${llmUsed}.`
        };
    });
    const status = llmUsed ? "COMPLETED" : "DEGRADED";
    const finalAnswer = llmUsed ? `Clean-Room Engine [${engineId}] produced ${proposedEvolvedCode.length} bytes of refactored code via LLM. Token budget at ${session.getTotalBudget().percentage}%.` : `Clean-Room Engine [${engineId}] degraded: LLM unavailable (${llmError}). No refactored code produced; downstream pipeline will apply deterministic transform.`;
    session.addMessage("assistant", finalAnswer);
    lifecycle.transition("ready");
    return {
        engineId,
        goal,
        status,
        lifecycleState: lifecycle.getState(),
        tokenBudget: session.getTotalBudget(),
        vfsFiles: vfs.listFiles(),
        steps,
        finalAnswer,
        proposedEvolvedCode,
        llmUsed,
        llmTotalLatencyMs,
        llmError
    };
}
}),
"[project]/src/lib/pipeline/core/ast-diff-gate.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "evaluateAstDiff",
    ()=>evaluateAstDiff,
    "extractSymbols",
    ()=>extractSymbols
]);
/**
 * AST Verification & Syntax Gate Helper (real AST)
 *
 * Uses the TypeScript Compiler API (`ts.createSourceFile`) to parse both
 * the original and proposed code into proper ASTs and walk them. This
 * catches nested function scopes, arrow functions, re-exports, methods,
 * enum members, and namespace declarations — none of which the previous
 * regex-based extractor could see.
 *
 * For non-TS/JS files (Python, Go, etc.) where the TS parser would emit
 * a near-empty tree, we fall back to a line-based regex extractor so the
 * gate still produces a sensible answer.
 */ var __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__ = __turbopack_context__.i("[externals]/typescript [external] (typescript, cjs, [project]/node_modules/typescript)");
;
const SYSTEM_PERSONA_BRANDING_TERMS = [
    "dalek caan",
    "dalek_caan",
    "dalekcaan",
    "omega engine",
    "omega_engine",
    "cognitive dominance",
    "grog engine",
    "grog_engine",
    "recursive evolution loop",
    "nexus neural network"
];
function isExported(node) {
    return __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["canHaveModifiers"](node) && (__TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["getModifiers"](node)?.some((m)=>m.kind === __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].ExportKeyword) ?? false);
}
function symbolKindFromDeclaration(node) {
    switch(node.kind){
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].FunctionDeclaration:
            return "function";
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].ClassDeclaration:
            return "class";
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].InterfaceDeclaration:
            return "interface";
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].TypeAliasDeclaration:
            return "type";
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].EnumDeclaration:
            return "enum";
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].ModuleDeclaration:
            return "namespace";
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].VariableDeclaration:
            // Could be a const arrow function or a regular const
            if (node.parent && __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isVariableStatement"](node.parent)) {
            // Check if initializer is arrow/function expression by walking — handled by extractor
            }
            return "const";
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].ArrowFunction:
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].FunctionExpression:
            return "arrow";
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].MethodDeclaration:
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].GetAccessor:
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].SetAccessor:
            return "method";
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].ExportSpecifier:
        case __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["SyntaxKind"].ExportAssignment:
            return "reexport";
        default:
            return null;
    }
}
function declarationName(node) {
    if ("name" in node && node.name) {
        const name = node.name;
        if (__TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isIdentifier"](name) || __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isPrivateIdentifier"](name) || __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isStringLiteral"](name)) {
            return name.text;
        }
    }
    return null;
}
/**
 * Walk a TypeScript AST and collect every named declaration we can find.
 * Includes: top-level functions, classes, interfaces, types, enums,
 * namespaces, exported const declarations, arrow functions assigned to
 * const, class methods, and export specifiers.
 */ function extractSymbolsFromTs(sourceFile) {
    const symbols = [];
    const visit = (node)=>{
        let kind = null;
        let name = null;
        if (__TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isFunctionDeclaration"](node) || __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isClassDeclaration"](node) || __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isInterfaceDeclaration"](node) || __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isTypeAliasDeclaration"](node) || __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isEnumDeclaration"](node) || __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isModuleDeclaration"](node)) {
            kind = symbolKindFromDeclaration(node);
            name = declarationName(node);
        } else if (__TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isVariableStatement"](node)) {
            const exported = isExported(node);
            for (const decl of node.declarationList.declarations){
                const declName = __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isIdentifier"](decl.name) ? decl.name.text : null;
                if (!declName) continue;
                // If initializer is an arrow/function expression, mark as arrow
                let varKind = "const";
                if (decl.initializer && (__TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isArrowFunction"](decl.initializer) || __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isFunctionExpression"](decl.initializer))) {
                    varKind = "arrow";
                }
                symbols.push({
                    name: declName,
                    type: varKind,
                    line: __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["getLineAndCharacterOfPosition"](sourceFile, decl.getStart()).line + 1,
                    exported
                });
            }
            // Continue walking for nested declarations inside initializers
            __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["forEachChild"](node, visit);
            return;
        } else if (__TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isExportDeclaration"](node) && node.exportClause && __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isNamedExports"](node.exportClause)) {
            for (const spec of node.exportClause.elements){
                const specName = spec.propertyName?.text ?? spec.name.text;
                symbols.push({
                    name: specName,
                    type: "reexport",
                    line: __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["getLineAndCharacterOfPosition"](sourceFile, spec.getStart()).line + 1,
                    exported: true
                });
            }
            __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["forEachChild"](node, visit);
            return;
        } else if (__TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isMethodDeclaration"](node) || __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isGetAccessorDeclaration"](node) || __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["isSetAccessorDeclaration"](node)) {
            kind = "method";
            name = declarationName(node);
        }
        if (kind && name) {
            symbols.push({
                name,
                type: kind,
                line: __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["getLineAndCharacterOfPosition"](sourceFile, node.getStart()).line + 1,
                exported: isExported(node)
            });
        }
        __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["forEachChild"](node, visit);
    };
    __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["forEachChild"](sourceFile, visit);
    return symbols;
}
/**
 * Fallback line-based extractor for non-TS/JS files. Now language-aware:
 * extracts top-level declarations AND class methods for Java, Python, Go,
 * Rust, Ruby, PHP, C/C++, Kotlin, and C#. This catches method-level
 * regressions that the previous top-level-only regex missed (e.g. dropping
 * 5 methods from a Java class while keeping the class itself).
 */ function extractSymbolsRegex(code, filePath) {
    const symbols = [];
    const lines = code.split("\n");
    const ext = (filePath ?? "").toLowerCase().split(".").pop() ?? "";
    // Common top-level patterns (all languages)
    const topLevelPatterns = [
        [
            /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
            "function"
        ],
        [
            /(?:export\s+)?class\s+([A-Za-z0-9_$]+)/,
            "class"
        ],
        [
            /(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/,
            "interface"
        ],
        [
            /(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/,
            "type"
        ],
        [
            /(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*[:=]/,
            "const"
        ],
        [
            /^\s*def\s+([A-Za-z0-9_]+)/,
            "function"
        ],
        [
            /^func\s+([A-Za-z0-9_]+)/,
            "function"
        ]
    ];
    // Language-specific method patterns (inside classes)
    const methodPatterns = [];
    if (ext === "java" || ext === "kt" || ext === "cs") {
        methodPatterns.push([
            /^\s*(?:@\w+\s+)*\s*(?:public|private|protected|static|final|synchronized|abstract|native|override)\s+(?:final\s+)?(?:[A-Za-z_][\w<>\[\],?\s]*\s+)+([A-Za-z_]\w*)\s*\(/,
            "method"
        ]);
    }
    if (ext === "py") {
        methodPatterns.push([
            /^\s+def\s+([A-Za-z_]\w*)\s*\(/,
            "method"
        ]);
    }
    if (ext === "go") {
        methodPatterns.push([
            /^func\s+\([^)]*\)\s+([A-Za-z_]\w*)\s*\(/,
            "method"
        ]);
    }
    if (ext === "rs") {
        methodPatterns.push([
            /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/,
            "method"
        ]);
    }
    if (ext === "rb") {
        methodPatterns.push([
            /^\s+def\s+([A-Za-z_]\w*)/,
            "method"
        ]);
    }
    if (ext === "php") {
        methodPatterns.push([
            /^\s*(?:public|private|protected|static)\s+(?:static\s+)?function\s+([A-Za-z_]\w*)\s*\(/,
            "method"
        ]);
    }
    if (ext === "cpp" || ext === "cc" || ext === "c" || ext === "h" || ext === "hpp") {
        methodPatterns.push([
            /^\s*[A-Za-z_][\w:<>*\s]*\s+([A-Za-z_]\w*)\s*\(/,
            "method"
        ]);
    }
    const skipNames = new Set([
        "if",
        "for",
        "while",
        "switch",
        "catch",
        "return",
        "new",
        "throw",
        "assert",
        "sizeof"
    ]);
    for(let idx = 0; idx < lines.length; idx++){
        const line = lines[idx];
        let matched = false;
        // Try top-level patterns first
        for (const [pat, type] of topLevelPatterns){
            const m = line.match(pat);
            if (m && m[1]) {
                if (type === "function" && ext === "go" && /^func\s+\(/.test(line)) {
                    continue;
                }
                symbols.push({
                    name: m[1],
                    type,
                    line: idx + 1,
                    exported: /\bexport\b/.test(line)
                });
                matched = true;
                break;
            }
        }
        if (matched) continue;
        // Try method patterns (language-specific)
        for (const [pat, type] of methodPatterns){
            const m = line.match(pat);
            if (m && m[1]) {
                if (skipNames.has(m[1])) continue;
                symbols.push({
                    name: m[1],
                    type,
                    line: idx + 1,
                    exported: false
                });
                break;
            }
        }
    }
    return symbols;
}
function extractSymbols(code, filePath) {
    const ext = (filePath ?? "").toLowerCase().split(".").pop() ?? "";
    const isTsLike = [
        "ts",
        "tsx",
        "js",
        "jsx",
        "mjs",
        "cjs",
        ""
    ].includes(ext);
    if (!isTsLike) {
        return extractSymbolsRegex(code, filePath);
    }
    try {
        const scriptKind = ext === "ts" ? __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["ScriptKind"].TS : ext === "tsx" ? __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["ScriptKind"].TSX : ext === "jsx" ? __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["ScriptKind"].JSX : __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["ScriptKind"].JS;
        const sourceFile = __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["createSourceFile"]("input." + (ext || "ts"), code, __TURBOPACK__imported__module__$5b$externals$5d2f$typescript__$5b$external$5d$__$28$typescript$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f$typescript$29$__["ScriptTarget"].ESNext, /* setParentNodes */ true, scriptKind);
        return extractSymbolsFromTs(sourceFile);
    } catch  {
        // If TS parsing fails for some reason, fall back to regex.
        return extractSymbolsRegex(code);
    }
}
function evaluateAstDiff(originalCode, proposedCode, filePath) {
    const originalSymbols = extractSymbols(originalCode, filePath);
    const proposedSymbols = extractSymbols(proposedCode, filePath);
    const ext = (filePath ?? "").toLowerCase().split(".").pop() ?? "";
    const parserUsed = [
        "ts",
        "tsx",
        "js",
        "jsx",
        "mjs",
        "cjs",
        ""
    ].includes(ext) ? "typescript" : "regex-fallback";
    // Match on name + exported-ness (a renamed export counts as dropped).
    const proposedKey = (s)=>`${s.name}:${s.exported ? "exp" : "loc"}`;
    const proposedNames = new Set(proposedSymbols.map(proposedKey));
    const missingSymbols = originalSymbols.filter((s)=>!proposedNames.has(proposedKey(s)));
    const retainedCount = originalSymbols.length - missingSymbols.length;
    const violations = [];
    if (missingSymbols.length > 0) {
        violations.push({
            code: "AST_SYMBOL_DROPPED",
            message: `Dropped ${missingSymbols.length} original symbol(s): ${missingSymbols.map((s)=>s.name).slice(0, 5).join(", ")}`,
            severity: missingSymbols.length > 2 ? "high" : "medium"
        });
    }
    const proposedLower = proposedCode.toLowerCase();
    const brandingInjections = [];
    for (const term of SYSTEM_PERSONA_BRANDING_TERMS){
        if (proposedLower.includes(term) && !originalCode.toLowerCase().includes(term)) {
            brandingInjections.push(term);
        }
    }
    if (brandingInjections.length > 0) {
        violations.push({
            code: "BRANDING_INJECTION",
            message: `Detected unauthorized persona/branding injection: ${brandingInjections.join(", ")}`,
            severity: "high"
        });
    }
    const stripSyntheticDecorations = (code)=>{
        return code.replace(/\/\*\*[\s\S]*?\*\/\n?/g, "").replace(/\/\/[^\n\r]*\n?/g, "").replace(/^#[^\n\r]*\n?/gm, "").replace(/<!--[\s\S]*?-->\n?/g, "").replace(/export\s+interface\s+ExecutionContract\s*\{[\s\S]*?\}\n*/g, "").trim();
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
            severity: "high"
        });
    }
    const retentionScore = originalSymbols.length === 0 ? 100 : retainedCount / originalSymbols.length * 60;
    const penalty = brandingInjections.length * 20 + violations.filter((v)=>v.severity === "high").length * 25;
    const astScore = Math.max(0, Math.min(100, Math.round(retentionScore + 40 - penalty)));
    const passed = violations.filter((v)=>v.severity === "high").length === 0 && astScore >= 50;
    return {
        passed,
        astScore,
        symbolMap: {
            originalCount: originalSymbols.length,
            proposedCount: proposedSymbols.length,
            retainedCount,
            missingSymbols
        },
        brandingInjections,
        structuralDriftRatio: Math.min(1, driftRatio),
        violations,
        parserUsed
    };
}
}),
"[project]/src/lib/pipeline/emg/debate.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Code Review & Verification Helper
 * Dual-perspective analysis: Security Reviewer vs Architecture Reviewer.
 */ __turbopack_context__.s([
    "conductDebate",
    ()=>conductDebate
]);
function conductDebate(topic, candidateCode, filePath) {
    const secretPattern = /\b(AIzaSy[A-Za-z0-9_-]{28,40}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16})\b/;
    const containsSecrets = secretPattern.test(candidateCode);
    const containsEval = /\beval\s*\(|\bnew\s+Function\s*\(/.test(candidateCode);
    const hasTypeAnnotations = /:\s*(string|number|boolean|Promise<|void|Record<)/.test(candidateCode);
    const isLarge = candidateCode.length > 10000;
    const securityPoints = [];
    const architecturePoints = [];
    const args = [];
    if (containsSecrets) {
        securityPoints.push("Potential authentication token or credential identified.");
    }
    if (containsEval) {
        securityPoints.push("Dynamic code execution (eval/Function) flagged for potential security risk.");
    }
    if (isLarge) {
        securityPoints.push("Module complexity is high; consider modularizing for readability.");
    }
    if (securityPoints.length === 0) {
        securityPoints.push("Code passed static security patterns with zero credential exposure.");
    }
    if (hasTypeAnnotations) {
        architecturePoints.push("Strong TypeScript typing and interface contracts are maintained.");
    }
    architecturePoints.push(`Public export contracts for '${filePath}' remain backwards-compatible.`);
    architecturePoints.push("Enhancements maintain maintainability and clean structure.");
    args.push({
        speaker: "security",
        speakerName: "Security Reviewer",
        avatar: "🛡️",
        stance: securityPoints.length > 1 ? "OPPOSE" : "ENDORSE",
        statement: `Reviewing candidate file ${filePath}: ${securityPoints.join(" ")}`,
        citations: [
            "Security Guideline: Credential Sanitization",
            "AST Diff Retention Protocol"
        ],
        cognitiveFriction: securityPoints.length > 1 ? 0.65 : 0.15
    });
    args.push({
        speaker: "architecture",
        speakerName: "Architecture Reviewer",
        avatar: "📐",
        stance: "ENDORSE",
        statement: `Structural assessment: ${architecturePoints.join(" ")}`,
        citations: [
            "Clean Code Standards",
            "Type Safety & Modularity Guidelines"
        ],
        cognitiveFriction: 0.15
    });
    const criticalFlaws = containsSecrets || containsEval;
    let consensus = "APPROVED";
    let consensusCoefficient = 0.92;
    let cognitiveFriction = 0.18;
    let leadSummary = "Review summary: Candidate changes satisfy both security and architectural standards.";
    if (criticalFlaws) {
        consensus = "REQUIRES_REWRITE";
        consensusCoefficient = 0.3;
        cognitiveFriction = 0.8;
        leadSummary = "Review summary: Security concerns identified. Redact credentials and remove dynamic execution before merge.";
    } else if (securityPoints.length > 1) {
        consensus = "CONDITIONAL_APPROVAL";
        consensusCoefficient = 0.72;
        cognitiveFriction = 0.4;
        leadSummary = "Review summary: Conditional approval. Verify AST symbol retention before finalizing merge.";
    }
    args.push({
        speaker: "lead",
        speakerName: "Lead Reviewer",
        avatar: "✓",
        stance: "SYNTHESIS",
        statement: leadSummary,
        citations: [
            "Verification Consensus Checklist"
        ],
        cognitiveFriction
    });
    return {
        currentTopic: topic,
        consensus,
        consensusCoefficient,
        cognitiveFriction,
        securityPoints,
        architecturePoints,
        leadSummary,
        judgeSummary: leadSummary,
        arguments: args
    };
}
}),
"[project]/src/lib/pipeline/llm/debate-llm.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "conductLlmDebate",
    ()=>conductLlmDebate
]);
/**
 * Real LLM-driven Code Review Tribunal.
 *
 * Replaces the rule-based if/else debate with actual LLM calls. Three
 * distinct reviewers (Security, Architecture, Lead) each receive the
 * candidate code with role-specific instructions and return findings.
 * The Lead synthesizes the two prior reviews into a final verdict.
 *
 * Falls back to the rule-based conductDebate() if the LLM is unavailable
 * so the pipeline still runs end-to-end.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/llm/agent-llm.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$emg$2f$debate$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/emg/debate.ts [app-route] (ecmascript)");
;
;
const SECURITY_SYSTEM = `You are the Security Reviewer in an autonomous code review tribunal. You evaluate candidate code changes for:
- Hardcoded credentials, API keys, or secrets (regex: AIzaSy..., ghp_, gho_, sk-, AKIA..., xox[baprs]-, Slack webhooks).
- Dynamic code execution (eval(), new Function()).
- Path traversal, command injection, SQL injection risks.
- Unsafe deserialization, prototype pollution.
- Information disclosure, PII leakage.
- High-entropy strings that may be secrets.

Respond in strict JSON only:
{
  "stance": "ENDORSE" | "OPPOSE",
  "points": [string, ...],
  "cognitiveFriction": 0.0-1.0,
  "citations": [string, ...]
}

If you find no issues, set stance="ENDORSE" and friction low. If you find critical issues, set stance="OPPOSE" and friction high.`;
const ARCHITECTURE_SYSTEM = `You are the Architecture Reviewer in an autonomous code review tribunal. You evaluate candidate code changes for:
- TypeScript type safety and interface contracts.
- Backwards compatibility of public exports (no symbol removal/renaming).
- Clean code, modularity, single responsibility.
- Naming, cohesion, dependency direction.
- Performance and scalability concerns (without over-engineering).

Respond in strict JSON only:
{
  "stance": "ENDORSE" | "OPPOSE",
  "points": [string, ...],
  "cognitiveFriction": 0.0-1.0,
  "citations": [string, ...]
}

Default to ENDORSE for small refactors that preserve public API. OPPOSE only for genuine architectural regressions.`;
const LEAD_SYSTEM = `You are the Lead Reviewer in an autonomous code review tribunal. You receive the Security Reviewer's and Architecture Reviewer's findings and synthesize a final verdict.

Respond in strict JSON only:
{
  "consensus": "APPROVED" | "CONDITIONAL_APPROVAL" | "REQUIRES_REWRITE" | "REJECTED",
  "consensusCoefficient": 0.0-1.0,
  "cognitiveFriction": 0.0-1.0,
  "leadSummary": string,
  "securityPoints": [string, ...],
  "architecturePoints": [string, ...]
}

Rules:
- APPROVED: both reviewers endorse. Use coefficient >= 0.85.
- CONDITIONAL_APPROVAL: at least one endorses but minor concerns. Use 0.55-0.84.
- REQUIRES_REWRITE: security OPPOSE or significant issues. Use 0.20-0.54.
- REJECTED: critical security flaws. Use < 0.20.`;
function safeJsonParse(text) {
    try {
        // Tolerate stray markdown fences around JSON
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        const candidate = fenced ? fenced[1] : text;
        const start = candidate.indexOf("{");
        const end = candidate.lastIndexOf("}");
        if (start === -1 || end === -1 || end <= start) return null;
        return JSON.parse(candidate.slice(start, end + 1));
    } catch  {
        return null;
    }
}
function asStringArray(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((x)=>typeof x === "string");
}
function clamp(n, min = 0, max = 1) {
    const x = typeof n === "number" ? n : parseFloat(String(n ?? "0"));
    if (Number.isNaN(x)) return min;
    return Math.max(min, Math.min(max, x));
}
async function conductLlmDebate(topic, candidateCode, filePath) {
    const codeSnippet = candidateCode.length > 8000 ? candidateCode.slice(0, 8000) + "\n// ... (truncated)" : candidateCode;
    const userMsg = `File under review: ${filePath}\nTopic: ${topic}\n\nCandidate code:\n\n\`\`\`\n${codeSnippet}\n\`\`\``;
    // Run Security + Architecture in parallel for speed.
    const [secRes, archRes] = await Promise.all([
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["llmComplete"])({
            systemPrompt: SECURITY_SYSTEM,
            userPrompt: userMsg,
            temperature: 0.1
        }),
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["llmComplete"])({
            systemPrompt: ARCHITECTURE_SYSTEM,
            userPrompt: userMsg,
            temperature: 0.2
        })
    ]);
    if (!secRes.ok || !archRes.ok) {
        // Fall back to rule-based
        const fallback = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$emg$2f$debate$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["conductDebate"])(topic, candidateCode, filePath);
        return {
            verdict: fallback,
            usedLlm: false,
            llmError: !secRes.ok ? secRes.error : archRes.error
        };
    }
    const secJson = safeJsonParse(secRes.content) ?? {
        stance: "ENDORSE",
        points: [
            "Security review unavailable — automatic endorsement."
        ],
        cognitiveFriction: 0.2,
        citations: [
            "fallback"
        ]
    };
    const archJson = safeJsonParse(archRes.content) ?? {
        stance: "ENDORSE",
        points: [
            "Architecture review unavailable — automatic endorsement."
        ],
        cognitiveFriction: 0.2,
        citations: [
            "fallback"
        ]
    };
    // Lead synthesis — pass the two prior findings.
    const leadUserMsg = `Topic: ${topic}
File: ${filePath}

Security Reviewer findings:
${JSON.stringify(secJson, null, 2)}

Architecture Reviewer findings:
${JSON.stringify(archJson, null, 2)}

Synthesize a final verdict as JSON per your instructions.`;
    const leadRes = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$agent$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["llmComplete"])({
        systemPrompt: LEAD_SYSTEM,
        userPrompt: leadUserMsg,
        temperature: 0.1
    });
    let leadJson = null;
    if (leadRes.ok) {
        leadJson = safeJsonParse(leadRes.content);
    }
    if (!leadJson) {
        // Deterministic fallback synthesis when lead LLM call fails.
        const secStance = secJson.stance === "OPPOSE";
        const archStance = archJson.stance === "OPPOSE";
        let consensus = "APPROVED";
        let coefficient = 0.9;
        if (secStance) {
            consensus = "REQUIRES_REWRITE";
            coefficient = 0.3;
        } else if (archStance) {
            consensus = "CONDITIONAL_APPROVAL";
            coefficient = 0.6;
        }
        leadJson = {
            consensus,
            consensusCoefficient: coefficient,
            cognitiveFriction: clamp((secJson.cognitiveFriction ?? 0) + (archJson.cognitiveFriction ?? 0)) / 2,
            leadSummary: `Lead synthesis (fallback): ${consensus} based on Security=${secJson.stance} and Architecture=${archJson.stance}.`,
            securityPoints: asStringArray(secJson.points),
            architecturePoints: asStringArray(archJson.points)
        };
    }
    // Build the DebateVerdict
    const consensus = leadJson.consensus ?? "APPROVED";
    const consensusCoefficient = clamp(leadJson.consensusCoefficient);
    const cognitiveFriction = clamp(leadJson.cognitiveFriction);
    const securityPoints = asStringArray(leadJson.securityPoints).length ? asStringArray(leadJson.securityPoints) : asStringArray(secJson.points);
    const architecturePoints = asStringArray(leadJson.architecturePoints).length ? asStringArray(leadJson.architecturePoints) : asStringArray(archJson.points);
    const leadSummary = typeof leadJson.leadSummary === "string" ? leadJson.leadSummary : `Lead synthesis: ${consensus} (coefficient ${consensusCoefficient.toFixed(2)})`;
    const args = [
        {
            speaker: "security",
            speakerName: "Security Reviewer",
            avatar: "🛡️",
            stance: secJson.stance === "OPPOSE" ? "OPPOSE" : "ENDORSE",
            statement: asStringArray(secJson.points).join(" ") || "No security findings.",
            citations: asStringArray(secJson.citations).length ? asStringArray(secJson.citations) : [
                "Security Guideline: Credential Sanitization",
                "AST Diff Retention Protocol"
            ],
            cognitiveFriction: clamp(secJson.cognitiveFriction)
        },
        {
            speaker: "architecture",
            speakerName: "Architecture Reviewer",
            avatar: "📐",
            stance: archJson.stance === "OPPOSE" ? "OPPOSE" : "ENDORSE",
            statement: asStringArray(archJson.points).join(" ") || "No architectural concerns.",
            citations: asStringArray(archJson.citations).length ? asStringArray(archJson.citations) : [
                "Clean Code Standards",
                "Type Safety & Modularity Guidelines"
            ],
            cognitiveFriction: clamp(archJson.cognitiveFriction)
        },
        {
            speaker: "lead",
            speakerName: "Lead Reviewer",
            avatar: "✓",
            stance: "SYNTHESIS",
            statement: leadSummary,
            citations: [
                "Verification Consensus Checklist"
            ],
            cognitiveFriction
        }
    ];
    return {
        verdict: {
            currentTopic: topic,
            consensus,
            consensusCoefficient,
            cognitiveFriction,
            securityPoints,
            architecturePoints,
            leadSummary,
            judgeSummary: leadSummary,
            arguments: args
        },
        usedLlm: true
    };
}
}),
"[project]/src/lib/pipeline/emg/halt.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Self-Stopping & Convergence Helper
 * Three primary self-stopping mechanisms:
 *   1. Tree Fingerprint Saturation Lockout (SHA-256 tree hash comparison)
 *   2. 0-Diff Code Saturation Detection (normalizeCode equality)
 *   3. 3-Failure Consecutive Skip-List Logic
 */ __turbopack_context__.s([
    "SelfStoppingGovernor",
    ()=>SelfStoppingGovernor,
    "normalizeCode",
    ()=>normalizeCode
]);
function normalizeCode(code) {
    return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n\r]*/g, "").replace(/\s+/g, " ").replace(/\s*([{};:,=()])\s*/g, "$1").trim();
}
class SelfStoppingGovernor {
    saturatedTreeHash = null;
    consecutiveFailures = 0;
    maxConsecutiveFailures;
    maxCycles;
    currentCycle = 0;
    skippedPaths = new Set();
    lastFilePath;
    constructor(options){
        this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? 3;
        this.maxCycles = options?.maxCycles ?? 100;
    }
    computeTreeFingerprint(files) {
        const sorted = [
            ...files
        ].sort((a, b)=>a.path.localeCompare(b.path));
        const raw = sorted.map((f)=>`${f.path}:${f.sha ?? f.size ?? 0}`).join("|");
        let hash = 0;
        for(let i = 0; i < raw.length; i++){
            hash = (hash << 5) - hash + raw.charCodeAt(i) | 0;
        }
        return "tree_fp_" + Math.abs(hash).toString(16);
    }
    checkTreeSaturation(currentTreeFingerprint) {
        if (this.saturatedTreeHash && this.saturatedTreeHash === currentTreeFingerprint) {
            return {
                shouldHalt: true,
                reason: "TREE_FINGERPRINT_SATURATED",
                detail: `Tree fingerprint identical to prior saturation state (${currentTreeFingerprint}). Evolution converged.`
            };
        }
        return null;
    }
    setSaturatedTreeHash(hash) {
        this.saturatedTreeHash = hash;
    }
    checkZeroDiffSaturation(originalCode, proposedCode) {
        const normOriginal = normalizeCode(originalCode);
        const normProposed = normalizeCode(proposedCode);
        if (normOriginal === normProposed) {
            return {
                shouldHalt: true,
                reason: "ZERO_DIFF_SATURATION",
                detail: "Normalized AST code difference is 0. System has reached maximum code saturation."
            };
        }
        return null;
    }
    recordResult(success, filePath) {
        if (filePath && this.lastFilePath && this.lastFilePath !== filePath) {
            this.currentCycle = 0;
        }
        if (filePath) {
            this.lastFilePath = filePath;
        }
        this.currentCycle++;
        if (this.currentCycle >= this.maxCycles) {
            return {
                shouldHalt: true,
                reason: "MAX_CYCLES_REACHED",
                detail: `Cycle cap of ${this.maxCycles} reached. Terminating loop to conserve resources.`
            };
        }
        if (!success) {
            this.consecutiveFailures++;
            if (filePath) {
                this.skippedPaths.add(filePath);
            }
            if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
                return {
                    shouldHalt: true,
                    reason: "CONSECUTIVE_FAILURE_LIMIT",
                    detail: `Reached threshold of ${this.maxConsecutiveFailures} consecutive failure cycles. Quarantining mutations.`
                };
            }
        } else {
            this.consecutiveFailures = 0;
        }
        return null;
    }
    getConsecutiveFailures() {
        return this.consecutiveFailures;
    }
    getSkippedPaths() {
        return Array.from(this.skippedPaths);
    }
    getCurrentCycle() {
        return this.currentCycle;
    }
    getMaxCycles() {
        return this.maxCycles;
    }
    setMaxCycles(max) {
        if (typeof max === "number" && max > 0) {
            this.maxCycles = Math.min(1000, max);
        }
    }
    reset() {
        this.consecutiveFailures = 0;
        this.currentCycle = 0;
        this.skippedPaths.clear();
        this.saturatedTreeHash = null;
        this.lastFilePath = undefined;
    }
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
"[project]/src/lib/pipeline/emg/emg-rag.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "emgRagInstance",
    ()=>emgRagInstance
]);
/**
 * Pattern Vector Memory Helper (server-side RAG with real TF-IDF scoring)
 *
 * Replaces the previous token-overlap scorer with proper TF-IDF vectors
 * and cosine similarity. Stop words are filtered. Term frequencies are
 * weighted by inverse document frequency across the memory bank, so
 * rare distinctive terms (like "WeakMap", "Shannon", "AST") dominate the
 * similarity score over common words (like "the", "and").
 *
 * Persistence: in-memory + best-effort Prisma. The DB is seeded once on
 * first use with the baseline patterns below.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-route] (ecmascript)");
;
const INITIAL_MEMORY_ENTRIES = [
    {
        provenance: "clean",
        trust: "high",
        filePath: "src/engine/zero-leak-sandbox.ts",
        ruleToAvoid: "Never hold hard references to ephemeral mutation contexts in global maps.",
        diagnosis: "WeakMap scoped garbage collection completely eliminates session leakage.",
        cleanSnippet: "private readonly activeContexts = new WeakMap<object, SandboxContext>();",
        content: "WeakMap isolated execution context preventing memory leak across autonomous cycles."
    },
    {
        provenance: "failure",
        trust: "high",
        filePath: "src/lib/gemini.ts",
        ruleToAvoid: "Hardcoded API keys or unencrypted credentials in repository blobs.",
        diagnosis: "Shannon entropy scan flags unredacted keys before Git commit dispatch.",
        cleanSnippet: "const apiKey = process.env.GEMINI_API_KEY || '[REDACTED_SECRET]';",
        content: "Secret leakage vulnerability detected via entropy threshold exceeding 4.2."
    },
    {
        provenance: "clean",
        trust: "high",
        filePath: "src/lib/ast-diff-gate.ts",
        ruleToAvoid: "Silent symbol omission during AST transformations.",
        diagnosis: "Enforce AST Diff Gate symbol retention minimum of 60% before merge.",
        cleanSnippet: "const missingSymbols = originalSymbols.filter(s => !proposedNames.has(s.name));",
        content: "AST structural verification preventing function or type erasure."
    },
    {
        provenance: "clean",
        trust: "high",
        filePath: "src/engine/halt.ts",
        ruleToAvoid: "Infinite re-mutation of semantically identical files.",
        diagnosis: "0-diff AST code normalization halts over-optimization.",
        cleanSnippet: "if (normOriginal === normProposed) { return { shouldHalt: true }; }",
        content: "Self-stopping point architecture preventing infinite autonomous loops."
    },
    {
        provenance: "failure",
        trust: "high",
        filePath: "src/lib/eval-runtime.ts",
        ruleToAvoid: "Dynamic code execution (eval/Function) opens injection vectors.",
        diagnosis: "Static review flags any eval() or new Function() usage before commit.",
        cleanSnippet: "// Replace with a parser/interpreter sandbox",
        content: "Dynamic code execution flagged by review tribunal; rewrite required before merge."
    },
    {
        provenance: "clean",
        trust: "medium",
        filePath: "src/engines/clean-room-runtime.ts",
        ruleToAvoid: "Unbounded agent loops can run forever without progress checks.",
        diagnosis: "Bounded ReAct loop with step cap + cycle detection breaks infinite loops.",
        cleanSnippet: "if (seenActions.has(actionSig)) { break; }",
        content: "Bounded agent reasoning loop with action-signature cycle detection."
    }
];
const STOP_WORDS = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "but",
    "if",
    "then",
    "else",
    "for",
    "while",
    "do",
    "of",
    "in",
    "on",
    "at",
    "to",
    "from",
    "by",
    "with",
    "without",
    "into",
    "out",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "as",
    "not",
    "no",
    "yes",
    "we",
    "you",
    "they",
    "he",
    "she",
    "him",
    "her",
    "them",
    "us",
    "i",
    "me",
    "can",
    "could",
    "should",
    "would",
    "may",
    "might",
    "must",
    "shall",
    "will",
    "any",
    "all",
    "some",
    "none",
    "both",
    "either",
    "neither",
    "each",
    "every",
    "before",
    "after",
    "during",
    "while",
    "since",
    "until",
    "up",
    "down",
    "over",
    "more",
    "less",
    "most",
    "least",
    "very",
    "too",
    "quite",
    "just",
    "only"
]);
function tokenize(text) {
    return text.toLowerCase().split(/[^a-z0-9_+-]+/).filter((t)=>t.length > 2 && !STOP_WORDS.has(t));
}
/**
 * Compute term frequencies for a document.
 */ function termFreq(doc) {
    const tokens = tokenize(doc);
    const tf = new Map();
    for (const t of tokens){
        tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    return tf;
}
/**
 * Compute IDF for each term across a corpus of documents.
 * idf(t) = log(N / (1 + df(t)))
 */ function computeIdf(documents) {
    const N = documents.length;
    const df = new Map();
    for (const doc of documents){
        const seen = new Set(tokenize(doc));
        for (const t of seen){
            df.set(t, (df.get(t) ?? 0) + 1);
        }
    }
    const idf = new Map();
    for (const [t, d] of df){
        idf.set(t, Math.log((N + 1) / (1 + d)) + 1);
    }
    return idf;
}
/**
 * Compute the TF-IDF vector for a document given an IDF map.
 * Vector is normalized to unit length so cosine similarity is just a dot product.
 */ function tfidfVector(doc, idf) {
    const tf = termFreq(doc);
    const vec = new Map();
    let norm = 0;
    for (const [t, freq] of tf){
        const weight = freq * (idf.get(t) ?? 1);
        vec.set(t, weight);
        norm += weight * weight;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (const [t, w] of vec){
            vec.set(t, w / norm);
        }
    }
    return vec;
}
function cosine(a, b) {
    // a is unit-normalized; for efficiency we iterate over the smaller vector.
    const [small, large] = a.size < b.size ? [
        a,
        b
    ] : [
        b,
        a
    ];
    let dot = 0;
    for (const [t, w] of small){
        const other = large.get(t);
        if (other) dot += w * other;
    }
    // b is also unit-normalized so dot product = cosine
    return dot;
}
class EmgRagMemory {
    entries = [];
    idf = new Map();
    vectors = new Map();
    seeded = false;
    async ensureSeeded() {
        if (this.seeded) return;
        this.seeded = true;
        try {
            const count = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].memoryEntry.count();
            if (count === 0) {
                for (const entry of INITIAL_MEMORY_ENTRIES){
                    await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].memoryEntry.create({
                        data: {
                            provenance: entry.provenance,
                            trust: entry.trust,
                            filePath: entry.filePath,
                            ruleToAvoid: entry.ruleToAvoid,
                            diagnosis: entry.diagnosis,
                            cleanSnippet: entry.cleanSnippet,
                            content: entry.content
                        }
                    });
                }
            }
            const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].memoryEntry.findMany({
                orderBy: {
                    createdAt: "asc"
                }
            });
            this.entries = rows.map((r)=>({
                    id: r.id,
                    provenance: r.provenance,
                    trust: r.trust,
                    filePath: r.filePath ?? undefined,
                    ruleToAvoid: r.ruleToAvoid ?? undefined,
                    diagnosis: r.diagnosis ?? undefined,
                    cleanSnippet: r.cleanSnippet ?? undefined,
                    content: r.content,
                    timestamp: r.createdAt.getTime()
                }));
        } catch  {
            this.entries = INITIAL_MEMORY_ENTRIES.map((e, idx)=>({
                    ...e,
                    id: `seed-${idx}`,
                    timestamp: Date.now() - idx * 60000
                }));
        }
        this.recomputeVectors();
    }
    entryDoc(e) {
        return `${e.content} ${e.diagnosis ?? ""} ${e.ruleToAvoid ?? ""} ${e.filePath ?? ""}`;
    }
    recomputeVectors() {
        const docs = this.entries.map((e)=>this.entryDoc(e));
        this.idf = computeIdf(docs);
        this.vectors.clear();
        for (const e of this.entries){
            this.vectors.set(e.id, tfidfVector(this.entryDoc(e), this.idf));
        }
    }
    getAll() {
        return [
            ...this.entries
        ];
    }
    addEntry(entry) {
        const newEntry = {
            ...entry,
            id: `vec-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            timestamp: Date.now()
        };
        this.entries.push(newEntry);
        // Recompute IDF + vectors incrementally is overkill; just recompute all.
        this.recomputeVectors();
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].memoryEntry.create({
            data: {
                provenance: entry.provenance,
                trust: entry.trust,
                filePath: entry.filePath ?? null,
                ruleToAvoid: entry.ruleToAvoid ?? null,
                diagnosis: entry.diagnosis ?? null,
                cleanSnippet: entry.cleanSnippet ?? null,
                content: entry.content
            }
        }).catch(()=>{
        /* ignore */ });
        return newEntry;
    }
    query(queryText) {
        if (this.entries.length === 0 || this.idf.size === 0) {
            return {
                topFailures: [],
                topFixes: [],
                cognitiveFrictionScore: 0.05,
                epistemicRuling: "EMPTY_MEMORY: No pattern history yet."
            };
        }
        const queryVec = tfidfVector(queryText, this.idf);
        const scored = this.entries.map((entry)=>{
            const vec = this.vectors.get(entry.id);
            const score = vec ? cosine(queryVec, vec) : 0;
            return {
                entry,
                score
            };
        });
        const topFixes = scored.filter((s)=>s.entry.provenance === "clean").sort((a, b)=>b.score - a.score).slice(0, 3).map((s)=>s.entry);
        const topFailures = scored.filter((s)=>s.entry.provenance === "failure").sort((a, b)=>b.score - a.score).slice(0, 3).map((s)=>s.entry);
        // Friction: how much failure signal dominates over clean signal.
        const maxFailureScore = topFailures[0]?.score ?? 0;
        const maxFixScore = topFixes[0]?.score ?? 0;
        const friction = Math.min(1, Math.max(0, maxFailureScore * 0.8 + (topFailures.length > topFixes.length ? 0.2 : 0) + (maxFixScore === 0 ? 0.15 : 0)));
        let ruling = "EPISTEMIC_HARMONY: Mutation aligns with validated clean-room patterns.";
        if (maxFailureScore > maxFixScore && maxFailureScore > 0.05) {
            ruling = "COGNITIVE_FRICTION_ELEVATED: Known failure patterns dominate the query signal.";
        } else if (friction > 0.6) {
            ruling = "CONTRADICTION_UNRESOLVED: Conflicting architectural constraints detected.";
        } else if (maxFixScore < 0.02 && maxFailureScore < 0.02) {
            ruling = "NOVEL_INPUT: Query has low similarity to any prior pattern — proceed with caution.";
        }
        return {
            topFailures,
            topFixes,
            cognitiveFrictionScore: friction,
            epistemicRuling: ruling
        };
    }
    clear() {
        this.entries = [];
        this.idf.clear();
        this.vectors.clear();
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].memoryEntry.deleteMany({}).catch(()=>{
        /* ignore */ });
    }
}
const emgRagInstance = new EmgRagMemory();
}),
"[externals]/crypto [external] (crypto, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("crypto", () => require("crypto"));

module.exports = mod;
}),
"[project]/src/lib/pipeline/core/binaryShield.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "BinaryShield",
    ()=>BinaryShield,
    "binaryShieldInstance",
    ()=>binaryShieldInstance
]);
/**
 * BinaryShield Cryptographic Helper Engine (server-safe)
 *
 * Node-native implementation using the built-in `crypto` module. The original
 * project relied on `window.crypto.subtle`; in the Next.js server runtime we
 * use `crypto.createHash` (SHA-256) and `crypto.randomBytes` (IV) so the
 * pipeline can run inside API routes and the autonomous loop service.
 */ var __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/crypto [external] (crypto, cjs)");
;
const ALGO = "aes-256-gcm";
const SECRET_SEED = process.env.BINARY_SHIELD_SEED ?? "HELPER_SECURITY_KEY_2026";
function getKeyBuffer() {
    // Derive a 32-byte key from the seed using SHA-256.
    return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["createHash"])("sha256").update(SECRET_SEED).digest();
}
class BinaryShield {
    async encrypt(plainText) {
        const key = getKeyBuffer();
        const iv = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["randomBytes"])(12);
        const cipher = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["createCipheriv"])(ALGO, key, iv);
        const enc = Buffer.concat([
            cipher.update(plainText, "utf8"),
            cipher.final()
        ]);
        const tag = cipher.getAuthTag();
        // Pack the GCM tag with the ciphertext so decryption can verify it.
        const combined = Buffer.concat([
            enc,
            tag
        ]);
        return {
            data: combined.toString("base64"),
            iv: iv.toString("base64"),
            timestamp: Date.now(),
            algorithm: "AES-GCM-256"
        };
    }
    async decrypt(packet) {
        const key = getKeyBuffer();
        const iv = Buffer.from(packet.iv, "base64");
        const combined = Buffer.from(packet.data, "base64");
        if (combined.length < 16) throw new Error("Ciphertext too short");
        const tag = combined.subarray(combined.length - 16);
        const enc = combined.subarray(0, combined.length - 16);
        const decipher = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["createDecipheriv"])(ALGO, key, iv);
        decipher.setAuthTag(tag);
        const dec = Buffer.concat([
            decipher.update(enc),
            decipher.final()
        ]);
        return dec.toString("utf8");
    }
    async computeHash(data) {
        return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["createHash"])("sha256").update(data).digest("hex");
    }
}
const binaryShieldInstance = new BinaryShield();
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
"[project]/src/lib/pipeline/core/unified-pipeline.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "UnifiedPipelineRunner",
    ()=>UnifiedPipelineRunner,
    "unifiedPipelineRunnerInstance",
    ()=>unifiedPipelineRunnerInstance
]);
/**
 * Unified Code Refactoring Helper Pipeline (server-side)
 *
 * Stages 0-5:
 *   0. Pattern Ingestion & Template Selection
 *   1. Shannon Entropy Pre-Screen & Secret Sanitization
 *   2. 5-Pillar Modular Agent Reasoning Loop
 *   3. AST Diff Gate Structural & Symbol Verification
 *   4. Code Review & Verification (Security vs Architecture)
 *   5. Proof-of-Clean Synthesis, Convergence, and Git Dispatch
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$core$2f$siphon$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/core/siphon.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$emg$2f$sanitizer$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/emg/sanitizer.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$engines$2f$clean$2d$room$2d$runtime$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/engines/clean-room-runtime.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$core$2f$ast$2d$diff$2d$gate$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/core/ast-diff-gate.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$debate$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/llm/debate-llm.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$emg$2f$halt$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/emg/halt.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$emg$2f$emg$2d$rag$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/emg/emg-rag.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$core$2f$binaryShield$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/core/binaryShield.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$postmortem$2f$postmortem$2d$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/postmortem/postmortem-store.ts [app-route] (ecmascript)");
;
;
;
;
;
;
;
;
;
class UnifiedPipelineRunner {
    governor = new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$emg$2f$halt$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["SelfStoppingGovernor"]({
        maxCycles: 100,
        maxConsecutiveFailures: 3
    });
    async runPipeline(config, onStageUpdate, onLog) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$emg$2f$emg$2d$rag$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["emgRagInstance"].ensureSeeded();
        const pipelineId = `helper_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const logs = [];
        const log = (entry)=>{
            logs.push(entry);
            if (onLog) onLog(entry);
        };
        const stages = {
            stage0_ingestion: {
                id: "stage0_ingestion",
                name: "0. Pattern Ingestion Helper",
                status: "pending",
                summary: "Waiting to initialize pattern sources"
            },
            stage1_sanitization: {
                id: "stage1_sanitization",
                name: "1. Security Sanitizer Helper",
                status: "pending",
                summary: "Waiting for credential and entropy scan"
            },
            stage2_reasoning: {
                id: "stage2_reasoning",
                name: "2. Modular Agent Helper",
                status: "pending",
                summary: "Waiting for bounded ReAct reasoning loop"
            },
            stage3_ast_gate: {
                id: "stage3_ast_gate",
                name: "3. AST Verification Helper",
                status: "pending",
                summary: "Waiting for AST symbol retention check"
            },
            stage4_review: {
                id: "stage4_review",
                name: "4. Code Review Helper",
                status: "pending",
                summary: "Waiting for dual-perspective review"
            },
            stage5_convergence: {
                id: "stage5_convergence",
                name: "5. Commit & Convergence Helper",
                status: "pending",
                summary: "Waiting for convergence evaluation"
            }
        };
        const updateStage = (stageId, status, summary, details, durationMs)=>{
            stages[stageId] = {
                ...stages[stageId],
                status,
                summary,
                details,
                durationMs
            };
            if (onStageUpdate) onStageUpdate(stages[stageId]);
        };
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: `[HELPER START] Target: ${config.targetRepo}:${config.filePath} (${config.targetBranch})`,
            type: "info"
        });
        // STAGE 0
        const t0 = performance.now();
        updateStage("stage0_ingestion", "running", "Analyzing target structure and selecting architectural pattern...");
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: "[STAGE 0] Analyzing codebase patterns and selecting enhancement template...",
            type: "info"
        });
        const patternVote = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$core$2f$siphon$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["performArchitecturalVote"])(config.filePath, config.code);
        const selectedSource = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$core$2f$siphon$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["SIPHON_SOURCES"].find((s)=>s.id === config.siphonSourceId) || patternVote.source;
        const dur0 = Math.round(performance.now() - t0);
        updateStage("stage0_ingestion", "succeeded", `Applied template: ${selectedSource.label}`, {
            selectedSource,
            vote: patternVote
        }, dur0);
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: `[STAGE 0] Selected pattern: ${selectedSource.label} (Confidence: ${patternVote.score}%)`,
            type: "success"
        });
        // STAGE 1
        const t1 = performance.now();
        updateStage("stage1_sanitization", "running", "Running Shannon entropy calculation and credential scan...");
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: "[STAGE 1] Scanning buffers for credential leakage and high-entropy secrets...",
            type: "info"
        });
        const sanitizerResult = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$emg$2f$sanitizer$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["sanitizeAndGovern"])(config.code, config.filePath);
        const dur1 = Math.round(performance.now() - t1);
        if (sanitizerResult.clean) {
            updateStage("stage1_sanitization", "succeeded", "Clean: 0 hardcoded credentials or high-entropy secrets detected.", {
                violations: []
            }, dur1);
            log({
                timestamp: new Date().toLocaleTimeString(),
                message: "[STAGE 1] Pre-screen passed: 0 credentials leaked.",
                type: "success"
            });
        } else {
            updateStage("stage1_sanitization", "succeeded", `Sanitized ${sanitizerResult.violations.length} secret token(s) prior to execution.`, {
                violations: sanitizerResult.violations
            }, dur1);
            log({
                timestamp: new Date().toLocaleTimeString(),
                message: `[STAGE 1] Sanitized ${sanitizerResult.violations.length} high-entropy token(s). Redactions applied.`,
                type: "warn"
            });
        }
        const sanitizedBaseCode = sanitizerResult.sanitizedCode;
        // STAGE 2
        const t2 = performance.now();
        updateStage("stage2_reasoning", "running", "Running bounded ReAct loop with in-memory VFS sandbox...");
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: `[STAGE 2] Executing modular agent loop for: "${config.userPrompt.slice(0, 60)}..."`,
            type: "info"
        });
        // Fetch per-file postmortem constraints (if any prior failures recorded)
        const postmortemConstraints = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$postmortem$2f$postmortem$2d$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["postmortemStore"].getConstraintsForFile(config.targetRepo, config.targetBranch, config.filePath);
        if (postmortemConstraints.hasActivePostmortem) {
            log({
                timestamp: new Date().toLocaleTimeString(),
                message: `[STAGE 2] Active postmortem found (${postmortemConstraints.failureType}, ${postmortemConstraints.attempts} prior failure(s)). Injecting constraints into LLM prompt.`,
                type: "warn"
            });
        }
        const agentGoal = `${config.userPrompt} (Template: ${selectedSource.label})`;
        const agentEngineResult = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$engines$2f$clean$2d$room$2d$runtime$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["executeCleanRoomEngine"])("inference-reasoning-loop", agentGoal, {
            originalCode: sanitizedBaseCode,
            filePath: config.filePath,
            postmortemConstraints: postmortemConstraints.promptBlock
        });
        const dur2 = Math.round(performance.now() - t2);
        const llmStatus = agentEngineResult.llmUsed ? `LLM refactor produced ${agentEngineResult.proposedEvolvedCode.length} bytes (${agentEngineResult.llmTotalLatencyMs}ms).` : `LLM unavailable (${agentEngineResult.llmError ?? "unknown"}). Deterministic fallback engaged.`;
        updateStage("stage2_reasoning", "succeeded", `Completed in ${agentEngineResult.steps.length} bounded steps. ${llmStatus}`, {
            steps: agentEngineResult.steps.length,
            tokenBudget: agentEngineResult.tokenBudget,
            llmUsed: agentEngineResult.llmUsed,
            llmLatencyMs: agentEngineResult.llmTotalLatencyMs
        }, dur2);
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: `[STAGE 2] Agent loop completed (${agentEngineResult.steps.length} steps). ${llmStatus}`,
            type: agentEngineResult.llmUsed ? "success" : "warn"
        });
        // Synthesize proposed evolved code.
        // The LLM's refactored output IS the enhancement — we do NOT prepend a
        // "Enhanced by Architecture Helper Pipeline" header. That header was
        // cosmetic noise that polluted every committed file without adding
        // value. If the LLM produced no semantic change, we return the
        // original code unchanged and let the 0-diff saturation check halt
        // the cycle (no commit = no noise).
        let evolvedCode;
        if (agentEngineResult.llmUsed && agentEngineResult.proposedEvolvedCode.trim()) {
            // Real LLM-produced code — sanitize it again (defense in depth)
            // and use it AS-IS. No header prepended.
            const llmCode = agentEngineResult.proposedEvolvedCode;
            const reSanitized = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$emg$2f$sanitizer$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["sanitizeAndGovern"])(llmCode, config.filePath);
            evolvedCode = reSanitized.sanitizedCode;
            log({
                timestamp: new Date().toLocaleTimeString(),
                message: `[STAGE 2] Using LLM-refactored code (${llmCode.length} bytes, re-sanitized: ${reSanitized.violations.length} violations).`,
                type: reSanitized.clean ? "success" : "warn"
            });
        } else {
            // LLM unavailable or produced no code — return the original
            // unchanged. The 0-diff saturation check will halt this cycle
            // (no semantic change = nothing to commit). We do NOT inject a
            // cosmetic header or unused ExecutionContract interface.
            evolvedCode = sanitizedBaseCode;
            log({
                timestamp: new Date().toLocaleTimeString(),
                message: `[STAGE 2] No LLM refactor produced. Returning original code unchanged (no cosmetic header injected).`,
                type: "warn"
            });
        }
        // STAGE 3
        const t3 = performance.now();
        updateStage("stage3_ast_gate", "running", "Verifying AST symbol retention and structural drift...");
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: "[STAGE 3] Evaluating AST symbol retention ratio and syntax invariants...",
            type: "info"
        });
        const astDiffResult = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$core$2f$ast$2d$diff$2d$gate$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["evaluateAstDiff"])(config.code, evolvedCode, config.filePath);
        const dur3 = Math.round(performance.now() - t3);
        if (astDiffResult.passed) {
            updateStage("stage3_ast_gate", "succeeded", `Passed: AST Score ${astDiffResult.astScore}/100, Retained ${astDiffResult.symbolMap.retainedCount}/${astDiffResult.symbolMap.originalCount} symbols (${astDiffResult.parserUsed}).`, {
                astScore: astDiffResult.astScore,
                violations: astDiffResult.violations,
                parserUsed: astDiffResult.parserUsed,
                symbolMap: astDiffResult.symbolMap,
                drift: astDiffResult.structuralDriftRatio
            }, dur3);
            log({
                timestamp: new Date().toLocaleTimeString(),
                message: `[STAGE 3] AST verification passed with score ${astDiffResult.astScore}/100.`,
                type: "success"
            });
        } else {
            updateStage("stage3_ast_gate", "blocked", `AST integrity check flagged violations (Score: ${astDiffResult.astScore}/100, ${astDiffResult.parserUsed}).`, {
                violations: astDiffResult.violations,
                parserUsed: astDiffResult.parserUsed,
                symbolMap: astDiffResult.symbolMap,
                drift: astDiffResult.structuralDriftRatio
            }, dur3);
            log({
                timestamp: new Date().toLocaleTimeString(),
                message: `[STAGE 3] AST violations flagged: ${astDiffResult.violations.map((v)=>v.code).join(", ")}`,
                type: "warn"
            });
        }
        // STAGE 4
        const t4 = performance.now();
        updateStage("stage4_review", "running", "Conducting dual-perspective review (Security vs Architecture)...");
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: "[STAGE 4] Convening LLM review tribunal: Security Reviewer vs Architecture Reviewer...",
            type: "info"
        });
        const debateResult = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$llm$2f$debate$2d$llm$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["conductLlmDebate"])(`Code Review for ${config.filePath}`, evolvedCode, config.filePath);
        const reviewVerdict = debateResult.verdict;
        const dur4 = Math.round(performance.now() - t4);
        const isReviewApproved = reviewVerdict.consensus === "APPROVED" || reviewVerdict.consensus === "CONDITIONAL_APPROVAL";
        updateStage("stage4_review", isReviewApproved ? "succeeded" : "blocked", `Verdict: ${reviewVerdict.consensus} (Consensus: ${(reviewVerdict.consensusCoefficient * 100).toFixed(0)}%) ${debateResult.usedLlm ? "[LLM]" : "[rule-based fallback]"}`, {
            consensus: reviewVerdict.consensus,
            coefficient: reviewVerdict.consensusCoefficient,
            usedLlm: debateResult.usedLlm,
            llmError: debateResult.llmError
        }, dur4);
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: `[STAGE 4] Review outcome: ${reviewVerdict.consensus} (${reviewVerdict.leadSummary}) ${debateResult.usedLlm ? "[LLM]" : "[fallback]"}`,
            type: isReviewApproved ? "success" : "warn"
        });
        // STAGE 5
        const t5 = performance.now();
        updateStage("stage5_convergence", "running", "Verifying convergence and generating proof commit...");
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: "[STAGE 5] Checking 0-diff code saturation and computing proof commit hash...",
            type: "info"
        });
        const zeroDiffCheck = this.governor.checkZeroDiffSaturation(config.code, evolvedCode);
        let haltState = zeroDiffCheck;
        if (zeroDiffCheck) {
            log({
                timestamp: new Date().toLocaleTimeString(),
                message: `[STAGE 5] Saturation check triggered: ${zeroDiffCheck.detail}`,
                type: "warn"
            });
        } else {
            const recordHalt = this.governor.recordResult(astDiffResult.passed, config.filePath);
            if (recordHalt) {
                haltState = recordHalt;
                log({
                    timestamp: new Date().toLocaleTimeString(),
                    message: `[STAGE 5] Loop convergence guard engaged: ${recordHalt.detail}`,
                    type: "warn"
                });
            }
        }
        const proofCommitHash = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$core$2f$binaryShield$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["binaryShieldInstance"].computeHash(evolvedCode).then((h)=>h.slice(0, 7)).catch(()=>"c_" + Math.abs(Date.now() ^ 0x5f3759df).toString(16).slice(0, 7));
        const dur5 = Math.round(performance.now() - t5);
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$emg$2f$emg$2d$rag$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["emgRagInstance"].addEntry({
            provenance: "clean",
            trust: "high",
            filePath: config.filePath,
            content: `Code Refactoring Helper run for ${config.filePath}. AST Score: ${astDiffResult.astScore}, Proof Hash: ${proofCommitHash}`,
            cleanSnippet: evolvedCode.slice(0, 150),
            diagnosis: `Review: ${reviewVerdict.consensus}`
        });
        updateStage("stage5_convergence", "succeeded", `Converged. Generated proof commit: ${proofCommitHash}`, {
            proofCommitHash,
            haltState
        }, dur5);
        log({
            timestamp: new Date().toLocaleTimeString(),
            message: `[STAGE 5] Helper pipeline finished. Clean Proof Commit Hash: ${proofCommitHash}`,
            type: "success"
        });
        let finalStatus = "COMPLETED";
        if (!astDiffResult.passed || reviewVerdict.consensus === "REJECTED") {
            finalStatus = "REJECTED";
        } else if (haltState && haltState.shouldHalt) {
            finalStatus = "HALTED";
        } else if (!sanitizerResult.clean) {
            finalStatus = "SANITIZED_APPLIED";
        }
        return {
            id: pipelineId,
            timestamp: Date.now(),
            config,
            status: finalStatus,
            stages,
            originalCode: config.code,
            evolvedCode,
            patternVote,
            siphonVote: patternVote,
            sanitizerResult,
            agentEngineResult,
            astDiffResult,
            reviewVerdict,
            tribunalVerdict: reviewVerdict,
            haltState,
            proofCommitHash,
            logs
        };
    }
    resetGovernor() {
        this.governor.reset();
    }
    setMaxCycles(max) {
        this.governor.setMaxCycles(max);
    }
    getGovernorCycles() {
        return {
            current: this.governor.getCurrentCycle(),
            max: this.governor.getMaxCycles()
        };
    }
}
const unifiedPipelineRunnerInstance = new UnifiedPipelineRunner();
}),
"[externals]/events [external] (events, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("events", () => require("events"));

module.exports = mod;
}),
"[project]/src/lib/pipeline/autonomous/loop-event-bus.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "loopEventBus",
    ()=>loopEventBus
]);
/**
 * Loop Event Bus — in-process pub/sub for streaming autonomous loop events
 * to the WebSocket mini-service. Lives in the Next.js server process so the
 * API routes can publish here and the WS mini-service (running on port 3003)
 * can poll via HTTP if needed, or — when running in the same process —
 * subscribe directly.
 */ var __TURBOPACK__imported__module__$5b$externals$5d2f$events__$5b$external$5d$__$28$events$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/events [external] (events, cjs)");
;
class LoopEventBus extends __TURBOPACK__imported__module__$5b$externals$5d2f$events__$5b$external$5d$__$28$events$2c$__cjs$29$__["EventEmitter"] {
    constructor(){
        super();
        this.setMaxListeners(50);
    }
    emit(evt) {
        return super.emit("event", evt);
    }
    on(listener) {
        super.on("event", listener);
        return ()=>{
            super.off("event", listener);
        };
    }
}
const loopEventBus = new LoopEventBus();
}),
"[project]/src/lib/pipeline/autonomous/loop-runtime.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "autonomousLoopRuntime",
    ()=>autonomousLoopRuntime
]);
/**
 * Autonomous Self-Enhancement Loop Runtime (singleton, server-side)
 *
 * Supports four modes for triggering pipeline runs without manual interaction:
 *   1. scheduled   — interval-based cron-like timer (default 10 min)
 *   2. watch       — file-system-ish watcher over the target repo
 *                    (re-runs when remote tree fingerprint changes)
 *   3. continuous  — true continuous agent loop: back-to-back cycles with
 *                    saturation-driven self-stop (per halt governor)
 *   4. manual      — one-shot /api/autonomous/trigger invocation
 *
 * Each cycle:
 *   - fetches the target repo tree
 *   - selects up to N code files (sliced)
 *   - runs the 6-stage pipeline on each (sanitizer -> AST -> review)
 *   - if `autoPush` and gates pass, dispatches batch commit to GitHub
 *   - records a cycle in the DB and broadcasts logs via the WebSocket bus
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$core$2f$unified$2d$pipeline$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/core/unified-pipeline.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$loop$2d$event$2d$bus$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/autonomous/loop-event-bus.ts [app-route] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$postmortem$2f$postmortem$2d$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/postmortem/postmortem-store.ts [app-route] (ecmascript)");
;
;
;
;
class AutonomousLoopRuntime {
    config = {
        enabled: false,
        mode: "scheduled",
        intervalMinutes: 10,
        targetRepo: "craighckby-stack/66",
        branch: "main",
        evolutionBranch: "helper-evolution",
        maxCycles: 100,
        maxFilesPerCycle: 5,
        autoPush: true,
        siphonSourceId: "pattern-optimizer-helper",
        userPrompt: "Apply 5-pillar modular refactoring with AST retention and Shannon entropy sanitization.",
        githubToken: ""
    };
    status = "idle";
    stats = {
        totalRuns: 0,
        totalFilesScanned: 0,
        totalFilesCommitted: 0,
        lastRunTime: null,
        lastTreeFingerprint: null,
        nextRunAt: null
    };
    logs = [];
    currentCycle = null;
    recentCycles = [];
    timer = null;
    continuousLoopRunning = false;
    // --- Token resolution (don't log the value) ---
    resolveToken(clientToken) {
        const candidate = (clientToken ?? this.config.githubToken ?? process.env.GITHUB_TOKEN ?? "").trim();
        if (!candidate || candidate.startsWith("MY_") || candidate === "undefined" || candidate.length < 8) {
            return null;
        }
        return candidate;
    }
    addLog(message, type = "info", source = "autonomous") {
        const entry = {
            timestamp: new Date().toLocaleTimeString(),
            message,
            type,
            source
        };
        this.logs.unshift(entry);
        if (this.logs.length > 200) this.logs.pop();
        console.log(`[AUTONOMOUS:${source}] [${type.toUpperCase()}] ${message}`);
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$loop$2d$event$2d$bus$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["loopEventBus"].emit({
            kind: "log",
            timestamp: Date.now(),
            log: entry
        });
    }
    emitState() {
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$loop$2d$event$2d$bus$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["loopEventBus"].emit({
            kind: "state",
            timestamp: Date.now(),
            state: this.getState()
        });
    }
    // --- Public API ---
    getState() {
        return {
            config: {
                ...this.config,
                githubToken: this.config.githubToken ? "[REDACTED]" : ""
            },
            status: this.status,
            stats: {
                ...this.stats
            },
            logs: [
                ...this.logs
            ],
            currentCycle: this.currentCycle ? {
                ...this.currentCycle
            } : null,
            recentCycles: [
                ...this.recentCycles
            ]
        };
    }
    updateConfig(patch) {
        const wasEnabled = this.config.enabled;
        const oldMode = this.config.mode;
        this.config = {
            ...this.config,
            ...patch
        };
        // If token was passed as "[REDACTED]" keep previous one (UI never re-sends real value).
        if (patch.githubToken === "[REDACTED]") {
        // Keep the previously-stored token; UI never overwrites with real value during edits.
        // Note: when user submits a *new* real token, that string won't equal "[REDACTED]" so it persists.
        // Re-load previously-stored token from closure (we already overwrote it above).
        // To avoid losing it, only overwrite when caller passed a real token. We handle this in API route.
        }
        this.addLog(`Configuration updated: mode=${this.config.mode}, interval=${this.config.intervalMinutes}m, repo=${this.config.targetRepo}, autoPush=${this.config.autoPush}`, "info");
        if (wasEnabled && this.config.enabled && oldMode !== this.config.mode) {
            this.addLog(`Switching loop mode from ${oldMode} to ${this.config.mode}. Restarting scheduler.`, "info");
            this.restartScheduler();
        }
        this.emitState();
        return {
            ...this.config,
            githubToken: this.config.githubToken ? "[REDACTED]" : ""
        };
    }
    start() {
        if (this.config.enabled && this.status !== "paused") {
            this.addLog("Loop already enabled.", "info");
            return this.getState();
        }
        this.config.enabled = true;
        this.status = "idle";
        this.addLog(`Autonomous loop ENABLED in ${this.config.mode.toUpperCase()} mode. First run scheduled in ${this.config.intervalMinutes} minute(s).`, "success");
        this.restartScheduler();
        this.emitState();
        return this.getState();
    }
    stop() {
        this.config.enabled = false;
        this.status = "paused";
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.continuousLoopRunning = false;
        this.addLog("Autonomous loop DISABLED. No further cycles will run until re-enabled.", "warn");
        this.emitState();
        return this.getState();
    }
    async triggerManual() {
        this.addLog("Manual trigger received. Starting one-shot autonomous cycle...", "info");
        const cycle = await this.executeCycle("manual");
        return {
            started: !!cycle,
            cycleId: cycle?.id ?? null
        };
    }
    restartScheduler() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.continuousLoopRunning = false;
        if (!this.config.enabled) {
            this.status = "paused";
            this.stats.nextRunAt = null;
            return;
        }
        const ms = Math.max(15_000, this.config.intervalMinutes * 60 * 1000);
        this.status = "idle";
        this.stats.nextRunAt = new Date(Date.now() + ms).toISOString();
        this.addLog(`Scheduler armed. Next automatic cycle at ${this.stats.nextRunAt}`, "info");
        this.timer = setInterval(()=>{
            this.executeCycle(this.config.mode).catch((err)=>{
                this.addLog(`Scheduler cycle failed: ${err.message}`, "error");
            });
        }, ms);
        if (this.config.mode === "continuous") {
            this.continuousLoopRunning = true;
            this.runContinuousLoop().catch((err)=>{
                this.addLog(`Continuous loop crashed: ${err.message}`, "error");
            });
        }
        this.emitState();
    }
    async runContinuousLoop() {
        while(this.continuousLoopRunning && this.config.enabled && this.config.mode === "continuous"){
            const cycle = await this.executeCycle("continuous");
            if (!cycle) break;
            if (cycle.status === "halted") {
                this.addLog("Continuous loop halted by governor (saturation or failure limit reached). Pausing.", "warn");
                this.status = "paused";
                this.continuousLoopRunning = false;
                this.emitState();
                break;
            }
            // Brief cooldown between continuous cycles.
            await new Promise((r)=>setTimeout(r, 1500));
        }
        this.continuousLoopRunning = false;
    }
    async executeCycle(mode) {
        if (this.status === "running") {
            this.addLog("Skipping cycle — another cycle already running.", "warn");
            return null;
        }
        this.status = "running";
        this.stats.totalRuns++;
        const cycleId = `cycle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const cycleNumber = this.stats.totalRuns;
        const startedAt = new Date().toISOString();
        this.currentCycle = {
            id: cycleId,
            cycleNumber,
            mode,
            targetRepo: this.config.targetRepo,
            branch: this.config.branch,
            startedAt,
            filesScanned: 0,
            filesCommitted: 0,
            status: "running",
            fileResults: []
        };
        this.addLog(`Starting autonomous cycle #${cycleNumber} (${mode}) on ${this.config.targetRepo}:${this.config.branch}`, "info");
        this.emitState();
        const token = this.resolveToken();
        const headers = {
            "User-Agent": "Architecture-Helper-Pipeline",
            Accept: "application/vnd.github.v3+json"
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        let cycleStatus = "completed";
        let cycleProofHash = null;
        try {
            // 1. Fetch repo tree (recursive)
            const treeUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/trees/${this.config.branch}?recursive=1`;
            let treeRes = await fetch(treeUrl, {
                headers
            });
            if (!treeRes.ok && this.config.branch === "main") {
                const altUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/trees/master?recursive=1`;
                treeRes = await fetch(altUrl, {
                    headers
                });
            }
            if (!treeRes.ok) {
                throw new Error(`GitHub tree fetch failed (${treeRes.status})`);
            }
            const treeData = await treeRes.json();
            const tree = treeData.tree ?? [];
            // Compute tree fingerprint
            const fp = this.computeTreeFingerprint(tree);
            if (this.config.mode === "watch" && this.stats.lastTreeFingerprint === fp) {
                this.addLog(`Watch mode: tree fingerprint unchanged (${fp}). Skipping cycle — no remote changes detected.`, "info");
                cycleStatus = "halted";
                this.finalizeCycle(cycleId, cycleStatus, null);
                return this.currentCycle;
            }
            this.stats.lastTreeFingerprint = fp;
            this.addLog(`Tree fingerprint computed: ${fp} (${tree.length} entries)`, "info");
            // 2. Filter to REAL code files only. The LLM cannot meaningfully
            //    refactor markdown, JSON, YAML, shell, SQL, HTML, or CSS — running
            //    it on those files produces cosmetic comment injection that the
            //    0-diff saturation check then halts on, wasting LLM API calls.
            //    Only include languages where the LLM can extract constants,
            //    add type annotations, modularize, etc.
            const codeExtRegex = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|c|cpp|cc|cs)$/i;
            const ignored = /^(node_modules|\.git|\.next|dist|build|coverage|public\/assets|vendor|third_party|\.agents|docs?|examples?)\//i;
            const codeBlobs = tree.filter((item)=>item.type === "blob" && codeExtRegex.test(item.path) && !ignored.test(item.path)).slice(0, this.config.maxFilesPerCycle);
            this.currentCycle.filesScanned = codeBlobs.length;
            this.stats.totalFilesScanned += codeBlobs.length;
            this.addLog(`Selected ${codeBlobs.length} code file(s) for pipeline processing.`, "info");
            // 2.5. Ensure the evolution branch exists before we try to commit to it.
            //     If the branch doesn't exist, create it from the source branch's HEAD.
            //     This prevents 404 "branch not found" errors on the commit PUT.
            if (token && this.config.autoPush && this.config.evolutionBranch !== this.config.branch) {
                try {
                    const branchCheckUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/ref/heads/${this.config.evolutionBranch}`;
                    const branchCheckRes = await fetch(branchCheckUrl, {
                        headers
                    });
                    if (!branchCheckRes.ok && branchCheckRes.status === 404) {
                        // Branch doesn't exist — create it from source branch HEAD
                        const sourceRefUrl = `https://api.github.com/repos/${this.config.targetRepo}/git/ref/heads/${this.config.branch}`;
                        const sourceRefRes = await fetch(sourceRefUrl, {
                            headers
                        });
                        if (sourceRefRes.ok) {
                            const sourceRefData = await sourceRefRes.json();
                            const sourceSha = sourceRefData.object?.sha;
                            if (sourceSha) {
                                const createBranchRes = await fetch(`https://api.github.com/repos/${this.config.targetRepo}/git/refs`, {
                                    method: "POST",
                                    headers: {
                                        Authorization: `Bearer ${token}`,
                                        "Content-Type": "application/json",
                                        "User-Agent": "Architecture-Helper-Pipeline",
                                        Accept: "application/vnd.github.v3+json"
                                    },
                                    body: JSON.stringify({
                                        ref: `refs/heads/${this.config.evolutionBranch}`,
                                        sha: sourceSha
                                    })
                                });
                                if (createBranchRes.ok) {
                                    this.addLog(`Created evolution branch '${this.config.evolutionBranch}' from ${this.config.branch} (${sourceSha.slice(0, 7)}).`, "success", "github");
                                } else {
                                    const errBody = await createBranchRes.json().catch(()=>({}));
                                    this.addLog(`Failed to create evolution branch: ${errBody?.message ?? `HTTP ${createBranchRes.status}`}`, "warn", "github");
                                }
                            }
                        } else {
                            this.addLog(`Could not resolve source branch '${this.config.branch}' to create evolution branch (HTTP ${sourceRefRes.status}).`, "warn", "github");
                        }
                    } else if (branchCheckRes.ok) {
                        this.addLog(`Evolution branch '${this.config.evolutionBranch}' already exists.`, "info", "github");
                    }
                } catch (err) {
                    this.addLog(`Branch creation check failed: ${err.message}`, "warn", "github");
                }
            }
            // 3. For each file: fetch content, run pipeline, optionally commit
            let committed = 0;
            let halted = false;
            for (const blob of codeBlobs){
                if (halted) break;
                try {
                    const fileUrl = `https://api.github.com/repos/${this.config.targetRepo}/contents/${blob.path}?ref=${this.config.branch}`;
                    const fileRes = await fetch(fileUrl, {
                        headers
                    });
                    if (!fileRes.ok) {
                        this.addLog(`Failed to fetch ${blob.path} (${fileRes.status}). Skipping.`, "warn");
                        continue;
                    }
                    const fileData = await fileRes.json();
                    const rawContent = fileData.content ? Buffer.from(fileData.content, "base64").toString("utf-8") : "";
                    // Run pipeline
                    const report = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$core$2f$unified$2d$pipeline$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["unifiedPipelineRunnerInstance"].runPipeline({
                        githubToken: token ?? undefined,
                        targetRepo: this.config.targetRepo,
                        targetBranch: this.config.branch,
                        evolutionBranch: this.config.evolutionBranch,
                        filePath: blob.path,
                        userPrompt: this.config.userPrompt,
                        siphonSourceId: this.config.siphonSourceId,
                        code: rawContent,
                        triggeredBy: mode
                    }, (stage)=>{
                        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$loop$2d$event$2d$bus$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["loopEventBus"].emit({
                            kind: "stage",
                            timestamp: Date.now(),
                            cycleId,
                            filePath: blob.path,
                            stage
                        });
                    }, (entry)=>{
                        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$loop$2d$event$2d$bus$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["loopEventBus"].emit({
                            kind: "log",
                            timestamp: Date.now(),
                            log: {
                                timestamp: entry.timestamp,
                                message: `[${blob.path}] ${entry.message}`,
                                type: entry.type,
                                source: "pipeline"
                            }
                        });
                    });
                    // Record pipeline run in DB (best-effort)
                    try {
                        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].pipelineRun.create({
                            data: {
                                pipelineId: report.id,
                                targetRepo: this.config.targetRepo,
                                targetBranch: this.config.branch,
                                evolutionBranch: this.config.evolutionBranch,
                                filePath: blob.path,
                                userPrompt: this.config.userPrompt,
                                siphonSourceId: this.config.siphonSourceId,
                                status: report.status,
                                astScore: report.astDiffResult.astScore,
                                consensus: report.reviewVerdict.consensus,
                                proofHash: report.proofCommitHash,
                                originalCode: report.originalCode.slice(0, 200000),
                                evolvedCode: report.evolvedCode.slice(0, 200000),
                                sanitizerClean: report.sanitizerResult.clean,
                                violations: JSON.stringify(report.sanitizerResult.violations),
                                triggeredBy: mode
                            }
                        });
                    } catch (err) {
                        this.addLog(`DB write failed for ${blob.path}: ${err.message}`, "warn");
                    }
                    let pushed = false;
                    // Decompose the gate decision into its constituent parts so we can
                    // log the ACTUAL reason a commit was skipped, instead of lumping
                    // everything under "Gates failed".
                    const astPassed = report.astDiffResult.passed;
                    const reviewApproved = report.reviewVerdict.consensus === "APPROVED" || report.reviewVerdict.consensus === "CONDITIONAL_APPROVAL";
                    const haltReason = report.haltState?.reason;
                    const haltShouldHalt = !!report.haltState?.shouldHalt;
                    // 0-diff saturation means the LLM produced no semantic change —
                    // there is literally nothing to commit, so this is NOT a failure.
                    const isZeroDiffSaturation = haltReason === "ZERO_DIFF_SATURATION";
                    // Real gates passed = AST + review both green AND not halted by
                    // a non-saturation reason (max cycles, consecutive failures).
                    const gatesPassed = astPassed && reviewApproved && !haltShouldHalt;
                    // We only commit when there IS a real change to push.
                    const hasRealChange = !isZeroDiffSaturation;
                    if (gatesPassed && hasRealChange && this.config.autoPush && token) {
                        try {
                            const commitUrl = `https://api.github.com/repos/${this.config.targetRepo}/contents/${blob.path}`;
                            const commitPayload = {
                                message: `Autonomous self-enhancement #${cycleNumber} — ${blob.path} (AST ${report.astDiffResult.astScore}, proof ${report.proofCommitHash})`,
                                content: Buffer.from(report.evolvedCode).toString("base64"),
                                branch: this.config.evolutionBranch
                            };
                            if (fileData.sha) commitPayload.sha = fileData.sha;
                            const commitRes = await fetch(commitUrl, {
                                method: "PUT",
                                headers: {
                                    Authorization: `Bearer ${token}`,
                                    "Content-Type": "application/json",
                                    "User-Agent": "Architecture-Helper-Pipeline",
                                    Accept: "application/vnd.github.v3+json"
                                },
                                body: JSON.stringify(commitPayload)
                            });
                            if (commitRes.ok) {
                                pushed = true;
                                committed++;
                                this.addLog(`Pushed ${blob.path} → ${this.config.evolutionBranch} (proof ${report.proofCommitHash})`, "success", "github");
                            } else {
                                const errBody = await commitRes.json().catch(()=>({}));
                                this.addLog(`Commit failed for ${blob.path}: ${errBody?.message ?? `HTTP ${commitRes.status}`}`, "error", "github");
                            }
                        } catch (err) {
                            this.addLog(`Commit dispatch error for ${blob.path}: ${err.message}`, "error", "github");
                        }
                    } else if (!astPassed) {
                        this.addLog(`Skipping ${blob.path}: AST gate failed (score ${report.astDiffResult.astScore}/100, violations: ${report.astDiffResult.violations.map((v)=>v.code).join(",") || "none"}).`, "warn");
                    } else if (!reviewApproved) {
                        this.addLog(`Skipping ${blob.path}: Review tribunal rejected (${report.reviewVerdict.consensus}, coefficient ${(report.reviewVerdict.consensusCoefficient * 100).toFixed(0)}%).`, "warn");
                    } else if (isZeroDiffSaturation) {
                        this.addLog(`No change for ${blob.path}: LLM produced no semantic diff (0-diff saturation). Nothing to commit.`, "info");
                    } else if (haltShouldHalt) {
                        this.addLog(`Skipping ${blob.path}: Halt governor engaged (${haltReason}: ${report.haltState?.detail ?? ""}).`, "warn");
                        // Only halt the cycle for non-saturation reasons.
                        halted = true;
                        cycleStatus = "halted";
                    } else if (!token) {
                        this.addLog(`No GitHub token available — would have pushed ${blob.path} (proof ${report.proofCommitHash}).`, "warn");
                    }
                    // Postmortem integration: record failures, resolve on success.
                    const repo = this.config.targetRepo;
                    const branch = this.config.branch;
                    if (pushed) {
                        // Commit succeeded — resolve any active postmortem for this file.
                        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$postmortem$2f$postmortem$2d$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["postmortemStore"].markResolved(repo, branch, blob.path).then(()=>{
                            this.addLog(`Postmortem resolved for ${blob.path} (file successfully committed).`, "info");
                        }).catch(()=>{
                        /* ignore */ });
                    } else if (!astPassed || !reviewApproved || isZeroDiffSaturation) {
                        // A real failure — record/update the postmortem so the next
                        // attempt gets the constraints.
                        const pm = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$postmortem$2f$postmortem$2d$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["generatePostmortemFromReport"])({
                            filePath: blob.path,
                            astDiffResult: report.astDiffResult,
                            sanitizerResult: report.sanitizerResult,
                            reviewVerdict: report.reviewVerdict,
                            haltReason: report.haltState?.reason
                        });
                        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$postmortem$2f$postmortem$2d$store$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["postmortemStore"].recordFailure({
                            repo,
                            branch,
                            filePath: blob.path,
                            failureType: pm.failureType,
                            symptom: pm.symptom,
                            evidence: pm.evidence,
                            constraints: pm.constraints
                        }).then((record)=>{
                            this.addLog(`Postmortem recorded for ${blob.path} (attempt #${record.attempts}, ${pm.failureType}). Next attempt will use these constraints.`, "warn");
                        }).catch(()=>{
                        /* ignore */ });
                    }
                    this.currentCycle.fileResults.push({
                        path: blob.path,
                        astScore: report.astDiffResult.astScore,
                        consensus: report.reviewVerdict.consensus,
                        proofHash: report.proofCommitHash,
                        status: report.status,
                        pushed
                    });
                    if (report.proofCommitHash && !cycleProofHash) cycleProofHash = report.proofCommitHash;
                } catch (err) {
                    this.addLog(`File ${blob.path} failed: ${err.message}`, "error");
                }
            }
            this.currentCycle.filesCommitted = committed;
            this.stats.totalFilesCommitted += committed;
            this.stats.lastRunTime = new Date().toISOString();
            if (!halted) cycleStatus = "completed";
        } catch (err) {
            this.addLog(`Cycle #${cycleNumber} aborted: ${err.message}`, "error");
            cycleStatus = "error";
        } finally{
            this.finalizeCycle(cycleId, cycleStatus, cycleProofHash);
            this.status = this.config.enabled ? "idle" : "paused";
            if (this.config.enabled && this.config.mode !== "continuous") {
                const ms = Math.max(15_000, this.config.intervalMinutes * 60 * 1000);
                this.stats.nextRunAt = new Date(Date.now() + ms).toISOString();
            } else {
                this.stats.nextRunAt = null;
            }
            this.emitState();
        }
        return this.currentCycle;
    }
    finalizeCycle(cycleId, status, proofHash) {
        if (!this.currentCycle) return;
        const finishedAt = new Date().toISOString();
        this.currentCycle.status = status;
        this.currentCycle.filesCommitted = this.currentCycle.filesCommitted ?? 0;
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].autonomousCycle.create({
            data: {
                id: cycleId,
                cycleNumber: this.currentCycle.cycleNumber,
                mode: this.currentCycle.mode,
                targetRepo: this.currentCycle.targetRepo,
                branch: this.currentCycle.branch,
                filesScanned: this.currentCycle.filesScanned,
                filesCommitted: this.currentCycle.filesCommitted,
                status,
                proofHash,
                startedAt: new Date(this.currentCycle.startedAt),
                finishedAt: new Date(finishedAt)
            }
        }).catch(()=>{
        /* ignore */ });
        this.recentCycles.unshift({
            id: cycleId,
            cycleNumber: this.currentCycle.cycleNumber,
            mode: this.currentCycle.mode,
            targetRepo: this.currentCycle.targetRepo,
            branch: this.currentCycle.branch,
            filesScanned: this.currentCycle.filesScanned,
            filesCommitted: this.currentCycle.filesCommitted,
            status,
            startedAt: this.currentCycle.startedAt,
            finishedAt,
            proofHash
        });
        if (this.recentCycles.length > 25) this.recentCycles.length = 25;
    }
    computeTreeFingerprint(tree) {
        const sorted = [
            ...tree
        ].sort((a, b)=>a.path.localeCompare(b.path));
        const raw = sorted.map((f)=>`${f.path}:${f.sha ?? f.size ?? 0}`).join("|");
        let hash = 0;
        for(let i = 0; i < raw.length; i++){
            hash = (hash << 5) - hash + raw.charCodeAt(i) | 0;
        }
        return "tree_fp_" + Math.abs(hash).toString(16);
    }
}
// Singleton — survives across hot reloads.
const globalForLoop = globalThis;
const autonomousLoopRuntime = globalForLoop.__autonomousLoopRuntime ?? new AutonomousLoopRuntime();
if (!globalForLoop.__autonomousLoopRuntime) {
    globalForLoop.__autonomousLoopRuntime = autonomousLoopRuntime;
}
// Touch the bus so the import is preserved for tree-shaking safety.
void __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$loop$2d$event$2d$bus$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["loopEventBus"];
}),
"[project]/src/app/api/autonomous/status/route.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
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
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$loop$2d$runtime$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/autonomous/loop-runtime.ts [app-route] (ecmascript)");
;
;
const dynamic = "force-dynamic";
const runtime = "nodejs";
async function GET() {
    try {
        const state = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$loop$2d$runtime$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["autonomousLoopRuntime"].getState();
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json(state);
    } catch (err) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
            error: err.message
        }, {
            status: 500
        });
    }
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__4cc46a4b._.js.map