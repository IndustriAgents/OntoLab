import type { EvidenceRef, FactReview } from "./abox";
import type { DocumentText, ProjectDocument, RevisionStatus } from "./project";

/** Identifiers select stored associations; callers cannot supply support scores or review decisions. */
export type EvidenceTarget =
  | { kind: "fact"; revisionId: string; factKey: string }
  | { kind: "term"; runId?: string; revisionId?: string; termId: string; stepKey?: string }
  | { kind: "passage"; runId?: string; documentId: string; chunkId: string; stepKey?: string }
  | { kind: "document"; documentId: string }
  | { kind: "answer"; conversationId: string; messageId: string; ref: string }
  /** Compatibility locator. Its quote is user-selected text, not an authoritative claim. */
  | {
      kind: "reference";
      runId?: string;
      documentId?: string;
      chunkId?: string;
      quote: string;
      start?: number;
      end?: number;
      page?: number;
      stepKey?: string;
      preview?: boolean;
    };

export type EvidenceTab = "source" | "input" | "history";
export type QuoteMatch = "exact" | "normalized" | "partial" | "not-found" | "mismatch" | "vision" | "unrecorded";
export interface EvidenceSourceSummary {
  index: number;
  name: string;
  documentId?: string;
  runId?: string;
  chunkId?: string;
  page?: number;
}
export interface EvidenceTable {
  representation: "parsed";
  rows: { cells: string[]; header: boolean; highlighted: boolean }[];
  truncated: boolean;
}
export interface EvidenceSource {
  reference: Pick<EvidenceRef, "quote" | "status" | "claim" | "confidence" | "review" | "start" | "end" | "page">;
  match: QuoteMatch;
  support: "passed" | "review" | "score-only" | "unrecorded";
  integrity: "match" | "mismatch" | "not-recorded";
  textHash?: string;
  recordedTextHash?: string;
  document?: Pick<ProjectDocument, "id" | "name" | "kind" | "mediaType" | "checksum" | "parsing" | "createdAt" | "ocr">;
  snapshot: boolean;
  unavailable?: string;
  excerpt?: { text: string; start: number; end: number; total: number; highlight?: { start: number; end: number } };
  section?: string[];
  paths: string[];
  pathCount: number;
  table?: EvidenceTable;
  originalAvailable: boolean;
  stepKey?: string;
}
export interface EvidenceInputBlock {
  label: string;
  state: "recorded" | "reconstructed" | "unavailable" | "reused";
  text?: string;
  note?: string;
  truncated?: boolean;
}
export interface EvidenceInspection {
  version: 1;
  target: EvidenceTarget;
  title: string;
  revision?: { id: string; status: RevisionStatus; number: number | null; contentHash: string; current: boolean };
  assertion?: { key: string; status: FactReview["status"]; review?: FactReview };
  sources: EvidenceSourceSummary[];
  totalSources: number;
  sourceIndex: number;
  source?: EvidenceSource;
  query?: { id: string; query: string; rows: unknown[]; rowCount: number; error?: string; repositoryId: string };
  message?: string;
  inputs?: EvidenceInputBlock[];
  history: { label: string; detail: string; at?: string }[];
}
export interface EvidenceRequest {
  target: EvidenceTarget;
  sourceIndex?: number;
  part?: "overview" | "input";
}
export interface SavedEvidenceText extends DocumentText {
  name: string;
  parsing?: ProjectDocument["parsing"];
}
export interface EvidenceStructure {
  path: string;
  text: string;
  xml: string;
  truncated: boolean;
  table?: {
    caption?: string;
    footnotes?: string;
    rows: { cells: { text: string; header: boolean; colspan: number; rowspan: number }[]; highlighted: boolean }[];
    truncated: boolean;
  };
}
