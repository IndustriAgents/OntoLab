// Repository contracts. Services talk to these interfaces only; the local
// adapter (JSON files on disk) and the Postgres adapter both implement them.
//
// A `UserStore` is always bound to one authenticated user. Ownership is part of
// the binding rather than a parameter every call has to remember: the local
// adapter partitions files by user id, and the Postgres adapter scopes queries
// using a transaction-local identity and row-level security.

import type {
  Conversation,
  DocumentChunk,
  ExtractionRun,
  JobCheckpoint,
  OntologyRevision,
  PageSpan,
  Project,
  ProjectDocument,
  ProjectSettings,
  RevisionContent,
  RevisionWithContent,
  SectionSpan,
  StorageUsage,
  TableSpan,
  StoredValidationReport,
  User,
} from "../../src/types/project.ts";
import type { ConnectionRepo } from "../connections/types.ts";
import type { Evaluation, EvaluationSummary } from "../../src/types/evaluation.ts";

export interface EvaluationRepo {
  list(projectId: string): Promise<EvaluationSummary[]>;
  get(projectId: string, id: string): Promise<Evaluation | null>;
  /** Insert if absent, or replace only at the expected version. */
  put(value: Evaluation, expectedVersion: number | null): Promise<void>;
}

export interface ProjectRepo {
  /** Atomic source-membership/configuration update, including across processes. */
  compareAndSwapSettings(
    id: string,
    expected: ProjectSettings,
    next: ProjectSettings,
    now: string,
    competencyQuestions?: string[],
  ): Promise<Project>;
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(project: Project): Promise<Project>;
  update(id: string, patch: Partial<Omit<Project, "id" | "ownerId" | "createdAt">>): Promise<Project>;
  /** removes the project and everything under it (documents, revisions, runs, blobs) */
  delete(id: string): Promise<void>;
}

export interface StoredDocumentText {
  text: string;
  pages: PageSpan[];
  sections?: SectionSpan[];
  tables?: TableSpan[];
  sourceSpans?: { start: number; end: number; path: string }[];
}

export interface ChunkHit extends DocumentChunk {
  score: number;
}

export interface DocumentRepo {
  /** Atomically claim a queued/expired parse. Optional for legacy adapters. */
  claimProcessing?(
    projectId: string,
    id: string,
    holder: string,
    expiresAt: string,
    now: string,
    unchunked?: boolean,
  ): Promise<ProjectDocument | null>;
  /** Publish only if this worker still owns the lease; null after deletion/reclaim. */
  finishProcessing?(
    projectId: string,
    id: string,
    holder: string,
    patch: Partial<ProjectDocument>,
    output?: { text: StoredDocumentText; chunks: DocumentChunk[] },
  ): Promise<ProjectDocument | null>;

  list(projectId: string): Promise<ProjectDocument[]>;
  get(projectId: string, id: string): Promise<ProjectDocument | null>;
  create(doc: ProjectDocument): Promise<ProjectDocument>;
  update(projectId: string, id: string, patch: Partial<ProjectDocument>): Promise<ProjectDocument>;
  delete(projectId: string, id: string): Promise<void>;
  /** replaces the extracted text + chunks of a document */
  putText(projectId: string, id: string, text: StoredDocumentText, chunks: DocumentChunk[]): Promise<void>;
  getText(projectId: string, id: string): Promise<StoredDocumentText | null>;
  chunks(projectId: string, documentIds?: string[]): Promise<DocumentChunk[]>;
  /** full-text retrieval over a project's chunks */
  search(projectId: string, query: string, limit: number): Promise<ChunkHit[]>;
}

export interface RevisionRepo {
  list(projectId: string): Promise<OntologyRevision[]>;
  get(projectId: string, id: string): Promise<RevisionWithContent | null>;
  create(rev: OntologyRevision, content: RevisionContent): Promise<OntologyRevision>;
  /** drafts only — committed revisions are immutable */
  updateDraft(
    projectId: string,
    id: string,
    meta: Pick<OntologyRevision, "summary" | "contentHash" | "stats" | "updatedAt"> & { parentId?: string | null },
    content: RevisionContent,
    expectedHash?: string,
  ): Promise<OntologyRevision>;
  /**
   * Atomically: check that the project's current revision is still
   * `expectedParentId`, number the draft, mark it committed and make it current.
   * Throws ConflictError when another commit got there first.
   */
  commit(projectId: string, id: string, expectedParentId: string | null, now: string, expectedHash?: string): Promise<OntologyRevision>;
  delete(projectId: string, id: string): Promise<void>;
}

export interface RunRepo {
  list(projectId: string): Promise<ExtractionRun[]>;
  get(projectId: string, id: string): Promise<ExtractionRun | null>;
  create(run: ExtractionRun): Promise<ExtractionRun>;
  /** Atomically merge; with statuses, leave the run unchanged if its current status is not allowed. */
  update(projectId: string, id: string, patch: Partial<ExtractionRun>, statuses?: ExtractionRun["status"][]): Promise<ExtractionRun>;
  /**
   * Take the processing lease when it is free or expired. Returns the run with
   * the lease held, or null when someone else holds a live lease. Must be atomic.
   */
  acquireLease(projectId: string, id: string, holder: string, ttlMs: number, now: Date): Promise<ExtractionRun | null>;
  releaseLease(projectId: string, id: string, holder: string): Promise<void>;
  checkpoints(projectId: string, runId: string): Promise<JobCheckpoint[]>;
  /** insert-if-absent on (runId, key); false when the checkpoint already existed */
  putCheckpoint(projectId: string, cp: JobCheckpoint): Promise<boolean>;
  deleteCheckpoints(projectId: string, runId: string, keyPrefix: string): Promise<void>;
}

export interface ReportRepo {
  latest(projectId: string, revisionId: string): Promise<StoredValidationReport | null>;
  put(report: StoredValidationReport): Promise<void>;
}

export interface ConversationRepo {
  list(projectId: string): Promise<Conversation[]>;
  get(projectId: string, id: string): Promise<Conversation | null>;
  put(conversation: Conversation): Promise<void>;
  delete(projectId: string, id: string): Promise<void>;
}

/** Private object storage. Project paths start with their ID; agent/ is reserved for owner-level action state. */
export interface BlobStore {
  put(path: string, bytes: Buffer, contentType: string): Promise<void>;
  get(path: string): Promise<Buffer | null>;
  delete(path: string): Promise<void>;
}

export interface UserStore {
  evaluations: EvaluationRepo;
  /** Atomic revision preconditions are supported by local and Postgres adapters. */
  revisionPreconditions?: boolean;
  user: User;
  connections: ConnectionRepo;
  projects: ProjectRepo;
  documents: DocumentRepo;
  revisions: RevisionRepo;
  runs: RunRepo;
  reports: ReportRepo;
  conversations: ConversationRepo;
  blobs: BlobStore;
  usage(): Promise<Omit<StorageUsage, "quotaBytes">>;
}

/**
 * Privileged access for the background worker (B7): find runnable runs across
 * users and act as their owner. Stores without worker access rely on
 * browser-driven runs.
 */
export interface WorkerAccess {
  activeEvaluations(): Promise<{ ownerId: string; projectId: string; evaluationId: string }[]>;
  pendingDocuments?(): Promise<{ ownerId: string; projectId: string; documentId: string }[]>;
  activeRuns(): Promise<{ ownerId: string; projectId: string; runId: string }[]>;
  forOwner(ownerId: string): UserStore;
}

export interface Store {
  kind: "local" | "postgres";
  forUser(user: User, accessToken?: string): UserStore;
  worker?: WorkerAccess;
  close?(): Promise<void>;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
