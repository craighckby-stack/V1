(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/app/page.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>Home
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
const COLOR_MAP = {
    info: "#00ff00",
    success: "#00ff00",
    warn: "#ffff00",
    error: "#ff4444"
};
const PROMPT_COLOR = "#00ff00";
const DIM_COLOR = "#008800";
const USER_INPUT_COLOR = "#ffffff";
const METHOD_LABEL = {
    "todo-comment": "LLM",
    "empty-catch": "LLM",
    "any-usage": "LLM",
    "missing-return-type": "DET",
    "magic-number": "LLM",
    "non-null-assertion": "LLM"
};
function Home() {
    _s();
    const [status, setStatus] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [input, setInput] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])("");
    const [history, setHistory] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])([]);
    const [historyIdx, setHistoryIdx] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(-1);
    const [terminalLines, setTerminalLines] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])([
        {
            type: "system",
            text: "ARCHITECTURE HELPER PIPELINE v4.4 — SELF-ENHANCE MODE"
        },
        {
            type: "system",
            text: "(c) 2026 Z.ai Code — Autonomous Self-Modifying System"
        },
        {
            type: "system",
            text: ""
        },
        {
            type: "system",
            text: "INPUT: SYSTEM-DEFINED"
        },
        {
            type: "system",
            text: "  The system scans its own source with the TypeScript"
        },
        {
            type: "system",
            text: "  compiler API and derives its own task queue. No user"
        },
        {
            type: "system",
            text: "  goals. No prompts. The queue IS the input."
        },
        {
            type: "system",
            text: ""
        },
        {
            type: "system",
            text: "Verification: in-memory typecheck before every write"
        },
        {
            type: "system",
            text: "Proof: git push of current live state on each fix"
        },
        {
            type: "system",
            text: ""
        },
        {
            type: "system",
            text: "Type 'help' for commands. Type 'tasks' to see the queue."
        },
        {
            type: "system",
            text: ""
        }
    ]);
    // Config panel state
    const [configOpen, setConfigOpen] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [cfgToken, setCfgToken] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])("");
    const [cfgRepo, setCfgRepo] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])("");
    const [cfgPublic, setCfgPublic] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [cfgAutoCreate, setCfgAutoCreate] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    const [cfgShowToken, setCfgShowToken] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [cfgLoading, setCfgLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [cfgError, setCfgError] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [cfgStatusMsg, setCfgStatusMsg] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [cfgTarget, setCfgTarget] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [pushTarget, setPushTarget] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [cmdBusy, setCmdBusy] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const cfgTokenRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const logRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const inputRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    // Poll for status every 2 seconds
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "Home.useEffect": ()=>{
            let mounted = true;
            async function poll() {
                try {
                    const [statusRes, targetRes] = await Promise.all([
                        fetch("/api/self-enhance/status"),
                        fetch("/api/self-enhance/push-target")
                    ]);
                    if (statusRes.ok && mounted) setStatus(await statusRes.json());
                    if (targetRes.ok && mounted) setPushTarget(await targetRes.json());
                } catch  {
                // ignore
                }
            }
            poll();
            const interval = setInterval(poll, 2000);
            return ({
                "Home.useEffect": ()=>{
                    mounted = false;
                    clearInterval(interval);
                }
            })["Home.useEffect"];
        }
    }["Home.useEffect"], []);
    // Auto-scroll to bottom of log when NEW COMMAND OUTPUT appears (terminalLines),
    // not when server logs update (which would yank the view away from what the
    // user just typed).
    const terminalLineCount = terminalLines.length;
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "Home.useEffect": ()=>{
            if (logRef.current) {
                logRef.current.scrollTop = logRef.current.scrollHeight;
            }
        }
    }["Home.useEffect"], [
        terminalLineCount
    ]);
    // Focus input on click anywhere — but NOT while the config modal is open
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "Home.useEffect": ()=>{
            const handler = {
                "Home.useEffect.handler": ()=>{
                    if (!configOpen) inputRef.current?.focus();
                }
            }["Home.useEffect.handler"];
            document.addEventListener("click", handler);
            return ({
                "Home.useEffect": ()=>document.removeEventListener("click", handler)
            })["Home.useEffect"];
        }
    }["Home.useEffect"], [
        configOpen
    ]);
    // Escape closes the config modal
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "Home.useEffect": ()=>{
            if (!configOpen) return;
            const handler = {
                "Home.useEffect.handler": (e)=>{
                    if (e.key === "Escape") {
                        e.preventDefault();
                        closeConfig();
                    }
                }
            }["Home.useEffect.handler"];
            document.addEventListener("keydown", handler);
            return ({
                "Home.useEffect": ()=>document.removeEventListener("keydown", handler)
            })["Home.useEffect"];
        }
    }["Home.useEffect"], [
        configOpen
    ]);
    /** Append output lines to the terminal (used by the config flow). */ function emitOutput(lines) {
        setTerminalLines((prev)=>[
                ...prev,
                ...lines.map((l)=>({
                        type: "output",
                        text: l
                    }))
            ]);
    }
    async function openConfig() {
        setConfigOpen(true);
        setCfgError(null);
        setCfgStatusMsg(null);
        setCfgLoading(false);
        try {
            const res = await fetch("/api/self-enhance/push-target");
            if (res.ok) {
                const t = await res.json();
                setCfgTarget(t);
                if (t.configured && t.repo) setCfgRepo(t.repo);
            }
        } catch  {
        /* best-effort */ }
        setTimeout(()=>cfgTokenRef.current?.focus(), 50);
    }
    function closeConfig() {
        setConfigOpen(false);
        setCfgError(null);
        setCfgStatusMsg(null);
        setCfgToken("");
        setCfgShowToken(false);
        inputRef.current?.focus();
    }
    async function submitConfig() {
        setCfgLoading(true);
        setCfgError(null);
        setCfgStatusMsg(null);
        const token = cfgToken.trim();
        const repo = cfgRepo.trim();
        if (!token || !repo) {
            setCfgLoading(false);
            setCfgError("Both token and repo are required.");
            return;
        }
        try {
            const res = await fetch("/api/self-enhance/push-target", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    repo,
                    token,
                    isPublic: cfgPublic,
                    createIfMissing: cfgAutoCreate
                })
            });
            const data = await res.json();
            if (!data.ok) {
                setCfgLoading(false);
                setCfgError(data.error ?? "Configuration failed");
                return;
            }
            setCfgStatusMsg(data.created ? `Created github.com/${data.repo}. Pushing first proof...` : `Connected as ${data.login}. Pushing first proof...`);
            try {
                const pushRes = await fetch("/api/self-enhance/push", {
                    method: "POST"
                });
                const pushData = await pushRes.json();
                if (pushData.pushed) {
                    emitOutput([
                        `[CONFIG] Connected to github.com/${data.repo} as ${data.login}`,
                        `[CONFIG] First proof push: commit ${pushData.commitSha}`
                    ]);
                    const fresh = await fetch("/api/self-enhance/push-target");
                    if (fresh.ok) setCfgTarget(await fresh.json());
                    setCfgToken("");
                    setCfgShowToken(false);
                    setCfgStatusMsg(`Pushed commit ${pushData.commitSha}. Connected ✓`);
                } else {
                    setCfgError(`Connected, but initial push failed: ${pushData.error ?? "unknown"}`);
                }
            } catch  {
                setCfgError("Connected, but initial push failed (network error).");
            }
        } catch (e) {
            setCfgError(e.message);
        } finally{
            setCfgLoading(false);
        }
    }
    async function disconnectTarget() {
        setCfgLoading(true);
        setCfgError(null);
        setCfgStatusMsg(null);
        try {
            const res = await fetch("/api/self-enhance/push-target", {
                method: "DELETE"
            });
            const data = await res.json();
            if (data.ok) {
                setCfgTarget({
                    configured: false
                });
                setCfgRepo("");
                setCfgStatusMsg("Disconnected. The system will commit locally only.");
                emitOutput([
                    "[CONFIG] Push target disconnected."
                ]);
            } else {
                setCfgError(data.error ?? "Disconnect failed");
            }
        } catch (e) {
            setCfgError(e.message);
        } finally{
            setCfgLoading(false);
        }
    }
    async function executeCommand(cmd) {
        const trimmed = cmd.trim();
        if (!trimmed) return;
        setHistory((prev)=>[
                ...prev,
                trimmed
            ]);
        setHistoryIdx(-1);
        const lower = trimmed.toLowerCase();
        const command = lower.split(/\s+/)[0];
        switch(command){
            case "help":
                return [
                    "Available commands:",
                    "  start       — Start continuous self-enhancement loop",
                    "  stop        — Stop the loop",
                    "  trigger     — Run one cycle (scan queue + execute next tasks)",
                    "  tasks       — Show the system-defined task queue",
                    "  rescan      — Force re-scan of own source (re-define input)",
                    "  skip        — Veto the next pending task (user's only input power)",
                    "  status      — Show current status",
                    "  push        — Push current live state to GitHub",
                    "  config      — Open Git config panel",
                    "  logs        — Show recent logs",
                    "  clear       — Clear the terminal",
                    "  help        — Show this help",
                    "",
                    "INPUT IS SYSTEM-DEFINED:",
                    "  The system scans its own source code and generates its own",
                    "  task queue (TODOs, any-types, empty catches, magic numbers,",
                    "  missing return types, non-null assertions). You do not feed",
                    "  it goals. Your only power over the input is 'skip' (veto).",
                    ""
                ];
            case "start":
                {
                    try {
                        const res = await fetch("/api/self-enhance/start", {
                            method: "POST"
                        });
                        const data = await res.json();
                        return [
                            data.message || "Started"
                        ];
                    } catch (e) {
                        return [
                            `Error: ${e.message}`
                        ];
                    }
                }
            case "stop":
                {
                    try {
                        await fetch("/api/self-enhance/stop", {
                            method: "POST"
                        });
                        return [
                            "Self-enhancement loop stopped"
                        ];
                    } catch (e) {
                        return [
                            `Error: ${e.message}`
                        ];
                    }
                }
            case "config":
            case "cfg":
                {
                    openConfig();
                    return [
                        "Opening Git config panel... (or click [CONFIG] in the header)"
                    ];
                }
            case "trigger":
            case "run":
                {
                    setCmdBusy(true);
                    try {
                        const res = await fetch("/api/self-enhance/trigger", {
                            method: "POST"
                        });
                        const data = await res.json();
                        const lines = [
                            `Cycle complete: ${data.processed ?? 0} task(s) processed.`
                        ];
                        for (const r of data.results ?? []){
                            const tag = r.status === "applied" ? "✓ FIXED" : r.status === "deferred" ? "… DEFERRED (LLM 429)" : r.status === "failed" ? "✗ FAILED" : "· NO-OP";
                            lines.push(`  ${tag} [${r.kind}] ${r.filePath}:${r.line}${r.status === "applied" && r.pushed ? ` — pushed ${r.commitSha}` : ""}`);
                        }
                        return lines;
                    } catch (e) {
                        return [
                            `Error: ${e.message}`
                        ];
                    } finally{
                        setCmdBusy(false);
                    }
                }
            case "tasks":
            case "queue":
                {
                    setCmdBusy(true);
                    try {
                        const res = await fetch("/api/self-enhance/tasks?status=pending&limit=15");
                        const data = await res.json();
                        const q = data.queue;
                        const header = [
                            `QUEUE — pending=${q?.pending ?? 0} in-progress=${q?.in_progress ?? 0} done=${q?.done ?? 0} failed=${q?.failed ?? 0} skipped=${q?.skipped ?? 0}`,
                            `Last input scan: ${q?.lastScanAt ?? "not yet (runs when queue empties or via 'rescan')"}`,
                            ""
                        ];
                        const tasks = data.tasks ?? [];
                        if (tasks.length === 0) {
                            return [
                                ...header,
                                "  (no pending tasks — run 'rescan' to define new input)"
                            ];
                        }
                        return [
                            ...header,
                            ...tasks.map((t)=>`  [P${t.kind === "todo-comment" ? 1 : t.kind === "empty-catch" ? 2 : t.kind === "any-usage" ? 3 : t.kind === "missing-return-type" ? 4 : t.kind === "magic-number" ? 5 : 6}/${METHOD_LABEL[t.kind] ?? "?"}] ${t.kind} — ${t.filePath}:${t.line}`),
                            "",
                            `  (${tasks.length} shown${q && q.pending > tasks.length ? `, ${q.pending - tasks.length} more pending` : ""})`
                        ];
                    } catch (e) {
                        return [
                            `Error: ${e.message}`
                        ];
                    } finally{
                        setCmdBusy(false);
                    }
                }
            case "rescan":
                {
                    setCmdBusy(true);
                    try {
                        const res = await fetch("/api/self-enhance/rescan", {
                            method: "POST"
                        });
                        const data = await res.json();
                        return [
                            `Input re-defined by system scan:`,
                            `  files analyzed: ${data.filesAnalyzed}`,
                            `  findings:       ${data.findings}`,
                            `  new tasks:      ${data.newTasks}`,
                            `  already known:  ${data.alreadyQueued}`
                        ];
                    } catch (e) {
                        return [
                            `Error: ${e.message}`
                        ];
                    } finally{
                        setCmdBusy(false);
                    }
                }
            case "skip":
            case "veto":
                {
                    try {
                        const res = await fetch("/api/self-enhance/skip", {
                            method: "POST"
                        });
                        const data = await res.json();
                        if (data.skipped) {
                            return [
                                `Vetoed: [${data.kind}] ${data.filePath}:${data.line} — task marked skipped`
                            ];
                        }
                        return [
                            "Nothing to veto — queue is empty."
                        ];
                    } catch (e) {
                        return [
                            `Error: ${e.message}`
                        ];
                    }
                }
            case "status":
                {
                    const s = status;
                    if (!s) return [
                        "No status available yet"
                    ];
                    const q = s.queue;
                    return [
                        `Running:         ${s.running ? "YES" : "NO"}`,
                        `Input mode:      ${s.inputMode ?? "system-defined"} (system scans own source)`,
                        `Queue:           pending=${q?.pending ?? 0} in-progress=${q?.in_progress ?? 0} done=${q?.done ?? 0} failed=${q?.failed ?? 0} skipped=${q?.skipped ?? 0}`,
                        `Current task:    ${s.currentTask ? `[${s.currentTask.kind}] ${s.currentTask.filePath}:${s.currentTask.line}` : "idle"}`,
                        `Tasks generated: ${s.stats.tasksGenerated}`,
                        `Tasks done:      ${s.stats.tasksDone}`,
                        `Tasks failed:    ${s.stats.tasksFailed}`,
                        `Deferred (429):  ${s.stats.tasksDeferred}`,
                        `Pushes to git:   ${s.stats.totalPushed}`,
                        `Last fix:        ${s.stats.lastEnhancementAt ?? "never"}`
                    ];
                }
            case "push":
                {
                    try {
                        const res = await fetch("/api/self-enhance/push", {
                            method: "POST"
                        });
                        const data = await res.json();
                        if (data.pushed) return [
                            `Pushed to GitHub: commit ${data.commitSha}`
                        ];
                        if (data.committed) return [
                            `Committed ${data.commitSha} but push failed (no remote?)`
                        ];
                        return [
                            "No changes to push"
                        ];
                    } catch (e) {
                        return [
                            `Error: ${e.message}`
                        ];
                    }
                }
            case "logs":
                {
                    const logs = status?.logs ?? [];
                    if (logs.length === 0) return [
                        "No logs yet"
                    ];
                    return logs.slice(0, 20).map((l)=>`[${l.timestamp}] ${l.message}`);
                }
            case "clear":
            case "cls":
                {
                    setTerminalLines([]);
                    return [
                        ""
                    ];
                }
            case "exit":
            case "quit":
                return [
                    "Cannot exit — the system runs continuously. Use 'stop' to halt enhancement."
                ];
            case "about":
                return [
                    "Architecture Helper Pipeline v4.4",
                    "Self-enhancing autonomous system with SYSTEM-DEFINED INPUT.",
                    "",
                    "The system scans its own source (src/lib/pipeline/) with the",
                    "TypeScript compiler API and derives a task queue: TODOs, any",
                    "types, empty catches, magic numbers, missing return types,",
                    "non-null assertions. It executes tasks one by one — deterministic",
                    "fixes run even when the LLM API is rate-limited; LLM fixes are",
                    "focused single-issue prompts. Every fix is verified in memory",
                    "before it touches disk, then pushed to GitHub as proof.",
                    "",
                    "What you see on GitHub IS the current live state of the server."
                ];
            default:
                {
                    // Not a command — the system does not accept user goals.
                    return [
                        `'${trimmed}' is not a command.`,
                        "",
                        "INPUT IS SYSTEM-DEFINED: this system does not take goals from",
                        "users. It scans its own source and generates its own task queue.",
                        "",
                        "Type 'tasks' to see the queue, 'rescan' to re-define the input,",
                        "or 'skip' to veto the next task. Type 'help' for all commands."
                    ];
                }
        }
    }
    async function handleSubmit(e) {
        e.preventDefault();
        const cmd = input;
        setInput("");
        if (!cmd.trim()) return;
        // Echo the command to the terminal
        setTerminalLines((prev)=>[
                ...prev,
                {
                    type: "command",
                    text: cmd
                }
            ]);
        // Execute and show output
        const output = await executeCommand(cmd);
        if (output && output.length > 0) {
            setTerminalLines((prev)=>[
                    ...prev,
                    ...output.map((line)=>({
                            type: "output",
                            text: line
                        }))
                ]);
        }
        // Force a status poll
        setTimeout(async ()=>{
            try {
                const res = await fetch("/api/self-enhance/status");
                if (res.ok) setStatus(await res.json());
            } catch  {
            /* ignore */ }
        }, 500);
    }
    function handleKeyDown(e) {
        if (e.key === "ArrowUp") {
            e.preventDefault();
            if (history.length > 0) {
                const newIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
                setHistoryIdx(newIdx);
                setInput(history[newIdx]);
            }
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (historyIdx !== -1) {
                const newIdx = historyIdx + 1;
                if (newIdx >= history.length) {
                    setHistoryIdx(-1);
                    setInput("");
                } else {
                    setHistoryIdx(newIdx);
                    setInput(history[newIdx]);
                }
            }
        }
    }
    const logs = status?.logs ?? [];
    const s = status?.stats;
    const q = status?.queue;
    const running = status?.running ?? false;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        style: {
            position: "fixed",
            inset: 0,
            background: "#000",
            color: PROMPT_COLOR,
            fontFamily: "'Courier New', 'Lucida Console', monospace",
            fontSize: "14px",
            lineHeight: "1.4",
            padding: "8px",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column"
        },
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                style: {
                    borderBottom: `1px solid ${DIM_COLOR}`,
                    paddingBottom: "4px",
                    marginBottom: "8px",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px"
                },
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        style: {
                            display: "flex",
                            alignItems: "center",
                            flexWrap: "wrap",
                            minWidth: 0
                        },
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                style: {
                                    color: DIM_COLOR
                                },
                                children: "┌─ "
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 587,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                style: {
                                    color: PROMPT_COLOR,
                                    fontWeight: "bold"
                                },
                                children: "ARCHITECTURE HELPER PIPELINE v4.4 — SELF-ENHANCE MODE"
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 588,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                style: {
                                    color: DIM_COLOR,
                                    marginLeft: "16px"
                                },
                                children: "─┐"
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 591,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                style: {
                                    color: DIM_COLOR,
                                    marginLeft: "16px"
                                },
                                children: "│"
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 592,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                style: {
                                    marginLeft: "8px",
                                    color: running ? "#00ff00" : "#ff4444"
                                },
                                children: [
                                    "[",
                                    running ? "ENHANCING" : "IDLE",
                                    "]"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 593,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                style: {
                                    color: DIM_COLOR,
                                    marginLeft: "16px"
                                },
                                children: "INPUT: SYSTEM-DEFINED"
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 596,
                                columnNumber: 11
                            }, this),
                            q && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                style: {
                                    color: DIM_COLOR,
                                    marginLeft: "16px"
                                },
                                children: [
                                    "queue=",
                                    q.pending + q.in_progress,
                                    " done=",
                                    q.done,
                                    " failed=",
                                    q.failed
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 598,
                                columnNumber: 13
                            }, this),
                            s && s.totalPushed > 0 && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                style: {
                                    color: DIM_COLOR,
                                    marginLeft: "16px"
                                },
                                children: [
                                    "pushed=",
                                    s.totalPushed
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 603,
                                columnNumber: 13
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 586,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        style: {
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            flexShrink: 0
                        },
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                style: {
                                    color: pushTarget?.configured ? PROMPT_COLOR : DIM_COLOR
                                },
                                children: [
                                    "[GIT: ",
                                    pushTarget?.configured ? "ON" : "OFF",
                                    "]"
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 607,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                type: "button",
                                onClick: (e)=>{
                                    e.stopPropagation();
                                    openConfig();
                                },
                                "aria-label": "Open Git push configuration",
                                style: {
                                    background: "#000",
                                    border: `1px solid ${DIM_COLOR}`,
                                    color: PROMPT_COLOR,
                                    fontFamily: "inherit",
                                    fontSize: "inherit",
                                    padding: "2px 8px",
                                    cursor: "pointer"
                                },
                                children: "[CONFIG]"
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 610,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 606,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 574,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                ref: logRef,
                style: {
                    flex: 1,
                    overflowY: "auto",
                    paddingRight: "4px"
                },
                children: [
                    logs.map((log, idx)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                color: COLOR_MAP[log.type],
                                whiteSpace: "pre-wrap"
                            },
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    style: {
                                        color: DIM_COLOR
                                    },
                                    children: [
                                        "[",
                                        log.timestamp,
                                        "]"
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 644,
                                    columnNumber: 13
                                }, this),
                                " ",
                                log.message
                            ]
                        }, `log-${idx}`, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 643,
                            columnNumber: 11
                        }, this)),
                    terminalLines.map((line, idx)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                color: line.type === "command" ? "#ffffff" : line.type === "output" ? "#00ff00" : "#008800",
                                whiteSpace: "pre-wrap"
                            },
                            children: line.type === "command" ? `> ${line.text}` : line.text || "\u00a0"
                        }, `term-${idx}`, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 651,
                            columnNumber: 11
                        }, this)),
                    cmdBusy && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        style: {
                            color: DIM_COLOR
                        },
                        children: "working..."
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 667,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 633,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                style: {
                    borderTop: `1px solid ${DIM_COLOR}`,
                    paddingTop: "4px",
                    marginTop: "4px",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center"
                },
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("form", {
                    onSubmit: handleSubmit,
                    style: {
                        flex: 1,
                        display: "flex"
                    },
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            style: {
                                color: PROMPT_COLOR,
                                marginRight: "8px"
                            },
                            children: ">"
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 683,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("input", {
                            ref: inputRef,
                            type: "text",
                            value: input,
                            onChange: (e)=>setInput(e.target.value),
                            onKeyDown: handleKeyDown,
                            autoFocus: true,
                            autoComplete: "off",
                            spellCheck: false,
                            "aria-label": "Terminal command input",
                            style: {
                                flex: 1,
                                background: "transparent",
                                border: "none",
                                outline: "none",
                                color: USER_INPUT_COLOR,
                                fontFamily: "inherit",
                                fontSize: "inherit",
                                caretColor: PROMPT_COLOR
                            }
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 684,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 682,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 672,
                columnNumber: 7
            }, this),
            configOpen && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                onClick: closeConfig,
                style: {
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0, 0, 0, 0.75)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 100,
                    padding: "16px"
                },
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    role: "dialog",
                    "aria-modal": "true",
                    "aria-labelledby": "cfg-title",
                    onClick: (e)=>e.stopPropagation(),
                    style: {
                        background: "#000",
                        border: `1px solid ${PROMPT_COLOR}`,
                        color: PROMPT_COLOR,
                        fontFamily: "inherit",
                        fontSize: "14px",
                        padding: "16px",
                        width: "min(560px, 92vw)",
                        maxHeight: "90vh",
                        overflowY: "auto",
                        boxShadow: "0 0 24px rgba(0, 255, 0, 0.15)"
                    },
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            id: "cfg-title",
                            style: {
                                fontWeight: "bold",
                                borderBottom: `1px solid ${DIM_COLOR}`,
                                paddingBottom: "8px",
                                marginBottom: "12px"
                            },
                            children: "┌─ GIT CONFIG ──────────────────────┐"
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 741,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                marginBottom: "12px"
                            },
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    style: {
                                        color: DIM_COLOR,
                                        marginBottom: "4px"
                                    },
                                    children: "GitHub Token"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 747,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    style: {
                                        display: "flex",
                                        gap: "4px"
                                    },
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("input", {
                                            ref: cfgTokenRef,
                                            type: cfgShowToken ? "text" : "password",
                                            value: cfgToken,
                                            onChange: (e)=>setCfgToken(e.target.value),
                                            placeholder: "ghp_... (paste your GitHub PAT)",
                                            autoComplete: "off",
                                            spellCheck: false,
                                            style: {
                                                flex: 1,
                                                background: "#000",
                                                border: `1px solid ${DIM_COLOR}`,
                                                color: USER_INPUT_COLOR,
                                                fontFamily: "inherit",
                                                fontSize: "inherit",
                                                padding: "4px 6px",
                                                outline: "none"
                                            }
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 749,
                                            columnNumber: 17
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                            type: "button",
                                            onClick: ()=>setCfgShowToken((v)=>!v),
                                            style: {
                                                background: "#000",
                                                border: `1px solid ${DIM_COLOR}`,
                                                color: PROMPT_COLOR,
                                                fontFamily: "inherit",
                                                fontSize: "inherit",
                                                padding: "4px 10px",
                                                cursor: "pointer"
                                            },
                                            children: cfgShowToken ? "[HIDE]" : "[SHOW]"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 759,
                                            columnNumber: 17
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 748,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 746,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                marginBottom: "12px"
                            },
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    style: {
                                        color: DIM_COLOR,
                                        marginBottom: "4px"
                                    },
                                    children: "Repository (owner/name)"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 771,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("input", {
                                    type: "text",
                                    value: cfgRepo,
                                    onChange: (e)=>setCfgRepo(e.target.value),
                                    placeholder: "yourname/self-enhance",
                                    autoComplete: "off",
                                    spellCheck: false,
                                    style: {
                                        flex: 1,
                                        width: "100%",
                                        background: "#000",
                                        border: `1px solid ${DIM_COLOR}`,
                                        color: USER_INPUT_COLOR,
                                        fontFamily: "inherit",
                                        fontSize: "inherit",
                                        padding: "4px 6px",
                                        outline: "none"
                                    }
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 772,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 770,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("label", {
                            style: {
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                cursor: "pointer",
                                marginBottom: "8px",
                                color: PROMPT_COLOR,
                                userSelect: "none"
                            },
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("input", {
                                    type: "checkbox",
                                    checked: cfgPublic,
                                    onChange: (e)=>setCfgPublic(e.target.checked),
                                    style: {
                                        accentColor: PROMPT_COLOR
                                    }
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 785,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    children: "Public repo (unchecked = private)"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 786,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 784,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("label", {
                            style: {
                                display: "flex",
                                alignItems: "flex-start",
                                gap: "6px",
                                cursor: "pointer",
                                marginBottom: "12px",
                                color: PROMPT_COLOR,
                                userSelect: "none"
                            },
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("input", {
                                    type: "checkbox",
                                    checked: cfgAutoCreate,
                                    onChange: (e)=>setCfgAutoCreate(e.target.checked),
                                    style: {
                                        accentColor: PROMPT_COLOR,
                                        marginTop: "2px",
                                        flexShrink: 0
                                    }
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 789,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    children: [
                                        "Auto-create repo if missing",
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            style: {
                                                color: DIM_COLOR,
                                                display: "block",
                                                fontSize: "12px",
                                                marginTop: "2px"
                                            },
                                            children: "Needs a classic PAT with repo scope — fine-grained PATs cannot create repos."
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 792,
                                            columnNumber: 17
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 790,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 788,
                            columnNumber: 13
                        }, this),
                        cfgTarget?.configured && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                borderTop: `1px solid ${DIM_COLOR}`,
                                marginTop: "12px",
                                paddingTop: "8px",
                                marginBottom: "12px"
                            },
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    style: {
                                        color: DIM_COLOR,
                                        marginBottom: "4px"
                                    },
                                    children: "CURRENT TARGET"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 801,
                                    columnNumber: 17
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    style: {
                                        wordBreak: "break-all"
                                    },
                                    children: [
                                        "github.com/",
                                        cfgTarget.repo,
                                        " (branch ",
                                        cfgTarget.branch,
                                        cfgTarget.createdRepo ? ", auto-created" : "",
                                        ")"
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 802,
                                    columnNumber: 17
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    style: {
                                        color: DIM_COLOR
                                    },
                                    children: [
                                        "Last push: ",
                                        cfgTarget.lastPushSha ? `commit ${cfgTarget.lastPushSha}` : "never"
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 805,
                                    columnNumber: 17
                                }, this),
                                cfgTarget.lastPushError && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    style: {
                                        color: "#ff4444",
                                        marginTop: "4px",
                                        whiteSpace: "pre-wrap",
                                        wordBreak: "break-word"
                                    },
                                    children: [
                                        "Last error: ",
                                        cfgTarget.lastPushError
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 809,
                                    columnNumber: 19
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 800,
                            columnNumber: 15
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                display: "flex",
                                gap: "8px",
                                flexWrap: "wrap"
                            },
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                    type: "button",
                                    onClick: submitConfig,
                                    disabled: cfgLoading,
                                    style: {
                                        background: "#000",
                                        border: `1px solid ${DIM_COLOR}`,
                                        color: PROMPT_COLOR,
                                        fontFamily: "inherit",
                                        fontSize: "inherit",
                                        padding: "4px 10px",
                                        cursor: cfgLoading ? "wait" : "pointer",
                                        opacity: cfgLoading ? 0.5 : 1
                                    },
                                    children: "[ CONNECT & PUSH ]"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 818,
                                    columnNumber: 15
                                }, this),
                                cfgTarget?.configured && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                    type: "button",
                                    onClick: disconnectTarget,
                                    disabled: cfgLoading,
                                    style: {
                                        background: "#000",
                                        border: `1px solid ${DIM_COLOR}`,
                                        color: PROMPT_COLOR,
                                        fontFamily: "inherit",
                                        fontSize: "inherit",
                                        padding: "4px 10px",
                                        cursor: cfgLoading ? "wait" : "pointer",
                                        opacity: cfgLoading ? 0.5 : 1
                                    },
                                    children: "[ DISCONNECT ]"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 827,
                                    columnNumber: 17
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                    type: "button",
                                    onClick: closeConfig,
                                    style: {
                                        background: "#000",
                                        border: `1px solid ${DIM_COLOR}`,
                                        color: PROMPT_COLOR,
                                        fontFamily: "inherit",
                                        fontSize: "inherit",
                                        padding: "4px 10px",
                                        cursor: "pointer"
                                    },
                                    children: "[ CLOSE ]"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 836,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 817,
                            columnNumber: 13
                        }, this),
                        cfgStatusMsg && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                color: PROMPT_COLOR,
                                marginTop: "10px",
                                whiteSpace: "pre-wrap"
                            },
                            children: cfgStatusMsg
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 843,
                            columnNumber: 15
                        }, this),
                        cfgError && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                color: "#ff4444",
                                marginTop: "10px",
                                whiteSpace: "pre-wrap"
                            },
                            children: cfgError
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 846,
                            columnNumber: 15
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                color: DIM_COLOR,
                                marginTop: "12px",
                                fontSize: "12px",
                                lineHeight: 1.3
                            },
                            children: "Token verified with GitHub. Token stored locally only — never in git config, URLs, or the pushed repo. Need a token? github.com/settings/tokens (classic PAT, repo scope)."
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 849,
                            columnNumber: 13
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 723,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 710,
                columnNumber: 9
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/app/page.tsx",
        lineNumber: 558,
        columnNumber: 5
    }, this);
}
_s(Home, "TSq9I2RPsNmCd0ZkGWWRTkEY6yY=");
_c = Home;
var _c;
__turbopack_context__.k.register(_c, "Home");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# sourceMappingURL=src_app_page_tsx_b4090435._.js.map