import type { ExternalGraph, GraphPublication } from "./connections";
// Persisted project model shared by the server (repositories, services, HTTP)
// and the client (TanStack Query caches, pages). Everything here is plain JSON:
// it crosses the wire as-is and is stored as-is by the local adapter.

import type {
  ABoxResult,
  ClarifyQuestion,
  Clarification,
  EvidenceRef,
  ManualEdit,
  PendingFact,
  ValidationIssue as AboxIssue,
} from "./abox";
import type { OntoModule, ValidationIssue as OntologyIssue } from "./validation";
import type { AgentTrace } from "./graphChat";
import type { TokenChunkSettings, TokenMeasurement, ChunkSettings, PreprocessingRecord, StageTrace, TechnicalResult } from "./research";
import type { AlignmentRecord, ShaclExecution } from "./transparency";
import type { AlignmentSetup, AlignmentDecision, AlignmentRunContext } from "./alignment";

import type { CorpusMetadata, CorpusGraphState, CorpusRunContext } from "./corpus";

export type ISODate = string;

export interface User {
  id: string;
  email?: string;
  name?: string;
}

/* ───────────────────────── projects ───────────────────────── */

export type CqStatus = "proposed" | "approved" | "rejected";

/** A competency question: elicited from user stories, edited and approved by the user. */
export interface CompetencyQuestion {
  id: string;
  text: string;
  status: CqStatus;
  /** "tbox" = generated from the ontology's own structure (answerable by construction) */
  source: "user" | "generated" | "template" | "tbox";
  /** index into Requirements.stories this question was derived from */
  story?: number;
  /** stored SPARQL translation; travels with the question instead of being regenerated */
  sparql?: string;
  /** tboxHash of the ontology the SPARQL was written against */
  sparqlTboxHash?: string;
  /** what the question talks about, mapped to ontology terms */
  terms?: CqTerms;
  answerability?: CqAnswerability;
  /** id of an earlier question this one repeats (semantic duplicate) */
  dupOf?: string;
}

/** One thing a competency question mentions, and the ontology term it maps to. */
export interface CqTermMention {
  text: string;
  role: "class" | "property" | "value";
  /** the T-Box term; absent when the ontology has nothing for it */
  uri?: string;
}

export interface CqTerms {
  mentions: CqTermMention[];
  /** tboxHash the mapping was made against */
  tboxHash: string;
}

/**
 * Schema-level and data-level answerability are different things: a T-Box can
 * be able to represent the answer (schema) while the graph holds no facts yet (data).
 */
export interface CqAnswerability {
  /** answerable: every mention maps to a term and the terms are linked; partial: some map or they are not linked; unsupported: none map */
  schema: "answerable" | "partial" | "unsupported";
  /** mentions with no ontology term */
  missing: string[];
  /** terms that are mapped but not connected to the rest of the question */
  disconnected: string[];
  /** classes and properties linking the question's terms */
  path: string[];
  /** from the latest validation of the current revision */
  data: "answered" | "empty" | "error" | "untested";
  /** IRIs in the stored SPARQL that the current ontology no longer has */
  staleIris: string[];
  tboxHash: string;
  checkedAt: ISODate;
}

/** Requirements come first: user stories → competency questions → the ontology must answer them. */
export interface Requirements {
  stories: string[];
  cqs: CompetencyQuestion[];
}

export interface RequirementsVersion {
  number: number;
  createdAt: ISODate;
  requirements: Requirements;
  restoredFrom?: number;
}

export interface ProjectBudget {
  /** refuse to start (and stop) a run whose cost would exceed this, in USD */
  maxUsdPerRun?: number;
  /** stop starting runs once the project's recorded spend reaches this, in USD */
  maxUsdTotal?: number;
}

export type EmbeddingsChoice = "local" | "provider" | "hash" | "off";
export type NliChoice = "local" | "provider" | "lexical" | "off";

