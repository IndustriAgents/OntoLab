// Typed client for the project API. Requests reference persisted ids; nothing
// here re-sends whole documents or graphs except a draft's own content.

import type {
  ClientConfig,
  Conversation,
  ConversationMessage,
  CqResult,
  DocumentText,
  OntologyRevision,
  Project,
  ProjectDocument,
  ProjectSummary,
  RevisionContent,
  RevisionDiff,
  RevisionWithContent,
  Requirements,
  RunKind,
  RunMode,
  RunOptions,
  RunView,
  TermProposal,
  ReuseSuggestion,
  SemanticFinding,
  ImpactReport,
  AnswerRoute,
  StorageUsage,
  StoredValidationReport,
  GraphDbSettings,
} from "../types/project";
import type { GraphDbStatus, GraphSource } from "../types/graphChat";
import type { DraftCheck } from "./ontology/changeCheck";
import type { AlignmentSetup, AlignmentReviewInput } from "../types/alignment";
import type { EmbeddingProfile, ChunkExperiment, ChunkSettings, RunResearch } from "../types/research";
import { request, download, rawRequest } from "./http";

const p = (pid: string) => `api/projects/${encodeURIComponent(pid)}`;

export interface ReportView extends StoredValidationReport {
  stale: boolean;
}

/**
 * Confirmations a commit may need: open review candidates (`acknowledged`, the
 * accepted-only policy) and validation warnings the change introduces
 * (`acknowledgedWarnings`). Errors cannot be acknowledged.
 */
export interface CommitAck {
  acknowledged?: boolean;
  acknowledgedWarnings?: boolean;
  expectedHash?: string;
}

export interface CqAnswer {
  sparql: string;
  explanation: string;
  columns: string[];
  rows: Record<string, string>[];
  truncated?: boolean;
  error?: string;
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  purpose: string;
  scope: string;
  stories: string[];
  cqs: string[];
  classes: number;
  properties: number;
}

export interface RunEstimate {
  steps: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  priced: boolean;
  screened: number;
  cached: number;
}

export interface Pitfall {
  code: string;
  title: string;
  severity: "critical" | "important" | "minor";
  subject: string;
  message: string;
  fix: string;
}

export interface RunInput {
  baseRevisionId?: string | null;
  sourceRunId?: string;
  kind?: RunKind;
  documentIds: string[];
  mode: RunMode;
  provider: string;
  model: string;
  vision?: string[];
  options?: Partial<RunOptions>;
}

import type { AlignmentEstimate } from "../types/alignment";

