import { AgentPanel } from "../features/agent/AgentPanel";
import { useAgentPanelResize } from "../features/agent/useAgentPanelResize";
import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ThemeToggle } from "../components/ThemeToggle";
import { IconClose, IconMenu, IconSpark } from "../components/icons";
import { ProjectNavigation } from "./ProjectNavigation";
import { graphReturnState, navigationSelection } from "./navigation";
import "./navigation.css";
import "../features/workflows/workflows.css";
import { useTheme } from "./theme";
import type { SaveState } from "./project";
import { AccountMenu } from "./AccountMenu";
import { SettingsLayout } from "./SettingsLayout";
import "../features/settings/settings.css";

export interface ProjectNavInfo {
  external?: boolean;
  flush?: () => Promise<string | null>;
  corpus?: { parentId: string; parentName: string };
  id: string;
  name: string;
  save: SaveState;
  saveError: string | null;
  activity: string | null;
  activityTone?: "busy" | "attention" | "error";
}

function SaveIndicator({ save, error }: { save: SaveState; error: string | null }) {
  if (save === "idle") return null;
  const text = { saving: "Saving…", saved: "Saved", error: "Save failed", conflict: "Save conflict", idle: "" }[save];
  return (
    <span className={`save-state save-${save}`} role="status" aria-live="polite" title={error ?? undefined}>
      <span className="badge-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

export function AppShell({ project, children }: { project?: ProjectNavInfo; children: ReactNode }) {
  const { theme, toggle } = useTheme();
  const [agentOpen, setAgentOpen] = useState(false);
  const agentLauncher = useRef<HTMLButtonElement>(null);
  const closeAgent = useCallback(() => {
    setAgentOpen(false);
    requestAnimationFrame(() => agentLauncher.current?.focus());
  }, []);
  const [navOpen, setNavOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return localStorage.getItem("ontolab-sidebar-hidden") === "true";
    } catch {
      return false;
    }
  });
  const toggleSidebar = () =>
    setSidebarHidden((value) => {
      try {
        localStorage.setItem("ontolab-sidebar-hidden", String(!value));
      } catch {
        /* Storage may be unavailable. */
      }
      return !value;
    });
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const open = (event: Event) => {
      const destination = (event as CustomEvent<unknown>).detail;
      if (typeof destination !== "string" || !/^\/p\/[A-Za-z0-9_-]+\//.test(destination)) return;
      event.preventDefault();
      void (async () => {
        const saved = await project?.flush?.();
        if (project?.flush && !saved && ["saving", "error", "conflict"].includes(project.save)) return;
        navigate(destination);
      })().catch(() => {
        /* The editor keeps its content and reports the save failure. */
      });
    };
    window.addEventListener("ontolab-open", open);
    return () => window.removeEventListener("ontolab-open", open);
  }, [navigate, project]);
  const isSettings = location.pathname === "/settings";
  const agentResize = useAgentPanelResize(agentOpen && !!project && !isSettings, sidebarHidden);

  // close the drawer on navigation, Escape, or when the viewport grows
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!navOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const sidebar = document.getElementById("app-sidebar");
    sidebar?.querySelector<HTMLElement>(".nav-close")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === "Escape") setNavOpen(false);
      if (e.key !== "Tab" || !sidebar) return;
      const controls = [
        ...sidebar.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled)"),
      ].filter((element) => element.offsetParent !== null);
      const first = controls[0],
        last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    const mq = window.matchMedia("(min-width: 861px)");
    const onWide = () => mq.matches && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onWide);
    document.body.classList.add("nav-locked");
    return () => {
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onWide);
      document.body.classList.remove("nav-locked");
      if (previous?.isConnected) previous.focus();
    };
  }, [navOpen]);

  if (isSettings)
    return (
      <SettingsLayout>
        {children}
      </SettingsLayout>
    );

  const base = project ? `/p/${project.id}` : "";
  const projectBase = project?.corpus ? `/p/${project.corpus.parentId}` : base;
  const selection = navigationSelection(location.pathname, location.search, !!project?.corpus);
  const returnGraph = graphReturnState(location.state);
  const pageLabel = project?.external
    ? location.pathname.endsWith("/assistant")
      ? "Ask"
      : new URLSearchParams(location.search).get("tab") === "settings"
        ? "Graph settings"
        : new URLSearchParams(location.search).get("tab") === "query"
          ? "Query"
          : "Explore"
    : location.pathname.endsWith("/assistant")
      ? "Ask"
      : location.pathname.endsWith("/sparql")
        ? "SPARQL"
        : location.pathname.endsWith("/export")
          ? "Export"
          : selection.label;

  return (
    <div
      ref={agentResize.shellRef}
      style={agentResize.style}
      className={
        "shell" +
        (agentOpen ? " agent-open" : "") +
        (agentResize.dragging ? " agent-resizing" : "") +
        (!project ? " projects-shell" : sidebarHidden ? " sidebar-hidden" : "")
      }
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {project && (
        <aside className={"sidebar" + (navOpen ? " is-open" : "")} id="app-sidebar" aria-label="Navigation">
          <div className="sidebar-head">
            <NavLink to="/" className="brand" aria-label="OntoLab — all projects">
              <span className="brand-name">
                onto<span>lab</span>
              </span>
            </NavLink>
            <button className="icon-btn sidebar-collapse" aria-label="Hide sidebar" title="Hide sidebar" onClick={toggleSidebar}>
              <IconMenu />
            </button>
            <button className="nav-close" onClick={() => setNavOpen(false)} aria-label="Close menu">
              <IconClose />
            </button>
          </div>

          {project && <ProjectSwitcher project={project} />}

          <ProjectNavigation key={project.corpus?.parentId ?? project.id} project={project} />

          <button
            ref={agentLauncher}
            className={"nav-item agent-launcher" + (agentOpen ? " is-active" : "")}
            aria-expanded={agentOpen}
            aria-controls="ontolab-ai-panel"
            onClick={() => {
              setAgentOpen((open) => !open);
              setNavOpen(false);
            }}
          >
            <IconSpark />
            <span>OntoLab AI</span>
          </button>
          <AccountMenu
            beforeDocs={async () => {
              const saved = await project.flush?.();
              return !project.flush || !!saved || !["saving", "error", "conflict"].includes(project.save);
            }}
          />
        </aside>
      )}

      {project && navOpen && <button className="nav-scrim" aria-label="Close menu" onClick={() => setNavOpen(false)} />}

      <main ref={agentResize.workspaceRef} className="main" id="main" tabIndex={-1}>
        <header className="topbar">
          {project && sidebarHidden && (
            <button className="icon-btn sidebar-expand" aria-label="Show sidebar" title="Show sidebar" onClick={toggleSidebar}>
              <IconMenu />
            </button>
          )}
          {project && (
            <button
              className="icon-btn nav-toggle"
              onClick={() => setNavOpen(true)}
              aria-label="Open menu"
              aria-controls="app-sidebar"
              aria-expanded={navOpen}
            >
              <IconMenu />
            </button>
          )}
          <span className="crumb">
            {project ? (
              <>
                <NavLink to="/">Projects</NavLink> / <NavLink to={projectBase}>{project.corpus?.parentName ?? project.name}</NavLink>
                {project.corpus ? (
                  <>
                    {" / "}
                    <NavLink to={`${projectBase}/graphs`}>Knowledge graphs</NavLink>
                    {" / "}
                    <NavLink to={`${base}/graph`}>{project.name}</NavLink>
                  </>
                ) : selection.area === "ontology" && selection.id !== "ontology" ? (
                  <>
                    {" / "}
                    <NavLink to={`${projectBase}/ontology/overview`}>Ontology</NavLink>
                  </>
                ) : null}
                {" / "}
                <b className="topbar-project">{pageLabel}</b>
              </>
            ) : (
              <b>Projects</b>
            )}
          </span>
          {project && <SaveIndicator save={project.save} error={project.saveError} />}
          <span className="spacer" />
          <ThemeToggle theme={theme} onToggle={toggle} />
          {!project && <AccountMenu placement="topbar" />}
        </header>
        {project && !project.corpus && returnGraph && (
          <div className="scope-return">
            <NavLink to={returnGraph.to}>← Return to {returnGraph.name}</NavLink>
            <span className="muted"> · Viewing its ontology in {project.name}</span>
          </div>
        )}
        {children}
      </main>
      {project && agentOpen && <AgentPanel onClose={closeAgent} resizeHandle={agentResize.handle} />}
    </div>
  );
}
