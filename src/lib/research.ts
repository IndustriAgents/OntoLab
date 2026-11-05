import type { RunStepKind } from "../types/project";
import type { ChunkMetrics, ChunkSettings } from "../types/research";

/** Compare configuration values independently of JSON/Postgres object key order. */
export function chunkSettingsKey(s: ChunkSettings): string {
  const t = s.unit === "tokens" ? s.tokens : undefined;
  const g = t?.generation;
  return JSON.stringify([
    s.method,
    s.unit === "tokens" ? null : s.maxChars,
    s.overlap,
    s.unit ?? "characters",
    t?.embedding.profile,
    t?.embedding.maxTokens,
    g?.provider,
    g?.model,
    g?.maxTokens,
    g?.contextTokens,
    g?.outputTokens,
    g?.promptReserveTokens,
  ]);
}

export function chunkMetrics(chunks: { start: number; end: number; overlap?: number }[]): ChunkMetrics {
  const sizes = chunks.map((c) => c.end - c.start);
  const totalChars = sizes.reduce((a, b) => a + b, 0);
  const overlapChars = chunks.reduce((n, c) => n + (c.overlap ?? 0), 0);
  return {
    count: sizes.length,
    minChars: sizes.length ? sizes.reduce((a, b) => Math.min(a, b), Infinity) : 0,
    maxChars: sizes.reduce((a, b) => Math.max(a, b), 0),
    meanChars: sizes.length ? Math.round(totalChars / sizes.length) : 0,
    totalChars,
    overlapChars,
    overlapPercent: totalChars ? Math.round((overlapChars / totalChars) * 1000) / 10 : 0,
  };
}

export const CHUNK_METHODS = {
  paragraph: {
    name: "Paragraph + boundary overlap",
    description:
      "Pack blank-line-separated paragraphs to a character budget. Split oversized paragraphs at sentence, line or word boundaries, with a hard cut as the last resort. Add boundary-aligned context from the previous chunk. Headings are metadata, not hard boundaries.",
  },
  section: {
    name: "Section-aware paragraphs",
    description:
      "Start a new group at each detected heading. Pack and split paragraphs within that section. Overlap stays inside the section, so context never crosses a heading boundary. Without detected headings this behaves like paragraph packing.",
  },
  fixed: {
    name: "Fixed character windows",
    description:
      "Cut the text at exact character intervals and prepend a fixed amount of overlap. May split words, sentences and tables. Useful as a simple experimental baseline.",
  },
} as const;

