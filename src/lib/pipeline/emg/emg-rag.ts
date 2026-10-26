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
  {
    provenance: "failure",
    trust: "high",
    filePath: "src/lib/eval-runtime.ts",
    ruleToAvoid: "Dynamic code execution (eval/Function) opens injection vectors.",
    diagnosis: "Static review flags any eval() or new Function() usage before commit.",
    cleanSnippet: "// Replace with a parser/interpreter sandbox",
    content: "Dynamic code execution flagged by review tribunal; rewrite required before merge.",
  },
  {
    provenance: "clean",
    trust: "medium",
    filePath: "src/engines/clean-room-runtime.ts",
    ruleToAvoid: "Unbounded agent loops can run forever without progress checks.",
    diagnosis: "Bounded ReAct loop with step cap + cycle detection breaks infinite loops.",
    cleanSnippet: "if (seenActions.has(actionSig)) { break; }",
    content: "Bounded agent reasoning loop with action-signature cycle detection.",
  },
];

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "for", "while", "do",
  "of", "in", "on", "at", "to", "from", "by", "with", "without", "into", "out",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "this", "that", "these", "those", "it", "its", "as", "not", "no", "yes",
  "we", "you", "they", "he", "she", "him", "her", "them", "us", "i", "me",
  "can", "could", "should", "would", "may", "might", "must", "shall", "will",
  "any", "all", "some", "none", "both", "either", "neither", "each", "every",
  "before", "after", "during", "while", "since", "until", "up", "down", "over",
  "more", "less", "most", "least", "very", "too", "quite", "just", "only",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_+-]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Compute term frequencies for a document.
 */
function termFreq(doc: string): Map<string, number> {
  const tokens = tokenize(doc);
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

/**
 * Compute IDF for each term across a corpus of documents.
 * idf(t) = log(N / (1 + df(t)))
 */
function computeIdf(documents: string[]): Map<string, number> {
  const N = documents.length;
  const df = new Map<string, number>();
  for (const doc of documents) {
    const seen = new Set<string>(tokenize(doc));
    for (const t of seen) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [t, d] of df) {
    idf.set(t, Math.log((N + 1) / (1 + d)) + 1);
  }
  return idf;
}

/**
 * Compute the TF-IDF vector for a document given an IDF map.
 * Vector is normalized to unit length so cosine similarity is just a dot product.
 */
function tfidfVector(doc: string, idf: Map<string, number>): Map<string, number> {
  const tf = termFreq(doc);
  const vec = new Map<string, number>();
  let norm = 0;
  for (const [t, freq] of tf) {
    const weight = freq * (idf.get(t) ?? 1);
    vec.set(t, weight);
    norm += weight * weight;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (const [t, w] of vec) {
      vec.set(t, w / norm);
    }
  }
  return vec;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  // a is unit-normalized; for efficiency we iterate over the smaller vector.
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const other = large.get(t);
    if (other) dot += w * other;
  }
  // b is also unit-normalized so dot product = cosine
  return dot;
}

