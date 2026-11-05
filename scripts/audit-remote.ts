/**
 * Security audit script — uses the sealed vault PAT (server-side, never
 * printed) to check the remote repo's visibility and scan the remote
 * tree for credential patterns. Prints ONLY findings/metadata, never
 * the token value.
 *
 * Usage: bun run scripts/audit-remote.ts
 */
import { getStoredTarget } from "@/lib/pipeline/autonomous/push-target";

/** Patterns that indicate a leaked credential (same families the
 *  system's own secret-scan uses). Matched against remote file CONTENT
 *  for small text files, and against file PATHS for everything. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "GitHub PAT (classic)", re: /ghp_[A-Za-z0-9]{36}/ },
  { name: "GitHub PAT (fine-grained)", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "Google API key", re: /AIzaSy[A-Za-z0-9_-]{33}/ },
  { name: "OpenAI key", re: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/ },
  { name: "OpenAI key (new)", re: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "enc:v1 vault envelope", re: /enc:v1:/ },
];

async function main() {
  const target = await getStoredTarget();
  if (!target?.token) {
    console.log("NO_TOKEN_ON_FILE");
    process.exit(2);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${target.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Architecture-Helper-Pipeline",
  };
  const repo = target.repo || "craighckby-stack/V1";

  // ── 1. Repo visibility ────────────────────────────────────────────
  const repoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  const repoData = (await repoRes.json()) as Record<string, unknown>;
  console.log("REPO:", repo);
  console.log("VISIBILITY:", repoData.visibility, "| private:", repoData.private, "| default:", repoData.default_branch);

  // ── 2. All branches (the loop-NN ledger) ─────────────────────────
  const branchNames: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const brRes = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`, { headers });
    if (!brRes.ok) break;
    const brs = (await brRes.json()) as Array<{ name: string }>;
    if (brs.length === 0) break;
    for (const b of brs) branchNames.push(b.name);
    if (brs.length < 100) break;
  }
  console.log("BRANCH_COUNT:", branchNames.length);
  console.log("BRANCHES_SAMPLE:", JSON.stringify(branchNames.slice(0, 5)), "...", JSON.stringify(branchNames.slice(-3)));

  // ── 3. Scan the remote tree of MAIN for secret-looking paths ────
  const treeRes = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/${repoData.default_branch || "main"}?recursive=1`,
    { headers }
  );
  const treeData = (await treeRes.json()) as {
    tree?: Array<{ path: string; type: string; size?: number }>;
    truncated?: boolean;
  };
  const paths = (treeData.tree ?? []).map((t) => t.path);
  console.log("MAIN_TREE_ENTRIES:", paths.length, "| truncated:", !!treeData.truncated);

  const suspiciousPaths = paths.filter((p) =>
    /(^|\/)(\.env($|\.|_)|.*\.pem$|.*\.key$|id_rsa|credentials\.json|service[-_]?account.*\.json|loop-vault-key|.*\.db$|.*\.sqlite.*)$/i.test(p)
  );
  console.log("SUSPICIOUS_PATHS:", suspiciousPaths.length ? JSON.stringify(suspiciousPaths) : "NONE");

  // ── 4. Fetch + content-scan small text files on main ─────────────
  // Only files < 120KB and with text-ish extensions — the same budget
  // the pipeline itself uses for content fetches.
  const textFileRe = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|sh|py|yml|yaml|toml|env|example|prisma|css|html|bat|cfg|conf|ini|lock)$/i;
  const candidates = (treeData.tree ?? [])
    .filter((t) => t.type === "blob" && (t.size ?? 0) < 120_000 && textFileRe.test(t.path))
    .slice(0, 4000);
  let contentHits = 0;
  const hitPaths: string[] = [];
  for (const f of candidates) {
    try {
      const cRes = await fetch(
        `https://raw.githubusercontent.com/${repo}/${repoData.default_branch || "main"}/${f.path}`,
        { headers: { Authorization: `Bearer ${target.token}`, "User-Agent": "audit" } }
      );
      if (!cRes.ok) continue;
      const body = await cRes.text();
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(body)) {
          contentHits++;
          hitPaths.push(`${f.path} (${name})`);
        }
      }
    } catch {
      /* skip file */
    }
  }
  console.log("CONTENT_FILES_SCANNED:", candidates.length);
  console.log("CONTENT_HITS:", contentHits === 0 ? "NONE" : JSON.stringify(hitPaths));

  // ── 5. Does the PAT itself appear anywhere on main? ──────────────
  // The one credential we KNOW exists — its value must not be in any
  // remote file. Searched last; the token value never printed.
  let tokenLeak = false;
  const tokenLeakPaths: string[] = [];
  for (const f of candidates) {
    try {
      const cRes = await fetch(
        `https://raw.githubusercontent.com/${repo}/${repoData.default_branch || "main"}/${f.path}`,
        { headers: { Authorization: `Bearer ${target.token}`, "User-Agent": "audit" } }
      );
      if (!cRes.ok) continue;
      const body = await cRes.text();
      if (target.token.length > 8 && body.includes(target.token)) {
        tokenLeak = true;
        tokenLeakPaths.push(f.path);
      }
    } catch {
      /* skip */
    }
  }
  console.log("PAT_VALUE_ON_MAIN:", tokenLeak ? JSON.stringify(tokenLeakPaths) : "NOT_FOUND (good)");

  process.exit(0);
}

main().catch((e) => {
  console.error("AUDIT_ERROR:", e.message);
  process.exit(3);
});
