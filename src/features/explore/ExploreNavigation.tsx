import { Link, useLocation } from "react-router";
import { useProject } from "../../app/project";

export function ExploreNavigation() {
  const { pid, project, selectedId } = useProject();
  const location = useLocation();
  if (project?.settings.externalGraph)
    return (
      <nav className="workspace-tabs" aria-label="Connected graph">
        <Link to={`/p/${pid}/graph`}>Explore</Link>
        <Link to={`/p/${pid}/graph?tab=query`}>Query</Link>
        <Link to={`/p/${pid}/assistant`} aria-current={location.pathname.endsWith("/assistant") ? "page" : undefined}>
          Ask
        </Link>
      </nav>
    );
  const explicitRevision = new URLSearchParams(location.search).has("rev") ? selectedId : null;
  const suffix = explicitRevision ? `?rev=${encodeURIComponent(explicitRevision)}` : "";
  const isGraph = !!project?.settings.corpus;
  const pages = isGraph
    ? [
        ["explore", "Graph"],
        ["assistant", "Ask"],
        ["sparql", "SPARQL"],
      ]
    : [
        ["ontology?tab=terms", "Terms & relations"],
        ["assistant", "Ask"],
        ["sparql", "SPARQL"],
      ];
  return (
    <nav className="workspace-tabs" aria-label={isGraph ? "Explore graph" : "Ontology tools"}>
      {pages.map(([path, label]) => (
        <Link
          key={path}
          to={`/p/${pid}/${path}${path.includes("?") ? (explicitRevision ? `&rev=${encodeURIComponent(explicitRevision)}` : "") : suffix}`}
          state={location.state}
          aria-current={location.pathname === `/p/${pid}/${path}` ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
      {!isGraph && (
        <Link to={`/p/${pid}/explore${suffix}`} aria-current={location.pathname.endsWith("/explore") ? "page" : undefined}>
          Project graph
        </Link>
      )}
      <Link className="workspace-export" to={`/p/${pid}/export${suffix}`} state={location.state}>
        Export {isGraph ? "graph" : "ontology"} ↗
      </Link>
    </nav>
  );
}
