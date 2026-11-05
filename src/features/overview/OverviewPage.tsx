import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { useProject } from "../../app/project";
import { useAuth } from "../../app/auth";
import { PageHead } from "../../components/ui/ui";
import { RequirementsSummary } from "./RequirementsSummary";
import { ProjectSettingsCard } from "./ProjectSettingsCard";
import { ProjectDetailsCard } from "./ProjectDetailsCard";
import { GraphDbCard } from "./GraphDbCard";
import "./projectSettings.css";

export default function OverviewPage({ embedded = false }: { embedded?: boolean }) {
  const { pid, project } = useProject();
  const { config } = useAuth();
  const { hash, search } = useLocation();
  const [dirtySections, setDirtySections] = useState<Record<string, boolean>>({});
  const generalDirty = useCallback((dirty: boolean) => setDirtySections((s) => ({ ...s, general: dirty })), []);
  const qualityDirty = useCallback((dirty: boolean) => setDirtySections((s) => ({ ...s, quality: dirty })), []);
  const connectionsDirty = useCallback((dirty: boolean) => setDirtySections((s) => ({ ...s, connections: dirty })), []);
  const sections = [
    { id: "general", label: "General" },
    { id: "requirements", label: "Requirements" },
    { id: "quality", label: "Quality" },
    ...(config?.features?.graphdb ? [{ id: "connections", label: "Connections" }] : []),
  ];
  const active = sections.find((s) => `#${s.id}` === hash)?.id ?? "general";
  const dirty = Object.values(dirtySections).some(Boolean);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <div className={embedded ? "project-settings-page overview-settings" : "page project-settings-page"}>
      <div className="page-wide">
        {embedded ? (
          <div className="overview-settings-heading">
            <h2>Project settings</h2>
            <p>Manage your project’s purpose, requirements and processing preferences.</p>
          </div>
        ) : (
          <PageHead
            title="Project settings"
            actions={
              <Link className="btn ghost" to={`/p/${pid}`}>
                Project overview →
              </Link>
            }
          >
            Manage {project?.name ?? "your project"}’s purpose, requirements and processing preferences.
          </PageHead>
        )}
        <nav className="project-settings-nav" aria-label="Project settings sections">
          {sections.map((section) => (
            <Link key={section.id} to={{ search, hash: `#${section.id}` }} aria-current={active === section.id ? "page" : undefined}>
              {section.label}
              {dirtySections[section.id] && <span className="settings-dirty-dot" aria-label="unsaved changes" />}
            </Link>
          ))}
        </nav>
        {/* Keep editors mounted so section changes preserve unfinished work. */}
        <div hidden={active !== "general"}>
          <ProjectDetailsCard onDirtyChange={generalDirty} />
        </div>
        <div hidden={active !== "requirements"}>
          <RequirementsSummary />
        </div>
        <div hidden={active !== "quality"}>
          <ProjectSettingsCard onDirtyChange={qualityDirty} />
          <p className="project-settings-note">
            New knowledge graphs start with this project’s model preferences. Existing graphs have their own graph settings.
          </p>
        </div>
        {config?.features?.graphdb && (
          <div hidden={active !== "connections"}>
            <GraphDbCard onDirtyChange={connectionsDirty} />
          </div>
        )}
      </div>
    </div>
  );
}
