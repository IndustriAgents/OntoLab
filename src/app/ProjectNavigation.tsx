import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, qk } from "../lib/projectApi";
import { corpusApi, corpusKeys } from "../lib/corpusApi";
import { runKindLabel, runWorkspaceHref } from "../lib/runNavigation";
import { IconChevronsUpDown, IconGraph, IconHome, IconOntology, IconPlay } from "../components/icons";
import { InlineError, LoadingState, Modal } from "../components/ui/ui";
import type { ProjectNavInfo } from "./AppShell";
import { rememberedOntology, rememberOntology, selectedOntology, switchOntologyHref } from "../lib/ontologySelection";
import { revisionLabel } from "../features/revisions/RevisionBar";
import { graphNavigation, navigationSelection, ontologyNavigation, switchGraphHref, type NavigationArea } from "./navigation";

function remembered(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Browser storage is optional. */
  }
}

function rememberedExpansion(key: string, initialArea: NavigationArea): Record<NavigationArea, boolean> {
  const fallback = { ontology: initialArea === "ontology", graphs: initialArea === "graphs" };
  try {
    const saved: unknown = JSON.parse(remembered(key) ?? "null");
    if (!saved || typeof saved !== "object") return fallback;
    const sections = saved as Partial<Record<NavigationArea, unknown>>;
    return {
      ontology: typeof sections.ontology === "boolean" ? sections.ontology : fallback.ontology,
      graphs: typeof sections.graphs === "boolean" ? sections.graphs : fallback.graphs,
    };
  } catch {
    return fallback;
  }
}

