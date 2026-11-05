import type { EvidenceInspection, EvidenceRequest, EvidenceStructure, SavedEvidenceText } from "../types/evidence";
import { rawRequest, request } from "./http";

const root = (pid: string) => `api/projects/${encodeURIComponent(pid)}`;
export const evidenceApi = {
  inspect: (pid: string, body: EvidenceRequest, signal?: AbortSignal) =>
    request<EvidenceInspection>("POST", `${root(pid)}/evidence/inspect`, { body, signal }),
  original: async (pid: string, body: EvidenceRequest, signal?: AbortSignal) =>
    (await rawRequest("POST", `${root(pid)}/evidence/original`, { body, signal })).blob(),
  structure: (pid: string, body: EvidenceRequest & { elementIndex: number }, signal?: AbortSignal) =>
    request<EvidenceStructure>("POST", `${root(pid)}/evidence/structure`, { body, signal }),
  text: (pid: string, runId: string, documentId: string) =>
    request<SavedEvidenceText>(
      "GET",
      `${root(pid)}/runs/${encodeURIComponent(runId)}/documents/${encodeURIComponent(documentId)}/evidence`,
    ),
};
