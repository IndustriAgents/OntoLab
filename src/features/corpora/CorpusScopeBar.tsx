import { Link, useLocation } from "react-router";
import { useProject } from "../../app/project";
import "./corpora.css";

export function CorpusScopeBar() {
  const { pid, project, working } = useProject();
  const location = useLocation();
  if (!project?.settings.corpus) return null;
  const pin = working.content?.corpus?.ontology;
  const revision = working.revision;
  return (
    <div className="corpus-scope" aria-label="Current graph and ontology version">
      <span className="corpus-scope-pin">
        {revision?.status === "draft" ? "Draft update" : revision?.number ? `Graph version ${revision.number}` : "No graph generated yet"}
      </span>
      {pin && (
        <Link
          to={`/p/${pin.projectId}/ontology?tab=review&rev=${pin.revisionId}`}
          state={{ graphReturn: { id: pid, name: project.name, to: location.pathname + location.search } }}
        >
          Ontology v{pin.number} · pinned ↗
        </Link>
      )}
    </div>
  );
}