export const api = {
  config: () => request<ClientConfig>("GET", "api/config"),
  usage: () => request<StorageUsage>("GET", "api/usage"),

  /* projects */
  listProjects: () => request<{ projects: ProjectSummary[] }>("GET", "api/projects").then((r) => r.projects),
  createProject: (body: Partial<Pick<Project, "name" | "purpose" | "scope" | "competencyQuestions">>) =>
    request<{ project: Project }>("POST", "api/projects", { body }).then((r) => r.project),
  createSample: () => request<{ project: Project }>("POST", "api/projects/sample").then((r) => r.project),
  listTemplates: () => request<{ templates: TemplateInfo[] }>("GET", "api/templates").then((r) => r.templates),
  applyTemplate: (pid: string, templateId: string) =>
    request<{ revision: OntologyRevision }>("POST", `${p(pid)}/templates/${encodeURIComponent(templateId)}`).then((r) => r.revision),
  createFromTemplate: (templateId: string, name?: string) =>
    request<{ project: Project }>("POST", "api/projects/template", { body: { templateId, name } }).then((r) => r.project),
  convertRdf: (name: string, text: string) =>
    request<{ turtle: string; format: string; triples: number }>("POST", "api/convert-rdf", { body: { name, text } }),

  /* requirements (user stories → competency questions) */
  suggestStory: (pid: string, body: { story: string; otherStories: string[]; provider: string; model: string }, signal?: AbortSignal) =>
    request<{ story: string }>("POST", `${p(pid)}/requirements/suggest-story`, { body, signal }),
  restoreRequirements: (pid: string, version: number) =>
    request<{ project: Project }>("POST", `${p(pid)}/requirements/versions/${version}/restore`).then((r) => r.project),
  saveRequirements: (pid: string, req: Requirements) =>
    request<{ project: Project }>("PUT", `${p(pid)}/requirements`, { body: req }).then((r) => r.project),
  generateCqs: (pid: string, body: { stories?: string[]; provider: string; model: string }, signal?: AbortSignal) =>
    request<{ project: Project }>("POST", `${p(pid)}/requirements/generate`, { body, signal }).then((r) => r.project),
  translateCq: (pid: string, cqId: string, body: { provider: string; model: string }, signal?: AbortSignal) =>
    request<{ project: Project; answer: CqAnswer }>("POST", `${p(pid)}/requirements/${encodeURIComponent(cqId)}/translate`, {
      body,
      signal,
    }),
  checkAnswerability: (pid: string, body: { provider?: string; model?: string; refresh?: boolean }, signal?: AbortSignal) =>
    request<{ project: Project }>("POST", `${p(pid)}/requirements/answerability`, { body, signal }).then((r) => r.project),
  generateCqsFromTBox: (pid: string, body: { provider: string; model: string; max?: number }, signal?: AbortSignal) =>
    request<{ project: Project }>("POST", `${p(pid)}/requirements/generate-from-tbox`, { body, signal }).then((r) => r.project),
  retranslateStale: (pid: string, body: { provider?: string; model?: string }, signal?: AbortSignal) =>
    request<{ project: Project; rewritten: number; translated: number; stale: string[] }>(
      "POST",
      `${p(pid)}/requirements/retranslate-stale`,
      { body, signal },
    ),
  importArchive: (file: Blob) => request<{ project: Project }>("POST", "api/projects/import", { raw: file }).then((r) => r.project),
  getProject: (pid: string) => request<{ project: Project }>("GET", p(pid)).then((r) => r.project),
  updateProject: (
    pid: string,
    body: Partial<Pick<Project, "name" | "purpose" | "scope" | "competencyQuestions" | "settings" | "archived">>,
  ) => request<{ project: Project }>("PATCH", p(pid), { body }).then((r) => r.project),
  deleteProject: (pid: string) => request<{ ok: true }>("DELETE", p(pid)),
  downloadArchive: (pid: string) => download(`${p(pid)}/archive`, "project.ontolab.json.gz"),

  /* documents */
  listDocuments: (pid: string) => request<{ documents: ProjectDocument[] }>("GET", `${p(pid)}/documents`).then((r) => r.documents),
  uploadDocument: (pid: string, file: File) =>
    request<{ document: ProjectDocument }>("POST", `${p(pid)}/documents`, {
      raw: file,
      headers: { "x-file-name": encodeURIComponent(file.name) },
    }).then((r) => r.document),
  documentFile: async (pid: string, did: string) => (await rawRequest("GET", `${p(pid)}/documents/${did}/file`)).blob(),
  reprocessDocument: (pid: string, did: string) =>
    request<{ document: ProjectDocument }>("POST", `${p(pid)}/documents/${did}/reprocess`).then((r) => r.document),
  documentText: (pid: string, did: string) => request<DocumentText>("GET", `${p(pid)}/documents/${did}/text`),
  chunkModels: (pid: string) => request<{ embeddings: EmbeddingProfile[] }>("GET", `${p(pid)}/research/chunk-models`),
  chunkDefaults: (pid: string) => request<ChunkSettings>("GET", `${p(pid)}/research/chunking`),
  previewChunks: (pid: string, did: string, settings: ChunkSettings) =>
    request<ChunkExperiment>("POST", `${p(pid)}/documents/${did}/chunk-preview`, { body: settings }),
  saveChunkVariant: (pid: string, did: string, settings: ChunkSettings, textHash: string) =>
    request<{ document: ProjectDocument }>("POST", `${p(pid)}/documents/${did}/chunk-variant`, { body: { settings, textHash } }).then(
      (r) => r.document,
    ),
  runResearch: (pid: string, id: string) => request<RunResearch>("GET", `${p(pid)}/runs/${id}/research`),
  documentFileUrl: async (pid: string, did: string) => {
    const res = await rawRequest("GET", `${p(pid)}/documents/${did}/file`);
    return URL.createObjectURL(await res.blob());
  },
  retryDocument: (pid: string, did: string) =>
    request<{ document: ProjectDocument }>("POST", `${p(pid)}/documents/${did}/retry`).then((r) => r.document),
  removeDocument: (pid: string, did: string) => request<{ ok: true }>("DELETE", `${p(pid)}/documents/${did}`),

  /* revisions */
  listRevisions: (pid: string) => request<{ revisions: OntologyRevision[] }>("GET", `${p(pid)}/revisions`).then((r) => r.revisions),
  getRevision: (pid: string, rid: string) =>
    request<{ revision: RevisionWithContent }>("GET", `${p(pid)}/revisions/${rid}`).then((r) => r.revision),
  createDraft: (pid: string, content: RevisionContent, summary: string, source: "manual" | "import" | "ontology" = "manual") =>
    request<{ revision: OntologyRevision }>("POST", `${p(pid)}/revisions`, { body: { content, summary, source } }).then((r) => r.revision),
  saveDraft: (pid: string, rid: string, content: RevisionContent, summary?: string, expectedHash?: string) =>
    request<{ revision: OntologyRevision }>("PUT", `${p(pid)}/revisions/${rid}`, { body: { content, summary, expectedHash } }).then(
      (r) => r.revision,
    ),
  discardDraft: (pid: string, rid: string) => request<{ ok: true }>("DELETE", `${p(pid)}/revisions/${rid}`),
  commit: (pid: string, rid: string, ack: CommitAck = {}) =>
    request<{ revision: OntologyRevision; report?: ReportView | null }>("POST", `${p(pid)}/revisions/${rid}/commit`, { body: ack }).then(
      (r) => r.revision,
    ),
  commitWithReport: (pid: string, rid: string, ack: CommitAck = {}) =>
    request<{ revision: OntologyRevision; report: ReportView | null }>("POST", `${p(pid)}/revisions/${rid}/commit`, { body: ack }),
  /** validate a draft as a change to its parent (schema findings introduced/resolved + reasoner verdict) */
  check: (pid: string, rid: string) => request<{ check: DraftCheck }>("POST", `${p(pid)}/revisions/${rid}/check`).then((r) => r.check),
  rebase: (pid: string, rid: string) =>
    request<{ revision: OntologyRevision }>("POST", `${p(pid)}/revisions/${rid}/rebase`).then((r) => r.revision),
  restore: (pid: string, rid: string) =>
    request<{ revision: OntologyRevision }>("POST", `${p(pid)}/revisions/${rid}/restore`).then((r) => r.revision),
  diff: (pid: string, rid: string, from?: string | null) =>
    request<{ diff: RevisionDiff }>("GET", `${p(pid)}/revisions/${rid}/diff${from ? `?from=${encodeURIComponent(from)}` : ""}`).then(
      (r) => r.diff,
    ),
  validate: (pid: string, rid: string, queries: { question: string; sparql?: string }[]) =>
    request<{ report: ReportView }>("POST", `${p(pid)}/revisions/${rid}/validate`, { body: { queries } }).then((r) => r.report),
  report: (pid: string, rid: string) =>
    request<{ report: ReportView | null }>("GET", `${p(pid)}/revisions/${rid}/report`).then((r) => r.report),
  downloadReport: (pid: string, rid: string, format: "json" | "md") =>
    download(`${p(pid)}/revisions/${rid}/report/download?format=${format}`, `validation.${format}`),
  askCq: (pid: string, rid: string, question: string, provider: string, model: string, signal?: AbortSignal) =>
    request<CqAnswer>("POST", `${p(pid)}/revisions/${rid}/cq`, { body: { question, provider, model }, signal }),
  runSparql: (pid: string, rid: string, sparql: string) =>
    request<Omit<CqResult, "question" | "sparql">>("POST", `${p(pid)}/revisions/${rid}/sparql`, { body: { sparql } }),
  downloadTurtle: (
    pid: string,
    rid: string,
    scope: "abox" | "tbox" | "combined",
    acknowledged: boolean,
    provenance: "none" | "source" | "reified" = "source",
  ) => download(`${p(pid)}/revisions/${rid}/export?scope=${scope}&provenance=${provenance}${acknowledged ? "&ack=1" : ""}`, `${scope}.ttl`),

  /* ontology review and entity resolution */
  pitfalls: (pid: string, rid: string) =>
    request<{ pitfalls: Pitfall[] }>("GET", `${p(pid)}/revisions/${rid}/pitfalls`).then((r) => r.pitfalls),
  reuseSuggestions: (pid: string, rid: string) =>
    request<{ suggestions: ReuseSuggestion[] }>("GET", `${p(pid)}/revisions/${rid}/reuse`).then((r) => r.suggestions),
  semanticReview: (pid: string, rid: string) =>
    request<{ findings: SemanticFinding[] | null }>("GET", `${p(pid)}/revisions/${rid}/semantic-review`).then((r) => r.findings),
  runSemanticReview: (pid: string, rid: string, body: { provider: string; model: string }, signal?: AbortSignal) =>
    request<{ findings: SemanticFinding[] }>("POST", `${p(pid)}/revisions/${rid}/semantic-review`, { body, signal }).then(
      (r) => r.findings,
    ),
  acceptReuse: (pid: string, rid: string, body: { term: string; iri: string; kind: "class" | "property" }) =>
    request<{ revision: OntologyRevision }>("POST", `${p(pid)}/revisions/${rid}/reuse`, { body }).then((r) => r.revision),
  align: (
    pid: string,
    rid: string,
    body: {
      sourceModules: string[];
      targetModules: string[];
      provider?: string;
      model?: string;
      matchers?: { lexical?: boolean; semantic?: boolean; structural?: boolean };
      maxSource?: number | null;
      expectedHash?: string;
    },
    signal?: AbortSignal,
  ) => request<{ revision: OntologyRevision }>("POST", `${p(pid)}/revisions/${rid}/align`, { body, signal }).then((r) => r.revision),
  estimateAlignment: (pid: string, rid: string, setup: AlignmentSetup, expectedHash?: string, signal?: AbortSignal) =>
    request<{ estimate: AlignmentEstimate }>("POST", `${p(pid)}/revisions/${rid}/align/estimate`, {
      body: { setup, expectedHash },
      signal,
    }).then((r) => r.estimate),
  startAlignment: (pid: string, rid: string, setup: AlignmentSetup, expectedHash?: string) =>
    request<{ run: RunView }>("POST", `${p(pid)}/revisions/${rid}/align/runs`, { body: { setup, expectedHash } }).then((r) => r.run),
  pauseRun: (pid: string, runId: string) => request<{ run: RunView }>("POST", `${p(pid)}/runs/${runId}/pause`).then((r) => r.run),
  saveAlignmentSetup: (pid: string, rid: string, setup: AlignmentSetup, expectedHash?: string) =>
    request<{ revision: OntologyRevision }>("POST", `${p(pid)}/revisions/${rid}/align/setup`, { body: { setup, expectedHash } }).then(
      (r) => r.revision,
    ),
  reviewAlignment: (pid: string, rid: string, body: AlignmentReviewInput) =>
    request<{ revision: OntologyRevision }>("POST", `${p(pid)}/revisions/${rid}/align/review`, { body }).then((r) => r.revision),
  acceptAlignment: (pid: string, rid: string, ids: string[], force = false) =>
    request<{ revision: OntologyRevision }>("POST", `${p(pid)}/revisions/${rid}/align/accept`, { body: { ids, force } }).then(
      (r) => r.revision,
    ),
  decideMerges: (
    pid: string,
    rid: string,
    body: { decisions?: { id: string; decision: "merge" | "distinct"; keep?: string }[]; applyRecommended?: boolean },
  ) => request<{ revision: OntologyRevision }>("POST", `${p(pid)}/revisions/${rid}/merges`, { body }).then((r) => r.revision),

  /* runs */
  listRuns: (pid: string) => request<{ runs: RunView[] }>("GET", `${p(pid)}/runs`).then((r) => r.runs),
  getRun: (pid: string, runId: string) => request<{ run: RunView }>("GET", `${p(pid)}/runs/${runId}`).then((r) => r.run),
  createRun: (pid: string, body: RunInput) => request<{ run: RunView }>("POST", `${p(pid)}/runs`, { body }).then((r) => r.run),
  estimateRun: (pid: string, body: RunInput, signal?: AbortSignal) =>
    request<{ estimate: RunEstimate }>("POST", `${p(pid)}/runs/estimate`, { body, signal }).then((r) => r.estimate),
  decideProposals: (pid: string, runId: string, accept: string[], dismiss: string[] = []) =>
    request<{
      revision: OntologyRevision | null;
      committed: boolean;
      issues: string[];
      impact: ImpactReport | null;
      reextract: { chunkIds: string[]; documentIds: string[]; pendingFacts: number } | null;
      proposals: TermProposal[];
    }>("POST", `${p(pid)}/runs/${runId}/proposals`, { body: { accept, dismiss } }),
  replayRun: (pid: string, runId: string) =>
    request<{ revision: OntologyRevision; replayed: number; skipped: number }>("POST", `${p(pid)}/runs/${runId}/replay`),
  advance: (pid: string, runId: string) => request<{ run: RunView; waitMs?: number }>("POST", `${p(pid)}/runs/${runId}/advance`),
  cancelRun: (pid: string, runId: string) => request<{ run: RunView }>("POST", `${p(pid)}/runs/${runId}/cancel`).then((r) => r.run),
  retryRun: (pid: string, runId: string) => request<{ run: RunView }>("POST", `${p(pid)}/runs/${runId}/retry`).then((r) => r.run),
  answer: (pid: string, runId: string, answers: Record<string, string>, finish: boolean) =>
    request<{ run: RunView }>("POST", `${p(pid)}/runs/${runId}/answers`, { body: { answers, finish } }).then((r) => r.run),

  /* graph chat and GraphDB */
  graphdbStatus: () => request<{ graphdb: GraphDbStatus }>("GET", "api/graphdb").then((r) => r.graphdb),
  publishGraphDb: (pid: string, rid: string, body: { repository?: string; graph?: string; acknowledged?: boolean }) =>
    request<{ graphdb: GraphDbSettings }>("POST", `${p(pid)}/revisions/${encodeURIComponent(rid)}/graphdb`, { body }).then(
      (r) => r.graphdb,
    ),
  chatSuggestions: (pid: string, source: GraphSource, rev?: string) =>
    request<{ suggestions: string[] }>(
      "GET",
      `${p(pid)}/assistant/suggestions?source=${source}${rev ? `&rev=${encodeURIComponent(rev)}` : ""}`,
    ).then((r) => r.suggestions),

  /* assistant */
  listConversations: (pid: string) =>
    request<{ conversations: Conversation[] }>("GET", `${p(pid)}/conversations`).then((r) => r.conversations),
  deleteConversation: (pid: string, cid: string) => request<{ ok: true }>("DELETE", `${p(pid)}/conversations/${cid}`),
  ask: (
    pid: string,
    body: { question: string; conversationId?: string; revisionId?: string; provider: string; model: string; route?: AnswerRoute },
    signal?: AbortSignal,
  ) => request<{ conversation: Conversation; message: ConversationMessage }>("POST", `${p(pid)}/assistant/ask`, { body, signal }),
  propose: (
    pid: string,
    body: { instruction: string; conversationId?: string; revisionId?: string; provider: string; model: string },
    signal?: AbortSignal,
  ) => request<{ conversation: Conversation; message: ConversationMessage }>("POST", `${p(pid)}/assistant/propose`, { body, signal }),
};

/** Query keys, in one place so invalidation stays consistent. */
export const qk = {
  config: ["config"] as const,
  usage: ["usage"] as const,
  projects: ["projects"] as const,
  project: (pid: string) => ["project", pid] as const,
  documents: (pid: string) => ["documents", pid] as const,
  documentText: (pid: string, did: string) => ["documentText", pid, did] as const,
  revisions: (pid: string) => ["revisions", pid] as const,
  revision: (pid: string, rid: string) => ["revision", pid, rid] as const,
  report: (pid: string, rid: string) => ["report", pid, rid] as const,
  check: (pid: string, rid: string, contentHash: string) => ["check", pid, rid, contentHash] as const,
  runs: (pid: string) => ["runs", pid] as const,
  run: (pid: string, runId: string) => ["run", pid, runId] as const,
  conversations: (pid: string) => ["conversations", pid] as const,
  templates: ["templates"] as const,
  pitfalls: (pid: string, rid: string, hash: string) => ["pitfalls", pid, rid, hash] as const,
};