export interface ProjectSettings {
  externalGraph?: ExternalGraph;
  publications?: GraphPublication[];
  /** Internal corpus identity and source membership; changed only through corpus APIs. */
  corpus?: CorpusMetadata;
  /** IRI individuals are minted under; empty = derived from the T-Box */
  baseIri?: string;
  provider?: string;
  model?: string;
  /** competency questions with a saved SPARQL translation, re-run on every validation */
  savedQueries?: { question: string; sparql: string }[];
  requirements?: Requirements;
  /** Immutable saved requirements; restoring appends a new version. */
  requirementsVersions?: RequirementsVersion[];
  budget?: ProjectBudget;
  /** retrieval and entailment models; absent = the server default */
  models?: { embeddings?: EmbeddingsChoice; nli?: NliChoice };
  /** grounding sources for entity resolution: "wikidata" | "geonames" | "umls" */
  grounding?: string[];
  /**
   * Which facts the graph is made of — export, queries, validation, reasoning and
   * Ask: every fact (all), every fact except rejected ones (exclude-rejected,
   * the default), or only accepted ones (accepted-only; commits then wait until
   * candidates are decided).
   */
  reviewPolicy?: "all" | "exclude-rejected" | "accepted-only";
  /** GraphDB repository this project publishes to and can chat with (the server holds the URL) */
  graphdb?: GraphDbSettings;
}

export interface GraphDbSettings {
  repository?: string;
  /** named graph the revision is written into; empty = a graph per project */
  graph?: string;
  /** the last revision written to GraphDB */
  published?: { revisionId: string; revisionNumber: number; at: ISODate; triples: number; graph: string };
}

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  purpose: string;
  scope: string;
  competencyQuestions: string[];
  settings: ProjectSettings;
  /** the committed revision everything else is read from; null for a fresh project */
  currentRevisionId: string | null;
  archived: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** Dashboard row: a project plus the counters the list needs. */
export interface ProjectSummary extends Project {
  documentCount: number;
  revisionNumber: number | null;
  activeRun: { id: string; status: RunStatus } | null;
}

/* ───────────────────────── documents ───────────────────────── */

export type DocumentKind = "pdf" | "docx" | "text" | "html" | "pptx" | "xlsx" | "xls" | "image";
export type ParseState = "pending" | "parsed" | "failed";

/** Page boundaries in a document's extracted text (PDFs only). */
export interface PageSpan {
  page: number;
  start: number;
  end: number;
}

/** A heading and the text it governs; `path` is the heading and its ancestors. */
export interface SectionSpan {
  level: number;
  title: string;
  path: string[];
  start: number;
  end: number;
}

export interface TableSpan {
  start: number;
  end: number;
  page?: number;
}

export interface ParsingRecord {
  version: string;
  sourceHash: string;
  textHash: string;
  createdAt: ISODate;
  warnings: string[];
}

export interface ProjectDocument {
  /** Durable processing job. Null once it succeeds or fails. */
  processing?: { stage: "queued" | "parsing" | "chunking"; holder?: string; expiresAt?: ISODate; settings?: ChunkSettings } | null;
  parsing?: ParsingRecord;

  preprocessing?: PreprocessingRecord | null;
  /** A separate chunking experiment on the same original; existing runs remain untouched. */
  variantOf?: string;
  id: string;
  projectId: string;
  ownerId: string;
  name: string;
  mediaType: string;
  kind: DocumentKind;
  sizeBytes: number;
  /** sha256 of the original bytes — identity for runs and de-duplication */
  checksum: string;
  storagePath: string;
  parseState: ParseState;
  parseError?: string;
  pageCount?: number;
  charCount: number;
  chunkCount: number;
  /** which parser produced the text: the built-in Node parsers or the Docling sidecar */
  parser?: "node" | "docling";
  sectionCount?: number;
  tableCount?: number;
  /** text came (partly) from OCR */
  ocr?: boolean;
  createdAt: ISODate;
}

export interface DocumentChunk {
  tokenization?: {
    generation: TokenMeasurement;
    embeddingPassages: { start: number; end: number; tokens: number }[];
    embedding: { tokenizer: string; exact: boolean };
  };
  id: string;
  documentId: string;
  projectId: string;
  ordinal: number;
  text: string;
  /** character offsets into the document's extracted text */
  start: number;
  end: number;
  page?: number;
  pageEnd?: number;
  /** headings the chunk starts under, outermost first */
  sectionPath?: string[];
  /** leading characters repeated from the previous chunk (context, not new content) */
  overlap?: number;
}

export interface DocumentText {
  documentId: string;
  /** Hash of the current parsed text, for invalidating preprocessing previews. */
  textHash?: string;
  text: string;
  pages: PageSpan[];
  sections?: SectionSpan[];
  tables?: TableSpan[];
  sourceSpans?: { start: number; end: number; path: string }[];
  chunks: Omit<DocumentChunk, "text" | "projectId">[];
}

