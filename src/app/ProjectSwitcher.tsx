import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, qk } from "../lib/projectApi";
import { IconChevronsUpDown } from "../components/icons";

export function ProjectSwitcher({ project }: { project: { id: string; name: string; corpus?: { parentId: string; parentName: string } } }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.listProjects, enabled: open });
  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    searchInput.current?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const list = (projects.data ?? []).filter(
    (p) => !p.archived && !p.settings.corpus && p.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div
      className="project-switcher"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        className="project-switch"
        aria-expanded={open}
        aria-controls="project-switch-panel"
        onClick={() => {
          setSearch("");
          setOpen(!open);
        }}
      >
        <span className="ws-mark" aria-hidden="true">
          {(project.corpus?.parentName ?? project.name).slice(0, 1).toUpperCase()}
        </span>
        <span className="ws-text">
          <strong>{project.corpus?.parentName ?? project.name}</strong>
          <small>Project · switch</small>
        </span>
        <IconChevronsUpDown className="ws-chevron" />
      </button>
      {open && (
        <div className="project-switch-panel" id="project-switch-panel" role="region" aria-label="Switch project">
          <input
            ref={searchInput}
            aria-label="Search projects"
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="project-switch-list">
            {projects.isLoading && <p role="status">Loading projects…</p>}
            {projects.error && (
              <div role="alert">
                <p>Could not load projects.</p>
                <button className="btn ghost sm" onClick={() => void projects.refetch()}>
                  Retry
                </button>
              </div>
            )}
            {!projects.isLoading && !projects.error && !list.length && <p>No projects found.</p>}
            {list.map((p) => (
              <Link
                key={p.id}
                to={`/p/${p.id}`}
                className="project-switch-option"
                aria-current={p.id === (project.corpus?.parentId ?? project.id) ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                <span>{p.name}</span>
                {p.id === (project.corpus?.parentId ?? project.id) && <span aria-label="Current project">✓</span>}
              </Link>
            ))}
          </div>
          <Link
            className="project-switch-manage"
            to="/settings?section=projects"
            state={{ settingsReturnTo: location.pathname + location.search }}
          >
            Manage projects →
          </Link>
        </div>
      )}
    </div>
  );
}
