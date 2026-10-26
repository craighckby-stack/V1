module.exports = [
"[project]/src/app/page.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>Home
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react.js [app-ssr] (ecmascript)");
"use client";
;
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
function Home() {
    const [status, setStatus] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])(null);
    const [input, setInput] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])("");
    const [history, setHistory] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])([]);
    const [historyIdx, setHistoryIdx] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])(-1);
    const [terminalLines, setTerminalLines] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])([
        {
            type: "system",
            text: "ARCHITECTURE HELPER PIPELINE v4.3 — SELF-ENHANCE MODE"
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
            text: "Target: src/lib/pipeline/ (self-enhancement)"
        },
        {
            type: "system",
            text: "Mode: continuous autonomous refactoring"
        },
        {
            type: "system",
            text: "Verification: tsc --noEmit before every write"
        },
        {
            type: "system",
            text: "Proof: git push of current live state on each enhancement"
        },
        {
            type: "system",
            text: ""
        },
        {
            type: "system",
            text: "Type 'help' for commands, or type a goal in plain English."
        },
        {
            type: "system",
            text: "Example: 'add a search input that filters the file list'"
        },
        {
            type: "system",
            text: ""
        }
    ]);
    const [pendingPlan, setPendingPlan] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])(null);
    const [taskLoading, setTaskLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"])(false);
    const logRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useRef"])(null);
    const inputRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useRef"])(null);
    // Poll for status every 2 seconds
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useEffect"])(()=>{
        let mounted = true;
        async function poll() {
            try {
                const res = await fetch("/api/self-enhance/status");
                if (res.ok) {
                    const data = await res.json();
                    if (mounted) setStatus(data);
                }
            } catch  {
            // ignore
            }
        }
        poll();
        const interval = setInterval(poll, 2000);
        return ()=>{
            mounted = false;
            clearInterval(interval);
        };
    }, []);
    // Auto-scroll to bottom of log
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useEffect"])(()=>{
        if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [
        status?.logs
    ]);
    // Focus input on click anywhere
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useEffect"])(()=>{
        const handler = ()=>inputRef.current?.focus();
        document.addEventListener("click", handler);
        return ()=>document.removeEventListener("click", handler);
    }, []);
    async function executeCommand(cmd) {
        const trimmed = cmd.trim();
        if (!trimmed) return;
        setHistory((prev)=>[
                ...prev,
                trimmed
            ]);
        setHistoryIdx(-1);
        const lower = trimmed.toLowerCase();
        const parts = lower.split(/\s+/);
        const command = parts[0];
        switch(command){
            case "help":
                return [
                    "Available commands:",
                    "  start       — Start continuous self-enhancement loop",
                    "  stop        — Stop the loop",
                    "  trigger     — Run one enhancement cycle",
                    "  status      — Show current status",
                    "  push        — Push current live state to GitHub",
                    "  config      — Open Git config panel",
                    "  logs        — Show recent logs",
                    "  files       — List files being enhanced",
                    "  clear       — Clear the terminal",
                    "  help        — Show this help",
                    "",
                    "CHAT MODE:",
                    "  Type anything that's not a command and the system will",
                    "  analyze the codebase, propose a plan, and ask you to approve.",
                    "  Example: 'add a search input that filters the file list'",
                    "  Then type 'yes' to apply, or anything else to cancel.",
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
            case "trigger":
            case "run":
                {
                    return [
                        "Running one cycle... (check logs for progress)"
                    ];
                }
            case "status":
                {
                    const s = status;
                    if (!s) return [
                        "No status available yet"
                    ];
                    return [
                        `Running:       ${s.running ? "YES" : "NO"}`,
                        `Files scanned: ${s.stats.totalScanned}`,
                        `Files enhanced: ${s.stats.totalEnhanced}`,
                        `Files reverted: ${s.stats.totalReverted}`,
                        `Pushes to git:  ${s.stats.totalPushed}`,
                        `Last enhanced:  ${s.stats.lastEnhancementAt ?? "never"}`,
                        `Current file:   ${s.currentFile ?? "idle"}`
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
            case "files":
            case "list":
                {
                    return [
                        "Self-enhancement targets (src/lib/pipeline/):",
                        "  core/       — unified-pipeline, ast-diff-gate, siphon, binaryShield",
                        "  emg/        — sanitizer, debate, halt, emg-rag",
                        "  engines/    — clean-room-runtime",
                        "  postmortem/ — postmortem-store",
                        "",
                        "Protected (not modified):",
                        "  autonomous/ — loop-runtime, self-enhance-loop, loop-event-bus",
                        "  llm/         — agent-llm, debate-llm"
                    ];
                }
            case "clear":
            case "cls":
                setStatus(null);
                return [
                    ""
                ];
            case "exit":
            case "quit":
                return [
                    "Cannot exit — the system runs continuously. Use 'stop' to halt enhancement."
                ];
            case "yes":
            case "y":
            case "approve":
                {
                    if (!pendingPlan) {
                        return [
                            "No pending plan to approve. Type a goal first."
                        ];
                    }
                    setTaskLoading(true);
                    try {
                        const res = await fetch("/api/self-enhance/chat-task/apply", {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                ...pendingPlan,
                                ok: true
                            })
                        });
                        const data = await res.json();
                        setPendingPlan(null);
                        if (data.ok) {
                            const lines = [
                                "APPLIED:",
                                ...data.results.map((r)=>`  ${r.applied ? "✓" : "✗"} ${r.path} — ${r.reason}`)
                            ];
                            if (data.pushed) {
                                lines.push(`Pushed to GitHub: commit ${data.commitSha}`);
                            } else if (data.error) {
                                lines.push(`⚠ ${data.error}`);
                            }
                            return lines;
                        }
                        return [
                            `Failed: ${data.error}`
                        ];
                    } catch (e) {
                        setPendingPlan(null);
                        return [
                            `Error applying plan: ${e.message}`
                        ];
                    } finally{
                        setTaskLoading(false);
                    }
                }
            case "no":
            case "n":
            case "cancel":
                {
                    if (pendingPlan) {
                        setPendingPlan(null);
                        return [
                            "Plan cancelled."
                        ];
                    }
                    return [
                        "Nothing to cancel."
                    ];
                }
            case "about":
                return [
                    "Architecture Helper Pipeline v4.3",
                    "Self-enhancing autonomous refactoring system",
                    "The system modifies its own source code in src/lib/pipeline/,",
                    "verifies with tsc --noEmit, and pushes to GitHub as proof.",
                    "What you see on GitHub IS the current live state of the server.",
                    "",
                    "CHAT MODE: type a goal in plain English to direct the system."
                ];
            default:
                {
                    // Not a command — treat as a chat task goal
                    if (taskLoading) return [
                        "Task in progress, please wait..."
                    ];
                    setTaskLoading(true);
                    try {
                        const res = await fetch("/api/self-enhance/chat-task/propose", {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                goal: trimmed
                            })
                        });
                        const plan = await res.json();
                        if (!plan.ok) {
                            return [
                                `Could not plan: ${plan.error ?? "unknown error"}`
                            ];
                        }
                        // Store the plan for "yes" approval
                        setPendingPlan({
                            userGoal: plan.userGoal,
                            understanding: plan.understanding,
                            files: plan.files,
                            summary: plan.summary
                        });
                        const lines = [
                            `UNDERSTANDING: ${plan.understanding}`,
                            "",
                            "PROPOSED CHANGES:",
                            ...plan.files.map((f)=>`  ${f.action.toUpperCase()}: ${f.path} — ${f.reason}`),
                            "",
                            `SUMMARY: ${plan.summary}`,
                            "",
                            "Type 'yes' to apply and push, or 'no' to cancel."
                        ];
                        return lines;
                    } catch (e) {
                        return [
                            `Error: ${e.message}`
                        ];
                    } finally{
                        setTaskLoading(false);
                    }
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
    const running = status?.running ?? false;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
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
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                style: {
                    borderBottom: `1px solid ${DIM_COLOR}`,
                    paddingBottom: "4px",
                    marginBottom: "8px",
                    flexShrink: 0
                },
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        style: {
                            color: DIM_COLOR
                        },
                        children: "┌─ "
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 400,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        style: {
                            color: PROMPT_COLOR,
                            fontWeight: "bold"
                        },
                        children: "ARCHITECTURE HELPER PIPELINE v4.3 — SELF-ENHANCE MODE"
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 401,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        style: {
                            color: DIM_COLOR,
                            marginLeft: "16px"
                        },
                        children: "─┐"
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 404,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        style: {
                            color: DIM_COLOR,
                            marginLeft: "16px"
                        },
                        children: "│"
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 405,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
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
                        lineNumber: 406,
                        columnNumber: 9
                    }, this),
                    s && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        style: {
                            color: DIM_COLOR,
                            marginLeft: "16px"
                        },
                        children: [
                            "scanned=",
                            s.totalScanned,
                            " enhanced=",
                            s.totalEnhanced,
                            " reverted=",
                            s.totalReverted,
                            " pushed=",
                            s.totalPushed
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 410,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        style: {
                            color: DIM_COLOR,
                            marginLeft: "16px"
                        },
                        children: "│"
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 414,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 399,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                ref: logRef,
                style: {
                    flex: 1,
                    overflowY: "auto",
                    paddingRight: "4px"
                },
                children: [
                    terminalLines.map((line, idx)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                color: line.type === "command" ? "#ffffff" : line.type === "output" ? "#00ff00" : "#008800",
                                whiteSpace: "pre-wrap"
                            },
                            children: line.type === "command" ? `> ${line.text}` : line.text || "\u00a0"
                        }, `term-${idx}`, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 428,
                            columnNumber: 11
                        }, this)),
                    logs.map((log, idx)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            style: {
                                color: COLOR_MAP[log.type],
                                whiteSpace: "pre-wrap"
                            },
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
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
                                    lineNumber: 447,
                                    columnNumber: 13
                                }, this),
                                " ",
                                log.message
                            ]
                        }, `log-${idx}`, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 446,
                            columnNumber: 11
                        }, this))
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 418,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                style: {
                    borderTop: `1px solid ${DIM_COLOR}`,
                    paddingTop: "4px",
                    marginTop: "4px",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center"
                },
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("form", {
                    onSubmit: handleSubmit,
                    style: {
                        flex: 1,
                        display: "flex"
                    },
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            style: {
                                color: PROMPT_COLOR,
                                marginRight: "8px"
                            },
                            children: ">"
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 465,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("input", {
                            ref: inputRef,
                            type: "text",
                            value: input,
                            onChange: (e)=>setInput(e.target.value),
                            onKeyDown: handleKeyDown,
                            autoFocus: true,
                            autoComplete: "off",
                            spellCheck: false,
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
                            lineNumber: 466,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 464,
                    columnNumber: 9
                }, this)
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 454,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/app/page.tsx",
        lineNumber: 383,
        columnNumber: 5
    }, this);
}
}),
];

//# sourceMappingURL=src_app_page_tsx_a7111f3e._.js.map