export type { EvidenceRef, EvidenceStatus } from "./abox";

/* ───────────────────────── revisions ───────────────────────── */

export type RevisionStatus = "draft" | "committed";
export type RevisionSource = "manual" | "import" | "extraction" | "assistant" | "restore" | "ontology" | "induction" | "template" | "merge";

/** Two or more individuals that may be the same entity, with the evidence for the call. */
export interface MergeCandidate {
  id: string;
  /** individual ids; the first is the one kept when merged */
  ids: string[];
  label: string;
  /** similarity in [0, 1] */
  score: number;
  method: "label" | "embedding" | "grounding" | "llm";
  decision: "pending" | "merge" | "distinct";
  /** why: shared grounding IRI, the model's reason, the similarity */
  explanation: string;
}

/** What a T-Box change did to the individuals that used its terms. */
export interface MigrationReport {
  /** old term URI → new term URI, applied to every individual */
  renamed: { from: string; to: string; individuals: number }[];
  /** individuals that still use a removed term — fix by hand */
  flagged: { id: string; term: string }[];
}

export interface RevisionContent {
  corpus?: CorpusGraphState;
  modules: OntoModule[];
  abox: ABoxResult | null;
  baseIri: string;
  /** entity-resolution candidates awaiting a decision (extraction drafts) */
  resolution?: { candidates: MergeCandidate[] };
  /** set when this revision changed the T-Box of a revision that had individuals */
  migration?: MigrationReport;
  /** ontology review aids attached to induced or imported T-Box drafts */
  review?: OntologyReview;
  /** what an ontology change does to the existing ontology and the competency questions */
  impact?: ImpactReport;
  /** manual A-Box edits made on this draft (audit trail, newest last) */
  edits?: ManualEdit[];
}

/** The effect of an ontology change, checked before it is committed. */
export interface ImpactReport {
  /** no blocking errors and no competency question regressed */
  ok: boolean;
  errors: string[];
  /** changed entailments between terms that existed before (readable) */
  unintended: string[];
  /** classes the change made unsatisfiable */
  newlyUnsat: string[];
  /** saved competency queries re-run before and after */
  cq: { checked: number; regressions: string[] };
  /** term-level changes, readable */
  changes: string[];
}

/** An existing term elsewhere (LOV, schema.org, BioPortal) that a new term could reuse. */
export interface ReuseSuggestion {
  /** URI of the term in this ontology */
  term: string;
  kind: "class" | "property";
  candidates: { iri: string; label: string; source: "lov" | "schemaorg" | "bioportal"; vocabulary?: string; score: number }[];
  status?: "open" | "accepted" | "dismissed";
}

/** A proposed correspondence between two ontologies (template ↔ standard). */
export interface AlignmentMapping {
  id: string;
  source: string;
  target: string;
  kind: "class" | "property";
  /**
   * how TARGET relates to SOURCE. equivalent/broader/narrower are logical
   * (owl:equivalent…, rdfs:sub…Of); related is a weaker skos:relatedMatch;
   * candidate = similar but not verified by a model (accepted as skos:closeMatch,
   * never as an equivalence).
   */
  relation: "equivalent" | "broader" | "narrower" | "related" | "candidate" | "unrelated";
  /** Raw cosine before clamping; absent on older records or when embeddings were not used. */
  cosine?: number;
  /** combined retrieval score before verification */
  score: number;
  /** the matchers behind the score */
  scores?: { lexical: number; semantic: number; structural: number };
  /** a model confirmed the relation */
  verified: boolean;
  rationale: string;
  status?: "open" | "accepted" | "dismissed" | "deferred";
  /** Comparison whose immutable module snapshots support this mapping. */
  runId?: string;
  /** Human relation correction or manually authored correspondence. */
  humanReviewed?: boolean;
  reviewNote?: string;
  /** Previous inputs changed and no fresh candidate supports this mapping yet. */
  stale?: boolean;
  /** accepting this mapping would make classes unsatisfiable (coherence check) */
  conflict?: { unsat: string[]; explanation: string[] };
}

