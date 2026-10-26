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
"[externals]/child_process [external] (child_process, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("child_process", () => require("child_process"));

module.exports = mod;
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
"[project]/src/lib/pipeline/autonomous/push-target.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "clearPushTarget",
    ()=>clearPushTarget,
    "getPushTargetPublic",
    ()=>getPushTargetPublic,
    "pushCurrentState",
    ()=>pushCurrentState,
    "setPushTarget",
    ()=>setPushTarget
]);
/**
 * Git Push Target — persistent, authenticated GitHub push.
 *
 * The loop/chat-task commits evolving source and pushes it to GitHub as proof.
 * This module owns:
 *   - Persistent push target config (repo + token) in the DB (survives restarts)
 *   - Authenticated git push WITHOUT persisting the token in git config
 *     (auth is injected per-push via GIT_CONFIG_* env vars)
 *
 * Security: the token is stored in the local SQLite DB (untracked) and is
 * NEVER returned to the client. All error messages are scrubbed of the token.
 */ var __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/child_process [external] (child_process, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-route] (ecmascript)");
;
;
const PROJECT_ROOT = "/home/z/my-project";
const SINGLETON_ID = "singleton";
/** Serialize pushes — the loop and manual pushes share one repo. */ let pushInProgress = false;
/** GitHub REST helper — authenticated requests use their own (high) quota. */ async function ghFetch(path, token, init) {
    return fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "self-enhance-loop",
            "X-GitHub-Api-Version": "2022-11-28",
            ...init?.headers ?? {}
        }
    });
}
/** Remove the raw token from any string before logging/returning it. */ function scrub(text, token) {
    if (!text || !token) return text ?? "";
    return text.split(token).join("***");
}
function validRepoFormat(repo) {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}
function validTokenFormat(token) {
    return token.length >= 20 && !/\s/.test(token);
}
/** Read the stored target (with token) — server-side only. */ async function getStoredTarget() {
    const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].gitPushTarget.findUnique({
        where: {
            id: SINGLETON_ID
        }
    });
    if (!row) return null;
    return {
        repo: row.repo,
        token: row.token,
        branch: row.branch
    };
}
async function getPushTargetPublic() {
    const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].gitPushTarget.findUnique({
        where: {
            id: SINGLETON_ID
        }
    });
    if (!row) return {
        configured: false
    };
    return {
        configured: true,
        repo: row.repo,
        branch: row.branch,
        createdRepo: row.createdRepo,
        lastPushAt: row.lastPushAt?.toISOString() ?? null,
        lastPushSha: row.lastPushSha,
        lastPushError: row.lastPushError
    };
}
async function setPushTarget(opts) {
    const repo = opts.repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "");
    const token = opts.token.trim();
    if (!validRepoFormat(repo)) {
        throw new Error(`Invalid repo format "${repo}" — expected owner/name`);
    }
    if (!validTokenFormat(token)) {
        throw new Error("Invalid token — expected a GitHub PAT (ghp_... or github_pat_..., 20+ chars)");
    }
    // 1. Verify the token
    const userRes = await ghFetch("/user", token);
    if (userRes.status === 401) {
        throw new Error("Token rejected by GitHub (401) — check it's a valid, non-expired PAT");
    }
    if (!userRes.ok) {
        throw new Error(`GitHub token check failed (HTTP ${userRes.status})`);
    }
    const user = await userRes.json();
    const login = user.login;
    // 2. Verify the repo exists (or create it)
    let created = false;
    const repoRes = await ghFetch(`/repos/${repo}`, token);
    if (repoRes.status === 404) {
        const createIfMissing = opts.createIfMissing ?? true;
        if (!createIfMissing) {
            throw new Error(`Repo ${repo} not found. Create it manually on github.com, or enable auto-create.`);
        }
        const [owner, name] = repo.split("/");
        let createRes;
        if (owner === login) {
            createRes = await ghFetch("/user/repos", token, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    name,
                    private: !(opts.isPublic ?? false),
                    description: "Live state of a self-enhancing code pipeline (auto-pushed)",
                    auto_init: false
                })
            });
        } else {
            createRes = await ghFetch(`/orgs/${owner}/repos`, token, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    name,
                    private: !(opts.isPublic ?? false),
                    description: "Live state of a self-enhancing code pipeline (auto-pushed)",
                    auto_init: false
                })
            });
        }
        if (createRes.status === 201) {
            created = true;
        } else if (createRes.status === 403) {
            throw new Error("GitHub refused to create the repo (403). Fine-grained PATs CANNOT create repos — use a classic PAT with 'repo' scope, or create the repo manually first.");
        } else if (createRes.status === 404) {
            throw new Error(`Owner '${owner}' not found (404). For org repos, the token must administer that org.`);
        } else if (createRes.status === 422) {
            throw new Error(`Repo ${repo} exists but is not accessible with this token (422).`);
        } else {
            const body = await createRes.json().catch(()=>({}));
            throw new Error(`Failed to create repo ${repo}: ${body.message ?? `HTTP ${createRes.status}`}`);
        }
    } else if (!repoRes.ok) {
        const body = await repoRes.json().catch(()=>({}));
        throw new Error(`Repo check failed for ${repo}: ${body.message ?? `HTTP ${repoRes.status}`}`);
    }
    // 3. Persist config
    await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].gitPushTarget.upsert({
        where: {
            id: SINGLETON_ID
        },
        update: {
            repo,
            token,
            branch: "main",
            createdRepo: created,
            lastPushError: null
        },
        create: {
            id: SINGLETON_ID,
            repo,
            token,
            branch: "main",
            createdRepo: created
        }
    });
    // 4. Point `origin` at the tokenless URL
    const remoteUrl = `https://github.com/${repo}.git`;
    try {
        const existing = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git remote", {
            cwd: PROJECT_ROOT,
            encoding: "utf-8",
            timeout: 5000
        }).trim().split("\n").map((s)=>s.trim()).filter(Boolean);
        if (existing.includes("origin")) {
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])(`git remote set-url origin ${remoteUrl}`, {
                cwd: PROJECT_ROOT,
                timeout: 5000
            });
        } else {
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])(`git remote add origin ${remoteUrl}`, {
                cwd: PROJECT_ROOT,
                timeout: 5000
            });
        }
    } catch (err) {
        throw new Error(`Failed to set git remote: ${err.message}`);
    }
    return {
        repo,
        login,
        created
    };
}
async function clearPushTarget() {
    await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].gitPushTarget.deleteMany({
        where: {
            id: SINGLETON_ID
        }
    });
    try {
        (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git remote remove origin", {
            cwd: PROJECT_ROOT,
            timeout: 5000,
            stdio: "pipe"
        });
    } catch  {
    /* no origin to remove */ }
    return {
        cleared: true
    };
}
async function pushCurrentState(opts) {
    const target = await getStoredTarget();
    if (!target) {
        return {
            pushed: false,
            error: "No push target configured"
        };
    }
    if (pushInProgress) {
        return {
            pushed: false,
            error: "A push is already in progress",
            repo: target.repo
        };
    }
    pushInProgress = true;
    const record = async (patch)=>{
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["db"].gitPushTarget.update({
            where: {
                id: SINGLETON_ID
            },
            data: {
                lastPushAt: new Date(),
                ...patch.lastPushSha !== undefined ? {
                    lastPushSha: patch.lastPushSha
                } : {},
                ...patch.lastPushError !== undefined ? {
                    lastPushError: patch.lastPushError
                } : {}
            }
        }).catch(()=>{});
    };
    try {
        // 0. Self-heal: ensure `origin` points at the configured repo
        const remoteUrl = `https://github.com/${target.repo}.git`;
        try {
            const current = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git remote get-url origin", {
                cwd: PROJECT_ROOT,
                encoding: "utf-8",
                timeout: 5000,
                stdio: "pipe"
            }).trim();
            if (current !== remoteUrl) throw new Error("mismatch");
        } catch  {
            try {
                (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git remote remove origin", {
                    cwd: PROJECT_ROOT,
                    timeout: 5000,
                    stdio: "pipe"
                });
            } catch  {
            /* no origin to remove */ }
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])(`git remote add origin ${remoteUrl}`, {
                cwd: PROJECT_ROOT,
                timeout: 5000
            });
        }
        // 1. Commit if there are changes
        let commitSha;
        const status = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git status --porcelain", {
            cwd: PROJECT_ROOT,
            encoding: "utf-8",
            timeout: 5000
        });
        if (status.trim()) {
            const message = (opts?.message ?? "Self-enhancement: current live state").replace(/"/g, '\\"').slice(0, 300);
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git add -A", {
                cwd: PROJECT_ROOT,
                timeout: 10000
            });
            // Use a temp file for the commit message to handle multi-line safely
            const msgFile = "/tmp/commit-msg.txt";
            const { writeFileSync, unlinkSync } = await __turbopack_context__.A("[externals]/fs [external] (fs, cjs, async loader)");
            writeFileSync(msgFile, opts?.message ?? "Self-enhancement: current live state", "utf-8");
            try {
                (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])(`git commit -F ${msgFile}`, {
                    cwd: PROJECT_ROOT,
                    timeout: 10000,
                    stdio: "pipe"
                });
            } finally{
                try {
                    unlinkSync(msgFile);
                } catch  {}
            }
            commitSha = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git rev-parse HEAD", {
                cwd: PROJECT_ROOT,
                encoding: "utf-8",
                timeout: 5000
            }).trim().slice(0, 7);
        }
        // 2. Push with auth injected via env
        const auth = `Authorization: Basic ${Buffer.from(`x-access-token:${target.token}`).toString("base64")}`;
        const refspec = `HEAD:refs/heads/${target.branch}`;
        const forceArg = opts?.force ? " --force" : "";
        const pushEnv = {
            ...process.env,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: auth
        };
        try {
            (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])(`git push origin ${refspec}${forceArg}`, {
                cwd: PROJECT_ROOT,
                timeout: 60000,
                stdio: "pipe",
                env: pushEnv
            });
        } catch (err) {
            const stderr = scrub(String(err.stderr ?? err.message ?? ""), target.token);
            let hint = "";
            if (/non-fast-forward|fetch first|rejected/.test(stderr)) {
                hint = " (remote has diverged — force-push required)";
            } else if (/could not read Username|Authentication failed|403/.test(stderr)) {
                hint = " (GitHub rejected the credentials — token may be invalid/revoked)";
            }
            await record({
                lastPushError: `git push failed: ${stderr.slice(0, 300)}${hint}`
            });
            return {
                pushed: false,
                commitSha,
                hadChanges: Boolean(commitSha),
                repo: target.repo,
                error: `${stderr.slice(0, 300)}${hint}`
            };
        }
        // 3. Success
        const headSha = commitSha ?? (0, __TURBOPACK__imported__module__$5b$externals$5d2f$child_process__$5b$external$5d$__$28$child_process$2c$__cjs$29$__["execSync"])("git rev-parse HEAD", {
            cwd: PROJECT_ROOT,
            encoding: "utf-8",
            timeout: 5000
        }).trim().slice(0, 7);
        await record({
            lastPushSha: headSha,
            lastPushError: null
        });
        return {
            pushed: true,
            commitSha: headSha,
            hadChanges: Boolean(commitSha),
            repo: target.repo
        };
    } catch (err) {
        const msg = scrub(err.message, target?.token ?? "");
        await record({
            lastPushError: msg.slice(0, 300)
        });
        return {
            pushed: false,
            error: msg.slice(0, 300),
            repo: target?.repo
        };
    } finally{
        pushInProgress = false;
    }
}
}),
"[project]/src/app/api/self-enhance/push/route.ts [app-route] (ecmascript)", ((__turbopack_context__) => {
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
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$push$2d$target$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/pipeline/autonomous/push-target.ts [app-route] (ecmascript)");
;
;
const dynamic = "force-dynamic";
const runtime = "nodejs";
async function POST(req) {
    try {
        const body = await req.json().catch(()=>({}));
        const target = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$push$2d$target$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["getPushTargetPublic"])();
        if (!target.configured) {
            return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
                pushed: false,
                needsConfig: true,
                error: "No push target configured. Open [CONFIG] or POST /api/self-enhance/push-target"
            });
        }
        const outcome = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$pipeline$2f$autonomous$2f$push$2d$target$2e$ts__$5b$app$2d$route$5d$__$28$ecmascript$29$__["pushCurrentState"])({
            message: "Manual push: current live state",
            force: Boolean(body.force)
        });
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
            pushed: outcome.pushed,
            commitSha: outcome.commitSha,
            repo: outcome.repo,
            error: outcome.error
        });
    } catch (err) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$app$2d$route$5d$__$28$ecmascript$29$__["NextResponse"].json({
            pushed: false,
            error: err.message
        }, {
            status: 500
        });
    }
}
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__6d6a09fd._.js.map