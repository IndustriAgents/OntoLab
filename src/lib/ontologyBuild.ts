import type { OntologyRevision, RunView } from "../types/project";

/** Follow a draft's ancestry to recover the build whose inputs and settings it continues. */
export function findOntologyBuild(
  revisionId: string,
  revisions: OntologyRevision[],
  runs: RunView[],
  sourceRunId?: string | null,
): RunView | undefined {
  const builds = runs.filter((run) => run.kind === "induction");
  const explicit = builds.find((run) => run.id === sourceRunId);
  if (explicit) return explicit;
  const visited = new Set<string>();
  let id: string | null = revisionId;
  while (id && !visited.has(id)) {
    visited.add(id);
    const revision = revisions.find((candidate) => candidate.id === id);
    const build = builds.find((run) => run.resultRevisionId === id || run.id === revision?.runId);
    if (build) return build;
    id = revision?.parentId ?? null;
  }
}

export function ontologyBuildParams(revisionId: string, step: "sources" | "chunks" | "generate", source?: RunView): URLSearchParams {
  const params = new URLSearchParams({ start: "documents", step, base: revisionId });
  if (source) {
    params.set("from", source.id);
    params.set("docs", source.documentIds.join(","));
  }
  return params;
}