export interface OntologyReview {
  alignmentSetup?: AlignmentSetup;
  alignmentDecisions?: AlignmentDecision[];
  alignmentRuns?: AlignmentRecord[];
  pitfalls?: { code: string; title: string; severity: "critical" | "important" | "minor"; subject: string; message: string; fix: string }[];
  /** pitfall counts before the automatic repair, for the record */
  pitfallsBefore?: { critical: number; important: number; minor: number };
  reuse?: ReuseSuggestion[];
  alignment?: AlignmentMapping[];
  /** where each induced term was found in the documents (hallucination guard) */
  termEvidence?: TermEvidence[];
  /** axioms the induction proposed, and the ones the reasoner turned down */
  axioms?: { accepted: string[]; rejected: { axiom: string; reason: string }[] };
  /** advisory findings of the model-assisted semantic review */
  semantic?: SemanticFinding[];
}

export interface TermEvidence {
  /** Source span recorded when the quote was located in a generation input. */
  chunkId?: string;
  start?: number;
  end?: number;
  /** local name of the induced term */
  term: string;
  kind: "class" | "object" | "data";
  quote: string;
  /** the quote was found verbatim (modulo whitespace) in the cited text */
  located: boolean;
  documentId?: string;
}

/** A model-assisted review finding: advisory, a person decides. */
export interface SemanticFinding {
  id: string;
  /** URI of the term the finding is about */
  subject: string;
  kind: "hierarchy" | "definition" | "domain-range" | "naming" | "redundancy";
  severity: "important" | "minor";
  message: string;
  /** a concrete change, in words */
  fix?: string;
  status?: "open" | "accepted" | "dismissed";
}

/** Which half of the ontology a revision changed relative to its parent. */
export type RevisionScope = "tbox" | "abox" | "both" | "none";

export interface OntologyRevision {
  id: string;
  projectId: string;
  /** the committed revision this one was derived from */
  parentId: string | null;
  /** 1-based sequence among committed revisions; drafts carry null */
  number: number | null;
  status: RevisionStatus;
  source: RevisionSource;
  summary: string;
  /** hash of the content, so validation reports can tell when they are stale */
  contentHash: string;
  /**
   * Counts plus the hashes of each half: the T-Box and the A-Box are versioned
   * separately, so a schema change and a data change are told apart.
   */
  stats: {
    modules: number;
    classes: number;
    individuals: number;
    assertions: number;
    tboxHash?: string;
    aboxHash?: string;
    acceptedIndividuals?: number;
    acceptedAssertions?: number;
    candidateFacts?: number;
  };
  /** derived when listed: T-Box version this revision carries (increments only when the T-Box changes) */
  tboxVersion?: number | null;
  /** derived when listed: A-Box version (increments only when the individuals change) */
  aboxVersion?: number | null;
  /** derived when listed: what changed relative to the parent */
  scope?: RevisionScope;
  runId?: string;
  createdBy: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  committedAt?: ISODate;
}

export interface RevisionWithContent extends OntologyRevision {
  content: RevisionContent;
}

export interface RevisionDiff {
  modules: { added: string[]; removed: string[]; changed: string[] };
  individuals: {
    added: string[];
    removed: string[];
    changed: { id: string; changes: string[] }[];
  };
}

/* ───────────────────────── runs ───────────────────────── */

export type RunStatus = "paused" | "queued" | "running" | "awaiting_answers" | "ready_for_review" | "failed" | "cancelled";
export type RunMode = "automatic" | "interactive";
/** extraction fills the A-Box from a T-Box; induction builds a T-Box from the documents */
export type RunKind = "extraction" | "induction" | "alignment";

export type RunStepKind =
  | "alignment_retrieve"
  | "alignment_verify"
  // extraction
  | "summary"
  | "chunk"
  | "vision"
  | "qa"
  | "resolve"
  | "ground"
  | "verify"
  // induction
  | "terms"
  | "relations"
  | "merge"
  | "axioms"
  | "reuse"
  | "pitfalls"
  | "finalize";

export interface RunStep {
  /** Topic membership and request batching, recorded separately. Indices are zero-based. */
  topic?: { index: number; count: number; batch: number; batches: number };
  /** Numerical evidence captured during planning, never recomputed for display. */
  technical?: TechnicalResult[];
  /** unique within the run: `chunk:<docId>:<ordinal>`, `vision:<docId>`, `qa:<round>`, `terms:<cluster>`, `finalize` … */
  key: string;
  kind: RunStepKind;
  documentId?: string;
  chunkId?: string;
  /** induction: the chunks of one topic cluster */
  chunkIds?: string[];
  label: string;
}