/** Descriptions of the implemented algorithms; execution values come from saved records. */
export const STAGE_METHODS: Record<RunStepKind, { title: string; method: string; input: string; output: string; tuning: string }> = {
  alignment_retrieve: {
    title: "Alignment candidates",
    method: "Lexical, semantic and structural retrieval across frozen ontology inputs; up to two candidates per source term.",
    input: "Saved source and target ontologies",
    output: "Candidate pairs, scores and coverage diagnostics",
    tuning: "Choose source coverage and matchers before starting a new run.",
  },
  alignment_verify: {
    title: "Relation classification",
    method: "A structured model call classifies up to 20 candidate pairs using definitions and ontology context.",
    input: "Candidate pairs and frozen term definitions",
    output: "Relation verdicts and rationales, with token usage",
    tuning: "Pausing keeps completed batches. Change the model by starting a new run.",
  },
  summary: {
    title: "Document context",
    method:
      "Structured LLM summarisation; first 60,000 characters, summary capped at 1,500 characters. Cached by document checksum, model and prompt version.",
    input: "Parsed document text",
    output: "Summary supplied alongside each chunk",
    tuning:
      "Chunk size determines whether a multi-chunk document needs this stage. Inspect whether the summary loses abbreviations or context.",
  },
  chunk: {
    title: "Fact extraction",
    method:
      "Optional relevance screening, result cache, optional schema retrieval, then ontology-constrained structured LLM extraction and source-quote location.",
    input: "Chunk, section path, document summary, retrieved ontology and known individuals",
    output: "A-Box individuals, properties, source quotes and unmatched terms",
    tuning:
      "Compare chunk size/overlap, code vs tree prompts, schema retrieval and top-k. Turn screening off to measure recall losses. Cache hits bypass screening and the model.",
  },
  vision: {
    title: "PDF vision extraction",
    method:
      "Send original PDF to a vision-capable provider with the ontology. Evidence without a located text quote is marked vision-only.",
    input: "PDF bytes, parsed text and ontology",
    output: "A-Box with vision or located evidence",
    tuning: "Compare vision with parsed text for diagrams and scans. Vision evidence is not a verified text location.",
  },
  qa: {
    title: "Interactive refinement",
    method: "Structured LLM refinement using bounded document context, previous individuals and accumulated answers.",
    input: "Previous A-Box and user clarifications",
    output: "Refined A-Box and follow-up questions",
    tuning: "Compare automatic extraction with interactive clarification. Human answers change the experiment's inputs.",
  },
  ground: {
    title: "External entity grounding",
    method: "Look up candidate entities in the enabled Wikidata, GeoNames or UMLS sources and attach external identifiers.",
    input: "Assembled individuals and enabled sources",
    output: "Grounded individuals with sameAs links",
    tuning: "Enable sources in project settings. Inspect identity matches; a similar label does not prove identity.",
  },
  resolve: {
    title: "Entity resolution",
    method:
      "Candidate generation using labels, embeddings and grounding; LLM adjudication for ambiguous pairs. Decisions are proposed for review.",
    input: "Assembled A-Box and base-graph identities",
    output: "Duplicate candidates, scores, methods and recommended decisions",
    tuning: "Compare resolution enabled/disabled and review wrong merges separately from missed duplicates.",
  },
  verify: {
    title: "Evidence support",
    method:
      "Verbalise each assertion and score entailment against its quote with nearby source context. Configured NLI can be local, provider or lexical; local loading can fall back to lexical.",
    input: "Claims, quotes and source context",
    output: "Evidence scores and review flags on the A-Box",
    tuning:
      "Compare NLI backends in project settings. Scores are not calibrated correctness probabilities; quote location and semantic support are separate checks.",
  },
  terms: {
    title: "Classes and taxonomy",
    method:
      "Topic groups use cosine k-means with deterministic farthest-first seeds, or document order without embeddings. New runs divide groups into request batches and send every planned chunk in full, including overlap. Historical runs may contain sampled passages; inspect the recorded inputs for actual coverage. Structured LLM calls propose classes and parents; quotes are located.",
    input: "Topic-cluster chunks and requirements",
    output: "Proposed classes, parent links and term evidence",
    tuning:
      "Compare competency-question guidance and strict grounding. Inspect cluster membership in the input tab; chunking influences these groups.",
  },
  merge: {
    title: "Class consolidation",
    method:
      "Normalise class names and merge aliases; merge embedded class descriptions at cosine similarity ≥ 0.93 when available; repair parent references.",
    input: "Class proposals from all topic groups",
    output: "Consolidated classes and retained term evidence",
    tuning: "Inspect overly broad merges and lost distinctions. Embedding choice is controlled in project settings.",
  },
  relations: {
    title: "Relations and attributes",
    method: "Structured LLM generation constrained to the consolidated class list, with source-quote location.",
    input: "Cluster text, consolidated classes and requirements",
    output: "Object properties, data properties and their evidence",
    tuning: "Check object-vs-data choices, domains, ranges and functional flags. Compare competency-question guidance.",
  },
  axioms: {
    title: "Logical axioms",
    method:
      "Structured LLM proposals for disjointness, restrictions, inverse relations and property characteristics. Admission is checked later by the reasoner.",
    input: "Proposed vocabulary listing and requirements; no direct source passages in this call",
    output: "Candidate axiom units",
    tuning: "Disable axiom induction for an ablation. Proposed axioms are not yet accepted axioms.",
  },
  reuse: {
    title: "Vocabulary reuse",
    method: "Search enabled vocabulary sources for possible reuse of proposed terms.",
    input: "Assembled vocabulary",
    output: "Reuse suggestions and the assembled raw ontology",
    tuning: "Inspect suggested mappings before alignment. Source availability and lookup failures affect coverage.",
  },
  pitfalls: {
    title: "Ontology checks and repair",
    method:
      "Admit proposed axioms using the reasoner and scan ontology pitfalls. New runs repair using small statement patches for up to three rounds, retaining edits only when checks improve and terms are preserved. If optional repair cannot finish, the last validated draft and remaining findings are kept for review.",
    input: "Assembled ontology and candidate axioms",
    output: "Turtle, remaining pitfalls, accepted/rejected axioms and pre-repair counts",
    tuning: "Compare repair enabled/disabled. Reasoner acceptance establishes consistency under the supported rules, not domain truth.",
  },
  finalize: {
    title: "Draft assembly",
    method:
      "T-Box: assemble ontology modules and review metadata. A-Box: merge with the base graph when incremental, validate assertions, apply fact-review policy, and create a draft revision.",
    input: "Completed checkpoints and pinned base revision",
    output: "Saved draft snapshot; review, validate and commit remain explicit steps",
    tuning:
      "Compare incremental vs replacement extraction and evidence-gate policy. Use Validate for SHACL, reasoning and competency-query results.",
  },
};
