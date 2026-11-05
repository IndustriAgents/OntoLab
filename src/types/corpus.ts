import type { ChunkSettings } from "./research";
import type { ProjectDocument, RevisionContent } from "./project";
import type { ABoxDataProp, ABoxObjectProp, ABoxResult } from "./abox";
import type { FactRow } from "../lib/ontology/factReview";

/** Each corpus owns a distinct repository namespace; it never shares source membership with its parent project. */
export interface CorpusMetadata {
  updateLease?: { id: string; expiresAt: string };
  parentProjectId: string;
  parentName: string;
  version: number;
  members: CorpusMember[];
  requestedOntologyRevisionId: string;
  chunking?: ChunkSettings;
}
export interface CorpusMember {
  id: string;
  name: string;
  headDocumentId: string;
  removed: boolean;
  versions: { documentId: string; checksum: string; number: number; createdAt: string; preparation?: boolean }[];
}
export interface OntologyPin {
  projectId: string;
  revisionId: string;
  number: number;
  hash: string;
  name: string;
}
export interface CorpusSourceRecord {
  memberId: string;
  documentId: string;
  fingerprint: string;
  checksum: string;
  runId: string;
  chunks: number;
  cached: number;
  screened: number;
}
export interface LostSourceFact {
  data?: ABoxDataProp;
  link?: ABoxObjectProp;
  subject: { id: string; classUri: string; label?: string; iri?: string };
  key: string;
  fact: FactRow;
  decision: "pending" | "remove" | "manual";
}
export interface CorpusGraphState {
  /** This release publishes reviewed facts only; policy travels with saved versions. */
  reviewPolicy?: "accepted-only";
  planHash?: string;
  ontology: OntologyPin;
  sources: CorpusSourceRecord[];
  suppressed: string[];
  losses: LostSourceFact[];
  mode?: CorpusUpdateMode;
}
export type CorpusUpdateMode = "changes" | "reprocess" | "rebuild";
export interface CorpusRunContext {
  /** Identity hints only; never reintroduces facts from superseded sources. */
  identityIndex?: ABoxResult;
  planHash?: string;
  corpusId: string;
  mode: CorpusUpdateMode;
  baseGraphRevisionId: string;
  baseContent: RevisionContent;
  nextSources: CorpusSourceRecord[];
  membersVersion: number;
}
export type CorpusSourceStatus = "new" | "preparing" | "included" | "updated" | "attention" | "removal-pending" | "removed";
export interface CorpusSourceView {
  member: CorpusMember;
  document: ProjectDocument | null;
  status: CorpusSourceStatus;
  reason: string;
  fingerprint: string;
  previous?: CorpusSourceRecord;
}
export interface CorpusPlan {
  corpusId: string;
  hash: string;
  mode: CorpusUpdateMode;
  ontology: OntologyPin;
  currentOntology: OntologyPin;
  baseRevisionId: string;
  sources: CorpusSourceView[];
  processDocumentIds: string[];
  removeDocumentIds: string[];
  reused: number;
  errors: string[];
  warnings: string[];
  estimatedUsd: number | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  affected: { lost: number; retained: number };
}
export interface CorpusChangeSummary {
  updated: { before: FactRow; after: FactRow }[];
  addedEntities: string[];
  removedEntities: string[];
  added: FactRow[];
  removed: FactRow[];
  enriched: FactRow[];
  reduced: FactRow[];
  reviewed: FactRow[];
  unchanged: number;
  conflicts: string[];
  candidates: number;
}