/** A term the extractor needed that the ontology has no place for (the improvement loop). */
export interface UnmatchedTerm {
  kind: "class" | "objectProperty" | "dataProperty";
  name: string;
  definition: string;
  /** closest existing term: superclass for a class, domain/range for a property */
  parent?: string;
  domain?: string;
  range?: string;
  quote?: string;
  documentId?: string;
  chunkId?: string;
  /** the fact itself, so it can be replayed once the term exists: the individual it is about … */
  subjectId?: string;
  subjectLabel?: string;
  /** … and its value (data property) or the individual it points at (object property) */
  value?: string;
  objectId?: string;
}

/** Unmatched terms grouped by meaning, offered as T-Box additions after a run. */
export interface TermProposal {
  id: string;
  kind: UnmatchedTerm["kind"];
  name: string;
  definition: string;
  parent?: string;
  domain?: string;
  range?: string;
  /** how many times extraction asked for it */
  count: number;
  /** other names the same idea came under */
  variants: string[];
  examples: { quote: string; documentId?: string }[];
  status: "open" | "accepted" | "dismissed";
  /**
   * How the idea relates to the existing ontology: a genuinely new term, another
   * name for an existing one (added as a label, not a class), a specialisation
   * of an existing class, or a clash with a term of another kind.
   */
  relation?: "new" | "synonym" | "specialization" | "conflict";
  /** the closest existing term and its similarity */
  match?: { uri: string; score: number };
  /** facts waiting for this term (ExtractionRun.pendingFacts ids) and the chunks they came from */
  pendingFactIds?: string[];
  chunkIds?: string[];
}

export interface RunOptions {
  /** Explicit Codex CLI reasoning setting; absent uses the model default. */
  reasoningEffort?: string;
  tokenization?: TokenChunkSettings;
  /** false recomputes extraction/summaries so fresh research measurements can be captured */
  reuseCache?: boolean;
  /** merge into the base revision's A-Box (true) or replace it (false) */
  incremental: boolean;
  /** skip chunks unrelated to the ontology before paying for extraction */
  relevanceScreen: boolean;
  /** entity resolution with LLM confirmation of ambiguous pairs */
  resolveEntities: boolean;
  /** entailment-score every claim against its quote */
  verifyEvidence: boolean;
  /** grounding sources consulted for this run */
  grounding: string[];
  /* ── ablation switches (research testbed); absent = the deployment default ── */
  /** T-Box rendering in extraction prompts */
  promptStyle?: "code" | "tree";
  /** per-chunk schema retrieval: only for large T-Boxes (auto), never (off), or always (force) */
  schemaRetrieval?: "auto" | "off" | "force";
  /** classes and properties retrieved per chunk */
  schemaTopK?: number;
  /** induction: steer by purpose, scope and competency questions (default true) */
  cqGuided?: boolean;
  /** induction: propose disjointness, restrictions, inverses (kept only if the reasoner accepts them; default true) */
  inductionAxioms?: boolean;
  /** induction: reasoner + pitfall repair rounds (default true) */
  repair?: boolean;
  /** induction: drop terms whose supporting quote cannot be found in the documents (default false: flag only) */
  strictGrounding?: boolean;
  /** extraction: how new facts are reviewed — trusted when evidence passes (auto-accept, default), all candidates (flag), or no review (off) */
  evidenceGate?: "off" | "flag" | "auto-accept";
  /** extraction: only these chunks (re-extraction after the ontology gained terms) */
  onlyChunks?: string[];
}

/**
 * Everything that shaped a run's output, frozen when the run is created, so a
 * result can be traced to its configuration and ablations compare like with like.
 */
export interface RunConfig {
  promptVersion: string;
  promptStyle: "code" | "tree";
  schemaRetrieval: "auto" | "off" | "force";
  schemaTopK: number;
  schemaMinTerms: number;
  relevanceThreshold: number;
  nliReviewThreshold: number;
  /** embedder id, or null without embeddings */
  embedder: string | null;
  /** NLI backend choice */
  nli: string;
  /** fact review: gate and the entailment score at which a fact is trusted */
  evidenceGate?: "off" | "flag" | "auto-accept";
  acceptAt?: number;
}

