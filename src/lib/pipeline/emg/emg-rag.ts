/**
 * Pattern Vector Memory Helper (server-side RAG)
 * Vectorizes pattern entries, evaluates similarity scores, and resolves contradictions.
 * Persisted to Prisma + in-memory cache.
 */

import { db } from "@/lib/db";

export interface VectorEntry {
  readonly id: string;
  readonly provenance: "clean" | "failure" | "synthesis" | "contradicted";
  readonly trust: "high" | "medium" | "low" | "revoked";
  readonly filePath?: string;
  readonly ruleToAvoid?: string;
  readonly diagnosis?: string;
  readonly cleanSnippet?: string;
  readonly content: string;
  readonly timestamp: number;
}

export interface EmgQueryResult {
  readonly topFailures: VectorEntry[];
  readonly topFixes: VectorEntry[];
  readonly cognitiveFrictionScore: number;
  readonly epistemicRuling: string;
}

const INITIAL_MEMORY_ENTRIES: Omit<VectorEntry, "id" | "timestamp">[] = [
  {
    provenance: "clean",
    trust: "high",
    filePath: "src/engine/zero-leak-sandbox.ts",
    ruleToAvoid: "Never hold hard references to ephemeral mutation contexts in global maps.",
    diagnosis: "WeakMap scoped garbage collection completely eliminates session leakage.",
    cleanSnippet: "private readonly activeContexts = new WeakMap<object, SandboxContext>();",
    content: "WeakMap isolated execution context preventing memory leak across autonomous cycles.",
  },
  {
    provenance: "failure",
    trust: "high",
    filePath: "src/lib/gemini.ts",
    ruleToAvoid: "Hardcoded API keys or unencrypted credentials in repository blobs.",
    diagnosis: "Shannon entropy scan flags unredacted keys before Git commit dispatch.",
    cleanSnippet: "const apiKey = process.env.GEMINI_API_KEY || '[REDACTED_SECRET]';",
    content: "Secret leakage vulnerability detected via entropy threshold exceeding 4.2.",
  },
  {
    provenance: "clean",
    trust: "high",
    filePath: "src/lib/ast-diff-gate.ts",
    ruleToAvoid: "Silent symbol omission during AST transformations.",
    diagnosis: "Enforce AST Diff Gate symbol retention minimum of 60% before merge.",
    cleanSnippet: "const missingSymbols = originalSymbols.filter(s => !proposedNames.has(s.name));",
    content: "AST structural verification preventing function or type erasure.",
  },
  {
    provenance: "clean",
    trust: "high",
    filePath: "src/engine/halt.ts",
    ruleToAvoid: "Infinite re-mutation of semantically identical files.",
    diagnosis: "0-diff AST code normalization halts over-optimization.",
    cleanSnippet: "if (normOriginal === normProposed) { return { shouldHalt: true }; }",
    content: "Self-stopping point architecture preventing infinite autonomous loops.",
  },
];

class EmgRagMemory {
  private entries: VectorEntry[] = [];
  private seeded = false;

  public async ensureSeeded(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;
    try {
      const count = await db.memoryEntry.count();
      if (count === 0) {
        for (const entry of INITIAL_MEMORY_ENTRIES) {
          await db.memoryEntry.create({
            data: {
              provenance: entry.provenance,
              trust: entry.trust,
              filePath: entry.filePath,
              ruleToAvoid: entry.ruleToAvoid,
              diagnosis: entry.diagnosis,
              cleanSnippet: entry.cleanSnippet,
              content: entry.content,
            },
          });
        }
      }
      const rows = await db.memoryEntry.findMany({ orderBy: { createdAt: "asc" } });
      this.entries = rows.map(r => ({
        id: r.id,
        provenance: r.provenance as VectorEntry["provenance"],
        trust: r.trust as VectorEntry["trust"],
        filePath: r.filePath ?? undefined,
        ruleToAvoid: r.ruleToAvoid ?? undefined,
        diagnosis: r.diagnosis ?? undefined,
        cleanSnippet: r.cleanSnippet ?? undefined,
        content: r.content,
        timestamp: r.createdAt.getTime(),
      }));
    } catch (err) {
      // If DB unavailable, fall back to in-memory only.
      this.entries = INITIAL_MEMORY_ENTRIES.map((e, idx) => ({
        ...e,
        id: `seed-${idx}`,
        timestamp: Date.now() - idx * 60000,
      }));
    }
  }

  public getAll(): VectorEntry[] {
    return [...this.entries];
  }

  public addEntry(entry: Omit<VectorEntry, "id" | "timestamp">): VectorEntry {
    const newEntry: VectorEntry = {
      ...entry,
      id: `vec-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: Date.now(),
    };
    this.entries.push(newEntry);
    // Best-effort persist; do not block on it.
    db.memoryEntry
      .create({
        data: {
          provenance: entry.provenance,
          trust: entry.trust,
          filePath: entry.filePath ?? null,
          ruleToAvoid: entry.ruleToAvoid ?? null,
          diagnosis: entry.diagnosis ?? null,
          cleanSnippet: entry.cleanSnippet ?? null,
          content: entry.content,
        },
      })
      .catch(() => {
        /* ignore */
      });
    return newEntry;
  }

  public query(queryText: string): EmgQueryResult {
    const tokens = queryText.toLowerCase().split(/\W+/).filter(Boolean);

    const scored = this.entries.map(entry => {
      const entryText =
        `${entry.content} ${entry.diagnosis ?? ""} ${entry.ruleToAvoid ?? ""} ${entry.filePath ?? ""}`.toLowerCase();
      let matchCount = 0;
      for (const t of tokens) {
        if (entryText.includes(t)) matchCount++;
      }
      const score = tokens.length > 0 ? matchCount / tokens.length : 0;
      return { entry, score };
    });

    const topFixes = scored
      .filter(s => s.entry.provenance === "clean")
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(s => s.entry);

    const topFailures = scored
      .filter(s => s.entry.provenance === "failure")
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(s => s.entry);

    const friction = Math.min(
      1,
      Math.max(0, topFailures.length * 0.4 + (topFixes.length === 0 ? 0.3 : 0.05))
    );

    let ruling = "EPISTEMIC_HARMONY: Mutation aligns with validated clean-room patterns.";
    if (topFailures.length > topFixes.length) {
      ruling = "COGNITIVE_FRICTION_ELEVATED: Known failure patterns detected in candidate code.";
    } else if (friction > 0.6) {
      ruling = "CONTRADICTION_UNRESOLVED: Conflicting architectural constraints detected.";
    }

    return {
      topFailures,
      topFixes,
      cognitiveFrictionScore: friction,
      epistemicRuling: ruling,
    };
  }

  public clear(): void {
    this.entries = [];
    db.memoryEntry.deleteMany({}).catch(() => {
      /* ignore */
    });
  }
}

export const emgRagInstance = new EmgRagMemory();
