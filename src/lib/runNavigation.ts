import type { OntologyRevision, RunView } from "../types/project";

type RunDestination = Pick<RunView, "id" | "kind" | "status" | "resultRevisionId" | "baseRevisionId">;

/** Reopen the workspace that owns a run, including its review draft when ready. */
export function runWorkspaceHref(projectId: string, run: RunDestination, isGraph = false) {
  const base = `/p/${encodeURIComponent(projectId)}`;
  if (run.kind === "alignment") {
    const params = new URLSearchParams({ step: run.resultRevisionId ? "merge" : "match", run: run.id });
    const revisionId = run.resultRevisionId ?? run.baseRevisionId;
    if (revisionId) params.set("rev", revisionId);
    return `${base}/workflows/alignment?${params}`;
  }
  if (isGraph) return `${base}/graph?tab=updates&run=${encodeURIComponent(run.id)}`;
  return `${base}/runs/${encodeURIComponent(run.id)}`;
}

export function runKindLabel(kind: RunView["kind"]) {
  return kind === "alignment" ? "Ontology alignment" : kind === "induction" ? "Ontology build" : "Extraction";
}

/** Older ontology drafts can predate explicit revision scopes. */
export function isOntologyRevision(revision: Pick<OntologyRevision, "scope" | "source" | "stats">) {
  return (
    revision.scope === "tbox" ||
    (revision.scope !== "abox" &&
      (["ontology", "induction", "template", "import"].includes(revision.source) ||
        (revision.stats.modules > 0 && revision.stats.individuals === 0)))
  );
}
