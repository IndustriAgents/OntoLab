import { Link } from "react-router";
import { useProject } from "../../app/project";
import { projectRequirements, requirementsHistory } from "../../lib/requirementsVersions";

export function RequirementsSummary() {
  const { pid, project } = useProject();
  if (!project) return null;
  const requirements = projectRequirements(project);
  const version = requirementsHistory(project).at(-1);
  const approved = requirements.cqs.filter((q) => q.status === "approved").length;
  return (
    <section className="card" aria-label="Requirements summary">
      <div className="card-head">
        <h3>Requirements{version ? ` v${version.number}` : ""}</h3>
        <Link className="btn ghost sm" to={`/p/${pid}/workflows/tbox?step=requirements`}>
          Edit requirements →
        </Link>
      </div>
      <p>
        {approved} approved {approved === 1 ? "question" : "questions"} · {requirements.stories.length} user{" "}
        {requirements.stories.length === 1 ? "story" : "stories"}
      </p>
      <p className="muted">Questions guide ontology builds. Each build keeps the requirements version it started with.</p>
    </section>
  );
}
