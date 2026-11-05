import { download, request } from "./http";
import type { Evaluation, EvaluationSetup, EvaluationSummary } from "../types/evaluation";
const base = (pid: string) => `api/projects/${encodeURIComponent(pid)}/evaluations`;
const path = (pid: string, id: string) => `${base(pid)}/${encodeURIComponent(id)}`;
export const evaluationKeys = {
  list: (pid: string) => ["evaluations", pid] as const,
  detail: (pid: string, id: string) => ["evaluation", pid, id] as const,
  setup: (pid: string) => ["evaluation-setup", pid] as const,
};
export const evaluationApi = {
  setup: (pid: string) => request<EvaluationSetup>("GET", `${base(pid)}/setup`),
  list: (pid: string) => request<{ evaluations: EvaluationSummary[] }>("GET", base(pid)).then((r) => r.evaluations),
  get: (pid: string, id: string) => request<{ evaluation: Evaluation }>("GET", path(pid, id)).then((r) => r.evaluation),
  create: (pid: string, body: unknown) => request<{ evaluation: Evaluation }>("POST", base(pid), { body }).then((r) => r.evaluation),
  update: (pid: string, id: string, body: unknown) =>
    request<{ evaluation: Evaluation }>("PATCH", path(pid, id), { body }).then((r) => r.evaluation),
  action: (pid: string, id: string, action: "start" | "retry" | "advance" | "cancel" | "reports", body: unknown = {}) =>
    request<{ evaluation: Evaluation }>("POST", `${path(pid, id)}/${action}`, { body }).then((r) => r.evaluation),
  review: (pid: string, id: string, body: unknown) =>
    request<{ evaluation: Evaluation }>("POST", `${path(pid, id)}/reviews`, { body }).then((r) => r.evaluation),
  source: (pid: string, id: string, sourceId: string) =>
    request<{ text: string; pages: { page: number; start: number; end: number }[]; name: string }>(
      "GET",
      `${path(pid, id)}/sources/${encodeURIComponent(sourceId)}`,
    ),
  export: (pid: string, id: string, reportId: string) =>
    download(`${path(pid, id)}/reports/${encodeURIComponent(reportId)}/export`, `evaluation-${reportId}.json`),
};