export function ProjectNavigation({ project }: { project: ProjectNavInfo }) {
  const location = useLocation();
  const navigate = useNavigate();
  const parentId = project.corpus?.parentId ?? project.id;
  const base = `/p/${parentId}`;
  const selection = project.external
    ? {
        area: "graphs" as const,
        id: location.pathname.endsWith("/assistant")
          ? "ask"
          : new URLSearchParams(location.search).get("tab") === "settings"
            ? "settings"
            : new URLSearchParams(location.search).get("tab") === "query"
              ? "query"
              : "explore",
        label: "Connected graph",
      }
    : navigationSelection(location.pathname, location.search, !!project.corpus);
  const sectionKey = `ontolab-navigation:${parentId}`;
  const graphKey = `ontolab-selected-graph:${parentId}`;
  const expansionKey = `ontolab-navigation-expanded:${parentId}`;
  const [expanded, setExpanded] = useState(() =>
    rememberedExpansion(expansionKey, selection.area ?? (remembered(sectionKey) === "graphs" ? "graphs" : "ontology")),
  );
  const [lastGraph, setLastGraph] = useState(() => remembered(graphKey));
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const [pickingOntology, setPickingOntology] = useState(false);
  const [ontologySearch, setOntologySearch] = useState("");
  const [switchingOntology, setSwitchingOntology] = useState(false);
  const [ontologyError, setOntologyError] = useState<Error | null>(null);
  const parent = useQuery({ queryKey: qk.project(parentId), queryFn: () => api.getProject(parentId) });
  const ontologyRevisions = useQuery({ queryKey: qk.revisions(parentId), queryFn: () => api.listRevisions(parentId) });
  const requestedRevision = !project.corpus ? new URLSearchParams(location.search).get("rev") : null;
  const selectedRevisionId = selectedOntology(
    ontologyRevisions.data ?? [],
    parent.data?.currentRevisionId,
    requestedRevision,
    rememberedOntology(parentId),
  );
  const selectedRevision = ontologyRevisions.data?.find((r) => r.id === selectedRevisionId);
  const ontologyList = [...(ontologyRevisions.data ?? [])]
    .filter((r) => r.stats.modules > 0 && `${revisionLabel(r)} ${r.summary}`.toLowerCase().includes(ontologySearch.trim().toLowerCase()))
    .sort((a, b) => (a.status === b.status ? b.updatedAt.localeCompare(a.updatedAt) : a.status === "draft" ? -1 : 1));
  const ontologyOverviewHref = `${base}/ontology/overview${selectedRevision ? `?rev=${encodeURIComponent(selectedRevision.id)}` : ""}`;
  const pickOntology = async (id: string) => {
    setSwitchingOntology(true);
    setOntologyError(null);
    try {
      const saved = await project.flush?.();
      if (project.flush && ["saving", "error", "conflict"].includes(project.save) && !saved)
        throw new Error("Your edits could not be saved. Retry saving before switching ontology versions.");
      rememberOntology(parentId, id);
      setPickingOntology(false);
      navigate(switchOntologyHref(parentId, id, location.pathname, location.search), { state: location.state });
    } catch (e) {
      setOntologyError(e instanceof Error ? e : new Error("Could not switch ontology versions."));
    } finally {
      setSwitchingOntology(false);
    }
  };
  const graphs = useQuery({ queryKey: corpusKeys.list(parentId), queryFn: () => corpusApi.list(parentId) });
  const activityScopes = [
    { id: parentId, name: project.corpus?.parentName ?? project.name },
    ...(graphs.data ?? []).filter((g) => !g.archived),
  ];
  const activity = useQueries({
    queries: activityScopes.map((scope) => ({
      queryKey: qk.runs(scope.id),
      queryFn: () => api.listRuns(scope.id),
      refetchInterval: 15_000,
    })),
  });
  const active = activity
    .flatMap((query, index) =>
      (query.data ?? [])
        .filter((run) => ["queued", "running", "awaiting_answers", "paused"].includes(run.status))
        .map((run) => ({ run, scope: activityScopes[index] })),
    )
    .sort(
      (a, b) => Number(a.run.status === "paused") - Number(b.run.status === "paused") || b.run.updatedAt.localeCompare(a.run.updatedAt),
    );
  const latest = active.find((entry) => entry.scope.id === project.id) ?? active[0];
  const activeHref = latest ? runWorkspaceHref(latest.scope.id, latest.run, latest.scope.id !== parentId) : null;
  const activeLabel = latest
    ? latest.run.status === "awaiting_answers"
      ? "Extraction needs your answers"
      : `${runKindLabel(latest.run.kind)}${latest.run.status === "paused" || (latest.run.kind !== "alignment" && latest.run.resumable) ? " paused" : " in progress"} · ${latest.run.completedSteps}/${latest.run.steps.length}`
    : project.activity;
  useEffect(() => {
    setLastGraph(remembered(graphKey));
  }, [graphKey]);
  useEffect(() => {
    if (selection.area) {
      remember(sectionKey, selection.area);
    }
    if (project.corpus) {
      setLastGraph(project.id);
      remember(graphKey, project.id);
    }
    setPicking(false);
  }, [selection.area, sectionKey, graphKey, project.id, project.corpus, location.pathname, location.search]);
  const toggleSection = (section: NavigationArea) => {
    const next = { ...expanded, [section]: !expanded[section] };
    setExpanded(next);
    remember(expansionKey, JSON.stringify(next));
  };
  const selected = project.corpus ? { id: project.id, name: project.name } : graphs.data?.find((g) => g.id === lastGraph && !g.archived);
  const selectedExternal = project.external || !!graphs.data?.find((g) => g.id === selected?.id)?.settings.externalGraph;
  const externalNavigation = [
    { id: "explore", label: "Explore", path: "graph" },
    { id: "query", label: "Query", path: "graph?tab=query" },
    { id: "ask", label: "Ask", path: "assistant" },
    { id: "settings", label: "Graph settings", path: "graph?tab=settings" },
  ];
  const list = (graphs.data ?? []).filter((g) => !g.archived && g.name.toLowerCase().includes(search.trim().toLowerCase()));
  const ontologyHref = (item: (typeof ontologyNavigation)[number]) => {
    const params = new URLSearchParams(item.path.split("?")[1]);
    if (selectedRevision) params.set("rev", selectedRevision.id);
    return `${base}/${item.path.split("?")[0]}${params.size ? `?${params}` : ""}`;
  };
  const itemClass = (id: string) => `nav-item${selection.id === id ? " is-active" : ""}`;
  const common = (id: string) => ({ className: itemClass(id), "aria-current": selection.id === id ? ("page" as const) : undefined });
  return (
    <>
      <nav className="nav project-navigation" aria-label="Project navigation">
        <Link to={base} {...common("overview")}>
          <IconHome />
          <span>Overview</span>
        </Link>
        <div className="nav-parent-row">
          <Link
            to={ontologyOverviewHref}
            {...common("ontology")}
            className={`${itemClass("ontology")} nav-parent${expanded.ontology ? " in-section" : ""}`}
            state={location.state}
          >
            <IconOntology />
            <span>Ontology</span>
          </Link>
          <button
            type="button"
            className="nav-chevron"
            aria-label={`${expanded.ontology ? "Collapse" : "Expand"} Ontology navigation`}
            aria-expanded={expanded.ontology}
            aria-controls="ontology-navigation"
            onClick={() => toggleSection("ontology")}
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
              style={{ transform: expanded.ontology ? "rotate(90deg)" : undefined }}
            >
              <path d="m6 4 4 4-4 4" />
            </svg>
          </button>
        </div>
        {expanded.ontology && (
          <div className="nav-children" id="ontology-navigation" aria-label="Ontology navigation">
            <button
              className="graph-switch"
              aria-haspopup="dialog"
              onClick={() => {
                setOntologySearch("");
                setOntologyError(null);
                setPickingOntology(true);
              }}
            >
              <span>
                <small>Selected ontology</small>
                <strong>
                  {selectedRevision ? revisionLabel(selectedRevision) : ontologyRevisions.isLoading ? "Loading…" : "Choose a version"}
                </strong>
              </span>
              <IconChevronsUpDown />
            </button>
            {ontologyNavigation.map((item) => (
              <Link key={item.id} to={ontologyHref(item)} {...common(item.id)} state={location.state}>
                {item.label}
              </Link>
            ))}
          </div>
        )}
        <div className="nav-parent-row">
          <Link
            to={`${base}/graphs`}
            {...common("graphs")}
            className={`${itemClass("graphs")} nav-parent${expanded.graphs ? " in-section" : ""}`}
          >
            <IconGraph />
            <span>Knowledge graphs</span>
          </Link>
          <button
            type="button"
            className="nav-chevron"
            aria-label={`${expanded.graphs ? "Collapse" : "Expand"} Knowledge graphs navigation`}
            aria-expanded={expanded.graphs}
            aria-controls="knowledge-graph-navigation"
            onClick={() => toggleSection("graphs")}
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
              style={{ transform: expanded.graphs ? "rotate(90deg)" : undefined }}
            >
              <path d="m6 4 4 4-4 4" />
            </svg>
          </button>
        </div>
        {expanded.graphs && (
          <div className="nav-children" id="knowledge-graph-navigation" aria-label="Knowledge graph navigation">
            {selected ? (
              <>
                <button
                  className="graph-switch"
                  aria-haspopup="dialog"
                  onClick={() => {
                    setSearch("");
                    setPicking(true);
                  }}
                >
                  <span>
                    <small>Selected graph</small>
                    <strong>{selected.name}</strong>
                  </span>
                  <IconChevronsUpDown />
                </button>
                {(selectedExternal ? externalNavigation : graphNavigation).map((item) => (
                  <Link
                    key={item.id}
                    to={`/p/${selected.id}/${item.path}`}
                    {...(project.corpus ? common(item.id) : { className: "nav-item" })}
                  >
                    <span>{item.label}</span>
                    {item.id === "updates" && project.corpus && project.activity && (
                      <span className={`nav-state-dot ${project.activityTone ?? "busy"}`} aria-label={project.activity} />
                    )}
                  </Link>
                ))}
              </>
            ) : (
              <Link className="nav-item" to={`${base}/graphs`}>
                Choose a graph
              </Link>
            )}
          </div>
        )}
        <Link to={`${base}/activity`} {...common("activity")}>
          <IconPlay />
          <span>Activity</span>
          {!!active.length && (
            <small className="nav-activity-count">
              {active.length} {active.every((e) => e.run.status === "paused") ? "paused" : "ongoing"}
            </small>
          )}
        </Link>
        <div className="nav-footer">
          {activeLabel && (
            <Link
              className={`nav-activity ${project.activityTone ?? "busy"}`}
              to={activeHref ?? (project.corpus ? `/p/${project.id}/graph?tab=updates` : `${base}/runs`)}
            >
              <span className="nav-state-dot" />
              <span>
                {activeLabel}
                <small>{latest?.scope.name ?? project.name}</small>
              </span>
            </Link>
          )}
        </div>
      </nav>
      {pickingOntology &&
        createPortal(
          <Modal
            title="Switch ontology version"
            onClose={() => {
              if (!switchingOntology) setPickingOntology(false);
            }}
          >
            <p>Choose a saved version or draft to work with. Knowledge graphs keep their pinned ontology.</p>
            <label className="field">
              <span>Search ontology versions</span>
              <input value={ontologySearch} onChange={(e) => setOntologySearch(e.target.value)} placeholder="Search versions and drafts…" />
            </label>
            <InlineError error={ontologyError ?? ontologyRevisions.error ?? parent.error} />
            {ontologyRevisions.isLoading ? (
              <LoadingState label="Loading ontology versions…" />
            ) : (
              <div className="graph-picker-list ontology-picker-list">
                {ontologyList.map((revision) => (
                  <button
                    key={revision.id}
                    type="button"
                    disabled={switchingOntology}
                    aria-pressed={revision.id === selectedRevision?.id}
                    onClick={() => void pickOntology(revision.id)}
                  >
                    <span>
                      <strong>
                        {revisionLabel(revision)}
                        {revision.id === parent.data?.currentRevisionId ? " · current" : ""}
                      </strong>
                      <small>
                        {revision.summary || "Ontology"} · {revision.stats.classes} classes
                      </small>
                      <small>{new Date(revision.updatedAt).toLocaleString()}</small>
                    </span>
                    {revision.id === selectedRevision?.id && <span aria-label="Selected ontology">✓</span>}
                  </button>
                ))}
                {!ontologyList.length && <p className="muted">No ontology versions found. Build or import an ontology to get started.</p>}
              </div>
            )}
          </Modal>,
          document.body,
        )}
      {picking &&
        createPortal(
          <Modal
            title="Switch knowledge graph"
            onClose={() => setPicking(false)}
            footer={
              <Link className="btn ghost" to={`${base}/graphs`}>
                All knowledge graphs →
              </Link>
            }
          >
            <label className="field">
              <span>Search knowledge graphs</span>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name…" />
            </label>
            <InlineError error={graphs.error} />
            {graphs.isLoading ? (
              <LoadingState label="Loading knowledge graphs…" />
            ) : (
              <div className="graph-picker-list">
                {list.map((g) => (
                  <Link
                    key={g.id}
                    onClick={() => setPicking(false)}
                    to={
                      g.settings.externalGraph
                        ? `/p/${g.id}/graph`
                        : switchGraphHref(g.id, location.pathname, location.search, !!project.corpus)
                    }
                    aria-current={g.id === selected?.id ? "page" : undefined}
                  >
                    <span>
                      <strong>{g.name}</strong>
                      <small>
                        {g.settings.externalGraph
                          ? "Connected · read only"
                          : `${g.settings.corpus?.members.filter((m) => !m.removed).length ?? 0} documents`}
                      </small>
                    </span>
                    {g.id === selected?.id && <span aria-label="Selected graph">✓</span>}
                  </Link>
                ))}
                {!list.length && <p className="muted">No knowledge graphs found.</p>}
              </div>
            )}
          </Modal>,
          document.body,
        )}
    </>
  );
}
