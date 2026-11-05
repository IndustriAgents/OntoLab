import type { Project, ProjectDocument, OntologyRevision, RevisionWithContent, RunView, DocumentText } from "../types/project";
import type { CorpusPlan, CorpusUpdateMode, CorpusMember, CorpusChangeSummary } from "../types/corpus";
import type { ChunkSettings } from "../types/research";
import type { ValidationIssue } from "../types/abox";
import { request } from "./http";
const root = (id: string) => `api/projects/${encodeURIComponent(id)}`;
const path = (id: string) => `${root(id)}/corpus`;
export interface CorpusDetail {
  corpus: Project;
  graph: RevisionWithContent;
  documents: ProjectDocument[];
  revisions: OntologyRevision[];
}
export interface CorpusReview {
  revision: RevisionWithContent;
  base: RevisionWithContent | null;
  current: RevisionWithContent | null;
  changes: CorpusChangeSummary;
  findings: ValidationIssue[];
  stale: boolean;
}
export interface CorpusUpload {
  document: ProjectDocument;
  member: CorpusMember;
  duplicate: boolean;
  message?: string;
}
export const corpusKeys = {
  list: (pid: string) => ["corpora", pid] as const,
  detail: (id: string) => ["corpus", id] as const,
  plan: (id: string) => ["corpus-plan", id] as const,
  review: (id: string, rid: string) => ["corpus-review", id, rid] as const,
};
export const corpusApi = {
  list: (pid: string) => request<{ corpora: Project[] }>("GET", `${root(pid)}/corpora`).then((r) => r.corpora),
  create: (pid: string, body: { name: string; ontologyRevisionId: string; provider: string; model: string }) =>
    request<{ corpus: Project }>("POST", `${root(pid)}/corpora`, { body }).then((r) => r.corpus),
  detail: (id: string) => request<CorpusDetail>("GET", path(id)),
  upload: (id: string, file: File, member?: string) =>
    request<CorpusUpload>("POST", `${path(id)}/documents${member ? `?member=${encodeURIComponent(member)}` : ""}`, {
      raw: file,
      headers: { "x-file-name": encodeURIComponent(file.name) },
    }),
  settings: (
    id: string,
    body: { name?: string; ontologyRevisionId?: string; provider?: string; model?: string; chunking?: ChunkSettings },
  ) => request<{ corpus: Project }>("PUT", `${path(id)}/settings`, { body }).then((r) => r.corpus),
  plan: (id: string, mode: CorpusUpdateMode = "changes", selected: string[] = []) =>
    request<CorpusPlan>("POST", `${path(id)}/plan`, { body: { mode, selected } }),
  start: (id: string, body: { hash: string; mode: CorpusUpdateMode; selected: string[] }) =>
    request<{ run?: RunView; revision?: OntologyRevision; upToDate?: boolean }>("POST", `${path(id)}/updates`, { body }),
  member: (id: string, mid: string, body: { removed?: boolean; documentId?: string }) =>
    request<{ corpus: Project }>("PUT", `${path(id)}/members/${encodeURIComponent(mid)}`, { body }).then((r) => r.corpus),
  impact: (id: string, mid: string) =>
    request<{ lost: number; retained: number }>("GET", `${path(id)}/members/${encodeURIComponent(mid)}/impact`),
  reparse: (id: string, mid: string) =>
    request<{ document: ProjectDocument }>("POST", `${path(id)}/members/${encodeURIComponent(mid)}/reparse`).then((r) => r.document),
  prepare: (id: string, mid: string) =>
    request<{ document: ProjectDocument }>("POST", `${path(id)}/members/${encodeURIComponent(mid)}/prepare`).then((r) => r.document),
  preparation: (id: string, mid: string, documentId: string) =>
    request("POST", `${path(id)}/members/${encodeURIComponent(mid)}/preparation`, { body: { documentId } }),
  review: (id: string, rid: string) => request<CorpusReview>("GET", `${path(id)}/updates/${encodeURIComponent(rid)}`),
  losses: (id: string, rid: string, keys: string[], decision: "remove" | "manual") =>
    request("POST", `${path(id)}/updates/${encodeURIComponent(rid)}/losses`, { body: { keys, decision } }),
  replacement: (id: string, rid: string, beforeKey: string, afterKey: string, decision: "proposed" | "previous") =>
    request("POST", `${path(id)}/updates/${encodeURIComponent(rid)}/replacement`, { body: { beforeKey, afterKey, decision } }),
  relationship: (
    id: string,
    rid: string,
    body: { id: string; targetId?: string; create?: { id: string; label: string; classUri: string }; dismiss?: boolean },
  ) => request("POST", `${path(id)}/updates/${encodeURIComponent(rid)}/relationships`, { body }),
  evidence: (id: string, runId: string, documentId: string) =>
    request<DocumentText>("GET", `${path(id)}/evidence?run=${encodeURIComponent(runId)}&document=${encodeURIComponent(documentId)}`),
};
