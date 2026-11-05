import { Link, Navigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { corpusApi, corpusKeys } from "../../lib/corpusApi";
import { PageHead, InlineError } from "../../components/ui/ui";
import { IconGraph, IconOntology } from "../../components/icons";
import { runKindLabel, runWorkspaceHref } from "../../lib/runNavigation";
import OverviewPage from "../overview/OverviewPage";
import "./workflows.css";

export default function WorkflowHome() {
  const { pid, project, current, activeRun, drafts } = useProject();
  const graphs = useQuery({
    queryKey: corpusKeys.list(pid),
    queryFn: () => corpusApi.list(pid),
    enabled: !!project && !project.settings.corpus,
  });
  if (project?.settings.corpus) return <Navigate to={`/p/${pid}/graph`} replace />;
  return (
    <div className="page">
      <div className="page-wide">
        <PageHead title={project?.name ?? "Project overview"}>
          Build an ontology, then turn document collections into reviewed knowledge graphs.
        </PageHead>
        <div className="navigation-cards">
          <Link className="navigation-card" to={`/p/${pid}/ontology/overview`}>
            <IconOntology />
            <h2>Ontology</h2>
            <p>Define the classes and relationships your knowledge graphs use.</p>
            <span>{current ? `${current.stats.classes} classes · ${drafts.length} open drafts` : "Create your first ontology"} →</span>
          </Link>
          <Link className="navigation-card" to={`/p/${pid}/graphs`}>
            <IconGraph />
            <h2>Knowledge graphs</h2>
            <p>Manage documents, extract facts, review changes and explore the results.</p>
            <span>{graphs.data ? `${graphs.data.filter((g) => !g.archived).length} graph workspaces` : "Open graph workspaces"} →</span>
          </Link>
        </div>
        <InlineError error={graphs.error} />
        {activeRun && (
          <section className="workflow-resume">
            <div>
              <h2>Continue working</h2>
              <p>
                {runKindLabel(activeRun.kind)} · {activeRun.completedSteps} of {activeRun.steps.length} steps saved.
              </p>
            </div>
            <Link className="btn" to={runWorkspaceHref(pid, activeRun)}>
              Continue working →
            </Link>
          </section>
        )}
        {!!current?.stats.individuals && (
          <p className="muted">
            Earlier extractions saved directly in this project remain available. <Link to={`/p/${pid}/explore`}>Open project graph →</Link>
          </p>
        )}
        <OverviewPage embedded />
      </div>
    </div>
  );
}
