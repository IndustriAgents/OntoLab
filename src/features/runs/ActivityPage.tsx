import { useState } from "react";
import { Link } from "react-router";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { corpusApi, corpusKeys } from "../../lib/corpusApi";
import { EmptyState, InlineError, LoadingState, PageHead, StatusBadge, fmtDate } from "../../components/ui/ui";
import { RunStatusBadge } from "./RunStatusBadge";
import { runWorkspaceHref } from "../../lib/runNavigation";
import { evaluationApi, evaluationKeys } from "../../lib/evaluationApi";

export default function ActivityPage() {
  const { pid, project, revisions } = useProject();
  const qc = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [scope, setScope] = useState("all");
  const [page, setPage] = useState(0);
  const graphs = useQuery({ queryKey: corpusKeys.list(pid), queryFn: () => corpusApi.list(pid) });
  const scopes = [{ id: pid, name: project?.name ?? "Project" }, ...(graphs.data ?? [])];
  const runs = useQueries({
    queries: scopes.map((p) => ({ queryKey: qk.runs(p.id), queryFn: () => api.listRuns(p.id), refetchInterval: 15_000 })),
  });
  const evaluations = useQueries({
    queries: scopes.map((p) => ({ queryKey: evaluationKeys.list(p.id), queryFn: () => evaluationApi.list(p.id), refetchInterval: 5000 })),
  });
  // Older synchronous comparisons only exist in revisions. Keep them available
  // without duplicating background runs or comparisons inherited by later versions.
  const alignments = useQuery({
    queryKey: ["alignment-activity", pid, revisions.map((r) => `${r.id}:${r.contentHash}`).join(",")],
    queryFn: async () => {
      const records = new Map<
        string,
        { id: string; createdAt: string; revisionId: string; reviewed: boolean; resultRevisions: string[] }
      >();
      for (let i = 0; i < revisions.length; i += 4) {
        const contents = await Promise.all(
          revisions
            .slice(i, i + 4)
            .map((r) => qc.fetchQuery({ queryKey: qk.revision(pid, r.id), queryFn: () => api.getRevision(pid, r.id) })),
        );
        for (const revision of contents)
          for (const record of revision.content.review?.alignmentRuns ?? []) {
            if (!records.has(record.id))
              records.set(record.id, {
                id: record.id,
                createdAt: record.createdAt,
                revisionId: revision.id,
                reviewed: !!record.decisions.length,
                resultRevisions: [],
              });
            if (record.id === revision.content.review?.alignmentRuns?.at(-1)?.id) records.get(record.id)!.resultRevisions.push(revision.id);
          }
      }
      return [...records.values()];
    },
  });
  const alignmentResults = new Set(
    runs.flatMap((q) => (q.data ?? []).filter((r) => r.kind === "alignment").map((r) => r.resultRevisionId)),
  );
  const entries = [
    ...runs.flatMap((q, i) =>
      (q.data ?? []).map((run) => ({
        id: run.id,
        at: run.createdAt,
        scope: scopes[i].id,
        name: scopes[i].name,
        kind: run.kind === "alignment" ? "alignment" : run.kind === "induction" ? "build" : "extraction",
        run,
        evaluationState: null,
        href: runWorkspaceHref(scopes[i].id, run, scopes[i].id !== pid),
        detail: `${run.kind === "alignment" ? `${run.alignment?.estimate.processedSourceTerms ?? "—"} source terms` : `${run.documentIds.length} documents`} · ${run.completedSteps} / ${run.steps.length} steps saved`,
      })),
    ),
    ...(alignments.data ?? [])
      .filter((a) => !a.resultRevisions?.some((id) => alignmentResults.has(id)))
      .map((a) => ({
        id: a.id,
        at: a.createdAt,
        scope: pid,
        name: project?.name ?? "Project",
        kind: "alignment",
        run: null,
        evaluationState: null,
        href: `/p/${pid}/workflows/alignment?step=merge&rev=${a.revisionId}`,
        detail: a.reviewed ? "Mappings reviewed" : "Matches ready to review",
      })),
    ...evaluations.flatMap((q, i) =>
      (q.data ?? []).map((evaluation) => ({
        id: evaluation.id,
        at: evaluation.createdAt,
        scope: scopes[i].id,
        name: scopes[i].name,
        kind: "evaluation",
        run: null,
        evaluationState: evaluation.state,
        href: `/p/${scopes[i].id}/evaluate?evaluation=${encodeURIComponent(evaluation.id)}`,
        detail: `${evaluation.title} · v${evaluation.baseline.number} → v${evaluation.candidate.number} · ${evaluation.completedAnswers}/${evaluation.totalAnswers} answers saved`,
      })),
    ),
  ]
    .filter((e) => (filter === "all" || e.kind === filter) && (scope === "all" || e.scope === scope))
    .sort((a, b) => b.at.localeCompare(a.at));
  const totalPages = Math.max(1, Math.ceil(entries.length / 25));
  const shownPage = Math.min(page, totalPages - 1);
  const loading = graphs.isLoading || runs.some((q) => q.isLoading) || evaluations.some((q) => q.isLoading) || alignments.isLoading;
  const errors = [graphs.error, ...runs.map((q) => q.error), ...evaluations.map((q) => q.error), alignments.error].filter(Boolean);
  return (
    <div className="page">
      <div className="page-wide">
        <PageHead title="Activity">
          Builds, alignments, extractions and evaluations across {project?.name ?? "this project"}. Open an activity to inspect progress,
          results or retry unfinished work.
        </PageHead>
        <div className="navigation-filters">
          <label className="field">
            <span>Activity type</span>
            <select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All activity</option>
              <option value="build">Ontology builds</option>
              <option value="extraction">Extraction</option>
              <option value="alignment">Alignment</option>
              <option value="evaluation">Evaluation</option>
            </select>
          </label>
          <label className="field">
            <span>Workspace</span>
            <select
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">Entire project</option>
              {scopes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.id === pid ? " · Ontology / project" : " · Knowledge graph"}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!!errors.length && (
          <>
            <p className="muted">Some activity could not be loaded. Available entries are shown below.</p>
            <InlineError error={errors[0]} />
            <button
              className="btn ghost"
              onClick={() => {
                void graphs.refetch();
                void alignments.refetch();
                runs.forEach((q) => void q.refetch());
                evaluations.forEach((q) => void q.refetch());
              }}
            >
              Retry loading activity
            </button>
          </>
        )}
        {loading && <LoadingState label="Loading project activity…" />}
        <div className="activity-list">
          {entries.slice(shownPage * 25, (shownPage + 1) * 25).map((e) => (
            <article key={`${e.scope}:${e.id}`} className="activity-entry">
              <div>
                <Link to={e.href}>
                  <strong>
                    {e.kind === "build"
                      ? "Build ontology"
                      : e.kind === "alignment"
                        ? "Align & merge"
                        : e.kind === "evaluation"
                          ? "Evaluate graph answers"
                          : "Extract documents"}{" "}
                    · {e.name}
                  </strong>
                </Link>
                <small>
                  {fmtDate(e.at)} · {e.detail}
                </small>
              </div>
              {e.evaluationState ? (
                <StatusBadge tone={e.evaluationState === "failed" || e.evaluationState === "interrupted" ? "warn" : "muted"}>
                  {e.evaluationState.replaceAll("_", " ")}
                </StatusBadge>
              ) : e.run ? (
                <RunStatusBadge status={e.run.status} resumable={e.run.resumable} />
              ) : (
                <StatusBadge tone="muted">Alignment</StatusBadge>
              )}
            </article>
          ))}
        </div>
        {!loading && !errors.length && !entries.length && (
          <EmptyState title="No activity yet">Build an ontology or extract documents in a knowledge graph to see progress here.</EmptyState>
        )}
        {totalPages > 1 && (
          <div className="row-actions">
            <button className="btn ghost" disabled={!shownPage} onClick={() => setPage(shownPage - 1)}>
              Previous
            </button>
            <span>
              Page {shownPage + 1} of {totalPages}
            </span>
            <button className="btn ghost" disabled={shownPage + 1 >= totalPages} onClick={() => setPage(shownPage + 1)}>
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
