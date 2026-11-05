import { Link } from "react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { corpusApi, corpusKeys } from "../../lib/corpusApi";
import { EmptyState, InlineError, LoadingState, PageHead } from "../../components/ui/ui";
import { IconFile, IconGraph, IconOntology } from "../../components/icons";
import { RunStatusBadge } from "../runs/RunStatusBadge";
import { runWorkspaceHref } from "../../lib/runNavigation";

export function OntologyUsage({ revisionId }: { revisionId?: string }) {
  const { pid } = useProject();
  const graphs = useQuery({ queryKey: corpusKeys.list(pid), queryFn: () => corpusApi.list(pid) });
  const list = (graphs.data ?? []).filter((g) => !g.archived);
  const versions = useQueries({
    queries: list.map((g) => ({
      queryKey: qk.revision(g.id, g.currentRevisionId ?? "none"),
      queryFn: () => api.getRevision(g.id, g.currentRevisionId!),
      enabled: !!g.currentRevisionId,
    })),
  });
  const matching = list.flatMap((g, i) => {
    const pin = versions[i].data?.content.corpus?.ontology;
    return pin && (!revisionId || pin.revisionId === revisionId) ? [{ graph: g, pin }] : [];
  });
  const loading = graphs.isLoading || versions.some((v) => v.isLoading);
  const error = graphs.error ?? versions.find((v) => v.error)?.error;
  return (
    <section className="ontology-usage">
      <div className="card-head">
        <h2>Used by knowledge graphs</h2>
        <Link to={`/p/${pid}/graphs`}>All knowledge graphs →</Link>
      </div>
      <InlineError error={error} />
      {loading ? (
        <LoadingState label="Checking ontology usage…" />
      ) : (
        <>
          <ul className="navigation-list">
            {matching.map(({ graph, pin }) => (
              <li key={graph.id}>
                <div>
                  <Link to={`/p/${graph.id}/graph`}>{graph.name}</Link>
                  <small>Pinned to ontology version {pin.number}</small>
                </div>
                <Link className="btn ghost sm" to={`/p/${graph.id}/graph`}>
                  Open graph workspace →
                </Link>
              </li>
            ))}
          </ul>
          {!matching.length && !error && (
            <p className="muted">No knowledge graphs use {revisionId ? "this version" : "a saved version"} yet.</p>
          )}
        </>
      )}
    </section>
  );
}

export default function OntologyOverview() {
  const { pid, current, drafts, selectedId, revisions } = useProject();
  const shown = revisions.find((r) => r.id === selectedId) ?? current;
  const revisionQuery = shown ? `rev=${encodeURIComponent(shown.id)}` : "";
  const href = (path: string) => `/p/${pid}/${path}${revisionQuery ? `${path.includes("?") ? "&" : "?"}${revisionQuery}` : ""}`;
  const runs = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid), refetchInterval: 5000 });
  const alignment = (runs.data ?? []).find(
    (r) =>
      r.kind === "alignment" &&
      (["queued", "running", "paused", "failed"].includes(r.status) || drafts.some((d) => d.id === r.resultRevisionId)),
  );
  return (
    <div className="page">
      <div className="page-wide">
        <PageHead
          title="Ontology"
          actions={
            <Link className="btn" to={href("workflows/tbox")}>
              Build or import ontology →
            </Link>
          }
        >
          Define the classes and relationships used by this project’s knowledge graphs.
        </PageHead>
        {shown ? (
          <p className="muted">
            {shown.status === "draft" ? "Selected draft" : `Ontology version ${shown.tboxVersion ?? shown.number}`} · {shown.stats.classes}{" "}
            classes · {drafts.length} open drafts
          </p>
        ) : (
          <EmptyState title="Start your ontology">
            Build from documents, use a template or import an ontology, then review and save a version.
          </EmptyState>
        )}
        {alignment && (
          <section className="workflow-resume" aria-label="Recent ontology alignment">
            <div>
              <h2>
                {alignment.status === "ready_for_review"
                  ? "Alignment ready for review"
                  : alignment.status === "paused"
                    ? "Alignment paused"
                    : "Ontology alignment"}
              </h2>
              <p>
                {alignment.completedSteps} of {alignment.steps.length} steps saved. Review mappings before saving an ontology version.
              </p>
            </div>
            <RunStatusBadge status={alignment.status} />
            <Link className="btn" to={runWorkspaceHref(pid, alignment)}>
              {alignment.resultRevisionId ? "Review mappings →" : "Open alignment →"}
            </Link>
          </section>
        )}
        <div className="navigation-cards ontology-navigation-cards">
          <Link className="navigation-card" to={href("ontology?tab=terms")}>
            <IconOntology />
            <h2>Terms & relations</h2>
            <p>Inspect classes, properties and modules. Review and author changes.</p>
            <span>Open ontology editor →</span>
          </Link>
          <Link className="navigation-card" to={href("workflows/tbox")}>
            <IconFile />
            <h2>Build & sources</h2>
            <p>Prepare documents and competency questions, configure a build and inspect its results.</p>
            <span>Open build workspace →</span>
          </Link>
          <Link className="navigation-card" to={href("workflows/alignment")}>
            <IconGraph />
            <h2>Align &amp; merge</h2>
            <p>Compare ontologies, review suggested connections and save an aligned version.</p>
            <span>Open alignment workspace →</span>
          </Link>
        </div>
        <OntologyUsage revisionId={shown?.id} />
      </div>
    </div>
  );
}
