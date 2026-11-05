import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { findOntologyBuild, ontologyBuildParams } from "../../lib/ontologyBuild";
import type { OntologyRevision } from "../../types/project";
import { InlineError, LoadingState } from "../../components/ui/ui";

export function OntologyBuildActions({
  revision,
  sourceRunId,
  compact = false,
}: {
  revision: OntologyRevision;
  sourceRunId?: string | null;
  compact?: boolean;
}) {
  const { pid, revisions } = useProject();
  const runs = useQuery({ queryKey: qk.runs(pid), queryFn: () => api.listRuns(pid) });
  const source = findOntologyBuild(revision.id, [revision, ...revisions], runs.data ?? [], sourceRunId);
  const href = (step: "sources" | "chunks" | "generate") => `/p/${pid}/workflows/tbox?${ontologyBuildParams(revision.id, step, source)}`;
  if (compact)
    return (
      <div>
        {runs.isLoading ? (
          <LoadingState label="Loading build settings…" />
        ) : (
          <Link className="btn ghost" to={href("sources")}>
            Improve with documents →
          </Link>
        )}
        <InlineError error={runs.error} />
      </div>
    );
  return (
    <section className="ontology-build-actions" aria-labelledby="ontology-build-actions-heading">
      <h3 id="ontology-build-actions-heading">Improve with documents</h3>
      <p>
        Keep this ontology as your starting point. Add documents or change chunking, embeddings and generation settings, then review a new
        draft and save the next version.
      </p>
      {runs.isLoading ? (
        <LoadingState label="Loading previous build settings…" />
      ) : (
        <div className="row-actions">
          <Link className="btn sm" to={href("sources")}>
            Add or change documents
          </Link>
          <Link className="btn ghost sm" to={href("chunks")}>
            Change chunks & embeddings
          </Link>
          <Link className="btn ghost sm" to={href("generate")}>
            Generation settings
          </Link>
        </div>
      )}
      {source && <p className="field-hint">Your previous document selection and build settings are carried forward for you to adjust.</p>}
      <InlineError error={runs.error} />
    </section>
  );
}
