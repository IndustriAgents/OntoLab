import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { InlineError } from "../../components/ui/ui";

export function ProjectDetailsCard({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { pid, project } = useProject();
  const qc = useQueryClient();
  const savedName = project?.name ?? "";
  const savedPurpose = project?.purpose ?? "";
  const savedScope = project?.scope ?? "";
  const [name, setName] = useState(savedName);
  const [purpose, setPurpose] = useState(savedPurpose);
  const [scope, setScope] = useState(savedScope);
  useEffect(() => setName(savedName), [savedName]);
  useEffect(() => setPurpose(savedPurpose), [savedPurpose]);
  useEffect(() => setScope(savedScope), [savedScope]);
  const dirty = name.trim() !== savedName || purpose !== savedPurpose || scope !== savedScope;
  const invalid = !name.trim();
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const save = useMutation({
    mutationFn: () => api.updateProject(pid, { name: name.trim(), purpose, scope }),
    onSuccess: (p) => {
      qc.setQueryData(qk.project(pid), p);
      void qc.invalidateQueries({ queryKey: qk.projects });
      setName(p.name);
    },
  });
  return (
    <div className="project-general-layout">
      <form
        className="card project-details-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !invalid && !save.isPending) save.mutate();
        }}
        aria-labelledby="project-details-heading"
      >
        <div className="project-settings-section-head">
          <h2 id="project-details-heading">Project details</h2>
          <p>Give your project a clear name and describe what you want to learn.</p>
        </div>
        <fieldset className="project-details-fields" disabled={save.isPending}>
          <div className="field">
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              required
              aria-invalid={invalid}
              aria-describedby={invalid ? "project-name-error" : undefined}
            />
            {invalid && (
              <p id="project-name-error" className="pqs-budget-error" role="alert">
                Enter a project name.
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="project-purpose">
              Purpose <span className="project-field-optional">Optional</span>
            </label>
            <p id="project-purpose-hint" className="project-input-hint">
              What should people be able to learn or do with this project?
            </p>
            <textarea
              id="project-purpose"
              rows={3}
              maxLength={10000}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              aria-describedby="project-purpose-hint"
              placeholder="For example, connect findings across research papers to compare the evidence behind scientific claims."
            />
          </div>
          <div className="field">
            <label htmlFor="project-scope">
              Scope <span className="project-field-optional">Optional</span>
            </label>
            <p id="project-scope-hint" className="project-input-hint">
              Which topics and sources belong here? What should be left out?
            </p>
            <textarea
              id="project-scope"
              rows={3}
              maxLength={10000}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              aria-describedby="project-scope-hint"
              placeholder="For example, include published studies, methods and datasets; exclude unsupported opinions."
            />
          </div>
        </fieldset>
        <div className="pqs-footer">
          <span className="pqs-save-status" role="status">
            {save.isPending ? "Saving…" : dirty ? "Unsaved changes" : save.isSuccess ? "Changes saved" : "All changes saved"}
          </span>
          <InlineError error={save.error} />
          {dirty && (
            <button
              type="button"
              className="btn ghost"
              disabled={save.isPending}
              onClick={() => {
                setName(savedName);
                setPurpose(savedPurpose);
                setScope(savedScope);
                save.reset();
              }}
            >
              Discard changes
            </button>
          )}
          <button className="btn" type="submit" disabled={!dirty || invalid || save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
      <aside className="project-settings-help" aria-label="About project settings">
        <h2>A shared direction</h2>
        <p>Purpose and scope give context to AI suggestions and help you keep the ontology focused.</p>
        <Link to="#requirements">Define questions to answer →</Link>
        <div className="project-settings-help-divider" />
        <h2>Looking for other settings?</h2>
        <p>Manage documents, extraction and the saved ontology each graph uses in its workspace.</p>
        <Link to={`/p/${pid}/graphs`}>Open knowledge graphs →</Link>
        <p>Model connections, appearance and storage live in your account settings.</p>
        <Link to="/settings">Account & workspace →</Link>
      </aside>
    </div>
  );
}