class EmgRagMemory {
  private entries: VectorEntry[] = [];
  private idf: Map<string, number> = new Map();
  private vectors: Map<string, Map<string, number>> = new Map();
  private seeded = false;
  private readonly TIMESTAMP_INTERVAL_MINUTES = 60000;
  private readonly RANDOM_ID_SUFFIX_MAX = 1000;
  private readonly DEFAULT_COGNITIVE_FRICTION_SCORE = 0.05;
  private readonly TOP_RESULTS_COUNT = 3;
  private readonly HIGH_FRICTION_THRESHOLD = 0.6;
  private readonly LOW_SIMILARITY_THRESHOLD = 0.02;

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
      this.entries = rows.map((r) => ({
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
    } catch {
      this.entries = INITIAL_MEMORY_ENTRIES.map((e, idx) => ({
        ...e,
        id: `seed-${idx}`,
        timestamp: Date.now() - idx * this.TIMESTAMP_INTERVAL_MINUTES,
      }));
    }
    this.recomputeVectors();
  }

  private entryDoc(e: VectorEntry): string {
    return `${e.content} ${e.diagnosis ?? ""} ${e.ruleToAvoid ?? ""} ${e.filePath ?? ""}`;
  }

  private recomputeVectors(): void {
    const docs = this.entries.map((e) => this.entryDoc(e));
    this.idf = computeIdf(docs);
    this.vectors.clear();
    for (const e of this.entries) {
      this.vectors.set(e.id, tfidfVector(this.entryDoc(e), this.idf));
    }
  }

  public getAll(): VectorEntry[] {
    return [...this.entries];
  }

  public addEntry(entry: Omit<VectorEntry, "id" | "timestamp">): VectorEntry {
    const newEntry: VectorEntry = {
      ...entry,
      id: `vec-${Date.now()}-${Math.floor(Math.random() * this.RANDOM_ID_SUFFIX_MAX)}`,
      timestamp: Date.now(),
    };
    this.entries.push(newEntry);
    // Recompute IDF + vectors incrementally is overkill; just recompute all.
    this.recomputeVectors();
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
    if (this.entries.length === 0 || this.idf.size === 0) {
      return {
        topFailures: [],
        topFixes: [],
        cognitiveFrictionScore: this.DEFAULT_COGNITIVE_FRICTION_SCORE,
        epistemicRuling: "EMPTY_MEMORY: No pattern history yet.",
      };
    }
    const queryVec = tfidfVector(queryText, this.idf);
    const scored = this.entries.map((entry) => {
      const vec = this.vectors.get(entry.id);
      const score = vec ? cosine(queryVec, vec) : 0;
      return { entry, score };
    });

    // Keep the score alongside the entry so the max-score lookups below work.
    const topFixesScored = scored
      .filter((s) => s.entry.provenance === "clean")
      .sort((a, b) => b.score - a.score)
      .slice(0, this.TOP_RESULTS_COUNT);

    const topFailuresScored = scored
      .filter((s) => s.entry.provenance === "failure")
      .sort((a, b) => b.score - a.score)
      .slice(0, this.TOP_RESULTS_COUNT);

    const topFixes = topFixesScored.map((s) => s.entry);
    const topFailures = topFailuresScored.map((s) => s.entry);

    // Friction: how much failure signal dominates over clean signal.
    const maxFailureScore = topFailuresScored[0]?.score ?? 0;
    const maxFixScore = topFixesScored[0]?.score ?? 0;
    const FRICTION_FAILURE_WEIGHT = 0.8;
    const FRICTION_DOMINANCE_WEIGHT = 0.2;
    const FRICTION_NO_FIX_WEIGHT = 0.15;
    const friction = Math.min(
      1,
      Math.max(
        0,
        maxFailureScore * FRICTION_FAILURE_WEIGHT + (topFailures.length > topFixes.length ? FRICTION_DOMINANCE_WEIGHT : 0) + (maxFixScore === 0 ? FRICTION_NO_FIX_WEIGHT : 0)
      )
    );

    const FAILURE_SCORE_THRESHOLD = 0.05;
    let ruling = "EPISTEMIC_HARMONY: Mutation aligns with validated clean-room patterns.";
    if (maxFailureScore > maxFixScore && maxFailureScore > FAILURE_SCORE_THRESHOLD) {
      ruling = "COGNITIVE_FRICTION_ELEVATED: Known failure patterns dominate the query signal.";
    } else if (friction > this.HIGH_FRICTION_THRESHOLD) {
      ruling = "CONTRADICTION_UNRESOLVED: Conflicting architectural constraints detected.";
    } else if (maxFixScore < this.LOW_SIMILARITY_THRESHOLD && maxFailureScore < this.LOW_SIMILARITY_THRESHOLD) {
      ruling = "NOVEL_INPUT: Query has low similarity to any prior pattern — proceed with caution.";
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
    this.idf.clear();
    this.vectors.clear();
    db.memoryEntry.deleteMany({}).catch(() => {
      /* ignore */
    });
  }
}

export const emgRagInstance = new EmgRagMemory();