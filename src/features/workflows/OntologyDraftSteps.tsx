import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import type { RevisionContent } from "../../types/project";
import { ErrorState, LoadingState, StatusBadge } from "../../components/ui/ui";
import { TermEditor } from "../ontology/TermEditor";
import { ValidationView } from "../validate/ValidationView";
import { OntologyBuildActions } from "./OntologyBuildActions";

export function OntologyDraftSteps({ step }: { step: string }) {
  const { pid, project, working } = useProject();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const id = params.get("rev") ?? project?.currentRevisionId ?? null;
  const revision = useQuery({ queryKey: qk.revision(pid, id ?? "none"), queryFn: () => api.getRevision(pid, id!), enabled: !!id });
  const save = useMutation({
    mutationFn: async ({ content, summary }: { content: RevisionContent; summary: string }) => {
      await working.flush();
      if (revision.data?.status !== "draft") return api.createDraft(pid, content, summary, "ontology");
      return api.saveDraft(pid, id!, content, summary);
    },
    onSuccess: async (saved) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.revisions(pid) }),
        qc.invalidateQueries({ queryKey: qk.revision(pid, saved.id) }),
      ]);
      if (saved.id !== id)
        setParams((previous) => {
          const next = new URLSearchParams(previous);
          next.set("rev", saved.id);
          return next;
        });
    },
  });
  if (!id) return <p className="muted">Choose a starting point to prepare an ontology draft.</p>;
  if (revision.isLoading) return <LoadingState label="Loading ontology draft…" />;
  if (revision.error || !revision.data) return <ErrorState error={revision.error} onRetry={() => void revision.refetch()} />;
  const result = revision.data;
  if (step === "validate")
    return (
      <div className="workflow-stack">
        <ValidationView key={id} pid={pid} revisionId={id} />
        <OntologyBuildActions revision={result} sourceRunId={params.get("from")} />
        {result.status === "committed" && (
          <section className="build-next-actions">
            <h3>Ontology version saved</h3>
            <p>Use this version to extract knowledge from documents, or start another ontology draft.</p>
            <div className="row-actions">
              <Link className="btn" to={`/p/${pid}/graphs?ontology=${id}`}>
                New knowledge graph using this ontology →
              </Link>
              <Link className="btn ghost" to={`/p/${pid}/workflows/tbox`}>
                Start another draft
              </Link>
              <Link to={`/p/${pid}/export?rev=${id}`}>Download ontology</Link>
            </div>
          </section>
        )}
      </div>
    );
  return (
    <div className="workflow-stack">
      <div className="ontology-draft-heading">
        <div>
          <h2>Review & edit ontology</h2>
          <p>{result.summary}</p>
        </div>
        <StatusBadge tone={result.status === "draft" ? "info" : "ok"}>
          {result.status === "draft" ? "Draft" : `Version ${result.number}`}
        </StatusBadge>
      </div>
      <p className="field-hint">
        Review the classes and properties below. Changes are saved to a draft; the next step validates it and saves a version.
      </p>
      <OntologyBuildActions revision={result} sourceRunId={params.get("from")} />
      <TermEditor
        key={id}
        content={result.content}
        applyLabel="Save draft changes"
        onApply={async (content, summary) => {
          await save.mutateAsync({ content, summary });
        }}
      />
      <details className="method-details">
        <summary>Build evidence & downloads</summary>
        <div className="method-details-body">
          {params.get("from") && (
            <Link className="btn ghost sm" to={`/p/${pid}/workflows/tbox?step=results&run=${params.get("from")}&rev=${id}`}>
              View build evidence
            </Link>
          )}
          <Link className="btn ghost sm" to={`/p/${pid}/export?rev=${id}`}>
            Download ontology
          </Link>
        </div>
      </details>
    </div>
  );
}