export interface RunCost {
  /** what the estimate said before the run started */
  estimatedUsd: number | null;
  /** priced from recorded token usage */
  actualUsd: number | null;
  /** false when the model has no known price */
  priced: boolean;
}

export interface RunLease {
  holder: string;
  expiresAt: ISODate;
}

export interface ExtractionRun {
  requirementsSnapshot?: {
    version: number;
    requirements: Requirements;
    purpose: string;
    scope: string;
  };
  alignment?: AlignmentRunContext;
  /** Alignment tokens reported by failed calls without a successful checkpoint. */
  uncheckpointedUsage?: { inputTokens: number; outputTokens: number };
  corpus?: CorpusRunContext;
  /** Prior build copied into preparation; its recorded inputs and result stay unchanged. */
  sourceRunId?: string;
  id: string;
  projectId: string;
  ownerId: string;
  status: RunStatus;
  /** absent on runs created before induction existed = "extraction" */
  kind?: RunKind;
  mode: RunMode;
  options?: RunOptions;
  /** absent on runs created before configurations were recorded */
  config?: RunConfig;
  cost?: RunCost;
  /** improvement loop: proposed T-Box additions gathered from unmatched terms */
  proposals?: TermProposal[];
  /** facts the ontology could not express yet, kept for replay once their term is added */
  pendingFacts?: PendingFact[];
  /** steps skipped by the relevance screen or answered from the result cache */
  skipped?: number;
  cached?: number;
  /** pinned inputs */
  documentIds: string[];
  documentChecksums: Record<string, string>;
  baseRevisionId: string | null;
  provider: string;
  model: string;
  settings: { vision: string[] };
  /** planned steps; checkpoints are keyed by RunStep.key */
  steps: RunStep[];
  completedSteps: number;
  /** consecutive failures of the current step (bounded retry) */
  attempts: number;
  lease: RunLease | null;
  error?: string;
  usage: { inputTokens: number; outputTokens: number };
  questions: ClarifyQuestion[];
  clarifications: Clarification[];
  qaRound: number;
  /** interactive mode: the user finished answering (or the model ran out of questions) */
  qaDone: boolean;
  /** the draft revision produced when the run reached ready_for_review */
  resultRevisionId?: string;
  notes: string[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** Run as returned to the client: adds derived flags. */
export interface RunView extends ExtractionRun {
  /** Successful checkpoint keys; steps in a parallel batch may finish out of order. */
  completedStepKeys?: string[];
  /** running, but nobody holds the lease — the tab that drove it went away */
  resumable: boolean;
  nextStep: RunStep | null;
}

export interface JobCheckpoint {
  trace?: StageTrace;
  runId: string;
  key: string;
  ordinal: number;
  abox: ABoxResult;
  notes: string[];
  /** clarification rounds: the questions the model asked */
  questions?: ClarifyQuestion[];
  /** extraction: terms the ontology had no place for */
  unmatched?: UnmatchedTerm[];
  /** resolve steps: merge candidates found */
  candidates?: MergeCandidate[];
  /** summary steps: the document summary sent with each of its chunks */
  summary?: string;
  /** induction steps: the partial T-Box (Turtle) or findings this step produced */
  payload?: unknown;
  /** how the step was satisfied without a full model call */
  via?: "cache" | "screen";
  usage: { inputTokens: number; outputTokens: number };
  createdAt: ISODate;
}

/* ───────────────────────── validation ───────────────────────── */

export interface CqResult {
  question: string;
  sparql: string;
  columns: string[];
  rows: Record<string, string>[];
  truncated?: boolean;
  error?: string;
}

export interface StoredValidationReport {
  shaclExecution?: ShaclExecution;
  ontologyIssues?: OntologyIssue[];
  execution?: {
    durationMs: number;
    reviewPolicy: string;
    individuals: number;
    modules: number;
    ontologyMs: number;
    schemaMs: number;
    reasoningMs: number;
    cqMs: number;
  };
  id: string;
  projectId: string;
  revisionId: string;
  /** content hash of the revision when the report was produced */
  contentHash: string;
  schemaIssues: AboxIssue[];
  shaclIssues: AboxIssue[];
  cqResults: CqResult[];
  /** share of competency questions with a non-empty answer (null when none have a stored query) */
  cqPassRate?: number | null;
  /** clashes and unsatisfiable classes found by the reasoner (absent on older reports) */
  reasonerIssues?: AboxIssue[];
  reasoner?: ReasonerSummary;
  counts: { errors: number; warnings: number };
  createdAt: ISODate;
}

/** What a reasoning pass over a revision found, for the report header. */
export interface ReasonerSummary {
  tier: "rl" | "dl";
  reasoner: string;
  consistent: boolean;
  unsatisfiable: number;
  clashes: number;
  /** individuals that gained a type by inference */
  inferredTypes: number;
  inferredLinks: number;
  /** what this tier could not check */
  incomplete: string[];
  ms: number;
}

/* ───────────────────────── assistant ───────────────────────── */

export type AssistantMode = "ask" | "propose";

export interface Citation {
  /** marker used in the answer text, e.g. "C1" */
  ref: string;
  evidence: EvidenceRef;
}

export interface ProposalSummary {
  draftRevisionId: string;
  diff: RevisionDiff;
  validation: { before: { errors: number; warnings: number }; after: { errors: number; warnings: number } };
  applied?: boolean;
}

/** How the assistant retrieved context for a question (B8). */
export type AnswerRoute = "single" | "multi" | "aggregate";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  mode: AssistantMode;
  content: string;
  citations?: Citation[];
  entities?: string[];
  proposal?: ProposalSummary;
  /** ask mode: which retrieval route answered it */
  route?: AnswerRoute;
  /** aggregate route: the SPARQL that produced the figures, and its first rows */
  query?: { sparql: string; columns: string[]; rows: Record<string, string>[]; attempts: number; error?: string };
  /** ask mode (graph chat): the queries, tool calls and evidence graph behind the answer */
  agent?: AgentTrace;
  createdAt: ISODate;
}

export interface Conversation {
  id: string;
  projectId: string;
  revisionId: string | null;
  title: string;
  messages: ConversationMessage[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ───────────────────────── archive ───────────────────────── */

export const ARCHIVE_FORMAT = "ontolab-archive";
export const ARCHIVE_VERSION = 2;

export interface ProjectArchive {
  sourceProjectId?: string;
  corpora?: ProjectArchive[];
  runs?: { run: ExtractionRun; checkpoints: JobCheckpoint[]; inputs: unknown | null }[];
  reports?: StoredValidationReport[];
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exportedAt: ISODate;
  project: Pick<Project, "name" | "purpose" | "scope" | "competencyQuestions" | "settings">;
  documents: (Pick<ProjectDocument, "id" | "name" | "mediaType" | "kind" | "checksum" | "preprocessing" | "variantOf"> & {
    base64: string;
    metadata?: ProjectDocument;
    frozen?: Pick<DocumentText, "text" | "pages" | "sections" | "tables" | "sourceSpans"> & { chunks: DocumentChunk[] };
  })[];
  revisions: (Pick<OntologyRevision, "id" | "parentId" | "number" | "status" | "source" | "summary" | "createdAt" | "committedAt"> & {
    content: RevisionContent;
  })[];
  currentRevisionId: string | null;
  conversations: Pick<Conversation, "title" | "messages" | "createdAt">[];
}

/* ───────────────────────── server config / usage ───────────────────────── */

export interface Limits {
  maxFileBytes: number;
  maxDocumentsPerProject: number;
  maxSourcesPerCorpus?: number;
  storageQuotaBytes: number;
  maxGraphNodes: number;
}

export interface ClientConfig {
  auth: { mode: "local" };
  limits: Limits;
  /** what this server can do beyond the basics */
  features?: {
    /** runs advance on the server; the browser need not stay open */
    worker: boolean;
    /** the Docling parser is configured (PPTX, XLSX, images, OCR) */
    docling: boolean;
    embeddings: string;
    nli: string;
    /** grounding sources usable on this server */
    grounding: string[];
    /** vocabularies consulted for term reuse */
    reuse: string[];
    /** a GraphDB server is configured (publish revisions, chat over GraphDB) */
    graphdb?: boolean;
    /** reasoning tier validation uses: in-process OWL 2 RL, the DL sidecar, or none */
    reasoner?: "rl" | "dl" | "off";
  };
}

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number;
  projects: number;
  documents: number;
}
