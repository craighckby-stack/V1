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

const MIN_TOKEN_LENGTH = 2;
const FRICTION_FAILURE_WEIGHT = 0.8;
const FRICTION_COUNT_WEIGHT = 0.2;
const FRICTION_NO_FIX_WEIGHT = 0.15;
const HIGH_SIMILARITY_THRESHOLD = 0.05;
const ELEVATED_FRICTION_THRESHOLD = 0.6;
const LOW_SIMILARITY_THRESHOLD = 0.02;

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

const STOP_WORDS: ReadonlySet<string> = new Set([
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
    .filter((t): t is string => t.length > MIN_TOKEN_LENGTH && !STOP_WORDS.has(t));
}

/**
 * Compute term frequencies for a document.
 */
function termFreq(doc: string): Map<string, number> {
  const tokens = tokenize(doc);
  const tf = new Map<string, number>();
  
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
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
    
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  
  const idf = new Map<string, number>();
  
  for (const [term, frequency] of df) {
    idf.set(term, Math.log((N + 1) / (1 + frequency)) + 1);
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
  
  for (const [term, frequency] of tf) {
    const weight = frequency * (idf.get(term) ?? 1);
    vec.set(term, weight);
    norm += weight * weight;
  }
  
  norm = Math.sqrt(norm);
  
  if (norm > 0) {
    for (const [term, weight] of vec) {
      vec.set(term, weight / norm);
    }
  }
  
  return vec;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  // a is unit-normalized; for efficiency we iterate over the smaller vector.
  const [small, large] = a.size < b.size ? [a, b] as const : [b, a] as const;
  let dot = 0;
  
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other) dot += weight * other;
  }
  
  // b is also unit-normalized so dot product = cosine
  return dot;
}

class EmgRagMemory {
  private entries: VectorEntry[] = [];
  private idf: Map<string, number> = new Map();
  private vectors: Map<string, Map<string, number>> = new Map();
  private seeded = false;

  public async ensureSeeded(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;
    
    try {
      const count = await db.memoryEntry.count();
      
      if (count === 0) {
        await db.memoryEntry.createMany({
          data: INITIAL_MEMORY_ENTRIES.map(entry => ({
            ...entry,
            filePath: entry.filePath ?? null,
            ruleToAvoid: entry.ruleToAvoid ?? null,
            diagnosis: entry.diagnosis ?? null,
            cleanSnippet: entry.cleanSnippet ?? null,
          })),
        });
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
        timestamp: Date.now() - idx * 60000,
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
      id: `vec-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: Date.now(),
    };
    
    this.entries.push(newEntry);
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
        cognitiveFrictionScore: 0.05,
        epistemicRuling: "EMPTY_MEMORY: No pattern history yet.",
      };
    }
    
    const queryVec = tfidfVector(queryText, this.idf);
    const scored = this.entries.map((entry) => {
      const vec = this.vectors.get(entry.id);
      const score = vec ? cosine(queryVec, vec) : 0;
      return { entry, score };
    });

    const topFixes = scored
      .filter((s) => s.entry.provenance === "clean")
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((s) => s.entry);

    const topFailures = scored
      .filter((s) => s.entry.provenance === "failure")
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((s) => s.entry);

    // Friction: how much failure signal dominates over clean signal.
    const maxFailureScore = scored
      .filter((s) => s.entry.provenance === "failure")
      .reduce((max, s) => Math.max(max, s.score), 0);
      
    const maxFixScore = scored
      .filter((s) => s.entry.provenance === "clean")
      .reduce((max, s) => Math.max(max, s.score), 0);
      
    const friction = Math.min(
      1,
      Math.max(
        0,
        maxFailureScore * FRICTION_FAILURE_WEIGHT + 
        (topFailures.length > topFixes.length ? FRICTION_COUNT_WEIGHT : 0) + 
        (maxFixScore === 0 ? FRICTION_NO_FIX_WEIGHT : 0)
      )
    );

    let ruling = "EPISTEMIC_HARMONY: Mutation aligns with validated clean-room patterns.";
    
    if (maxFailureScore > maxFixScore && maxFailureScore > HIGH_SIMILARITY_THRESHOLD) {
      ruling = "COGNITIVE_FRICTION_ELEVATED: Known failure patterns dominate the query signal.";
    } else if (friction > ELEVATED_FRICTION_THRESHOLD) {
      ruling = "CONTRADICTION_UNRESOLVED: Conflicting architectural constraints detected.";
    } else if (maxFixScore < LOW_SIMILARITY_THRESHOLD && maxFailureScore < LOW_SIMILARITY_THRESHOLD) {
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