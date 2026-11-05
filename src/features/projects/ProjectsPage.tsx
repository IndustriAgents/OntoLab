// Project dashboard: create a workspace, open, rename, archive, delete, import; recent activity and job
// status; the bundled sample.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qk } from "../../lib/projectApi";
import type { ProjectSummary } from "../../types/project";
import {
  ConfirmButton,
  EmptyState,
  ErrorState,
  InlineError,
  LoadingState,
  Modal,
  PageHead,
  StatusBadge,
  fmtDate,
} from "../../components/ui/ui";
import { IconPlus, IconUpload } from "../../components/icons";
import { RunStatusBadge } from "../runs/RunStatusBadge";

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), purpose: purpose.trim() }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.projects });
      navigate(`/p/${p.id}/workflows/tbox`);
    },
  });
  const ready = !!name.trim();
  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create project"}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !create.isPending) create.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="np-name">Name</label>
          <input
            id="np-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Supplier contracts 2026"
            maxLength={200}
            ref={nameRef}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="np-purpose">Purpose (optional)</label>
          <textarea
            id="np-purpose"
            rows={3}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="What should this knowledge graph let people answer?"
          />
        </div>
        <InlineError error={create.error} />
      </form>
    </Modal>
  );
}

function ProjectRow({ p }: { p: ProjectSummary }) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  const renameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) renameRef.current?.focus();
  }, [renaming]);
  const update = useMutation({
    mutationFn: (body: { name?: string; archived?: boolean }) => api.updateProject(p.id, body),
    onSuccess: () => {
      setRenaming(false);
      void qc.invalidateQueries({ queryKey: qk.projects });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteProject(p.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.projects }),
  });
  return (
    <tr className={p.archived ? "is-archived" : ""}>
      <td data-label="Project">
        {renaming ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) update.mutate({ name });
            }}
          >
            <input aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} ref={renameRef} />
            <button className="btn sm" type="submit" disabled={!name.trim()}>
              Save
            </button>
            <button className="btn ghost sm" type="button" onClick={() => (setRenaming(false), setName(p.name))}>
              Cancel
            </button>
          </form>
        ) : (
          <Link to={`/p/${p.id}`} className="row-link">
            {p.name}
          </Link>
        )}
        {p.purpose && <div className="row-sub">{p.purpose}</div>}
      </td>
      <td data-label="Ontology">{p.revisionNumber ? `Revision ${p.revisionNumber}` : <span className="muted">No ontology yet</span>}</td>
      <td data-label="Documents">{p.documentCount}</td>
      <td data-label="Status">
        {p.activeRun ? (
          <RunStatusBadge status={p.activeRun.status} />
        ) : p.archived ? (
          <StatusBadge tone="muted">Archived</StatusBadge>
        ) : (
          <span className="muted">Idle</span>
        )}
      </td>
      <td data-label="Updated">{fmtDate(p.updatedAt)}</td>
      <td className="project-actions-cell">
        <div className="project-actions">
          <button className="btn ghost sm" onClick={() => setRenaming(true)}>
            Rename
          </button>
          <button className="btn ghost sm" onClick={() => update.mutate({ archived: !p.archived })}>
            {p.archived ? "Unarchive" : "Archive"}
          </button>
          <ConfirmButton label="Delete" confirmLabel="Delete permanently" onConfirm={() => remove.mutate()} disabled={remove.isPending} />
        </div>
        {(update.error || remove.error) && <InlineError error={update.error ?? remove.error} />}
      </td>
    </tr>
  );
}

export default function ProjectsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.listProjects });
  const sample = useMutation({
    mutationFn: api.createSample,
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.projects });
      navigate(`/p/${p.id}`);
    },
  });
  const importer = useMutation({
    mutationFn: (f: File) => api.importArchive(f),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.projects });
      navigate(`/p/${p.id}`);
    },
  });

  const list = (projects.data ?? []).filter((p) => showArchived || !p.archived);
  const archivedCount = (projects.data ?? []).filter((p) => p.archived).length;

  return (
    <div className={embedded ? "page projects-page projects-embedded" : "page projects-page"}>
      <div className="page-wide">
        <PageHead
          title="Projects"
          actions={
            <>
              <button className="btn ghost" onClick={() => fileRef.current?.click()} disabled={importer.isPending}>
                <IconUpload /> {importer.isPending ? "Importing…" : "Import archive"}
              </button>
              {!!projects.data?.length && (
                <button className="btn ghost" onClick={() => sample.mutate()} disabled={sample.isPending}>
                  {sample.isPending ? "Creating sample…" : "Open the sample project"}
                </button>
              )}
              <button className="btn" onClick={() => setCreating(true)}>
                <IconPlus /> New project
              </button>
            </>
          }
        >
          Each project turns a set of documents into a knowledge graph: its requirements, ontology, documents, runs and every committed
          revision.
        </PageHead>
        <input
          ref={fileRef}
          type="file"
          accept=".gz,.json,application/gzip,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importer.mutate(f);
            e.target.value = "";
          }}
        />
        <InlineError error={importer.error ?? sample.error} />

        {projects.isLoading ? (
          <LoadingState label="Loading projects…" />
        ) : projects.error ? (
          <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        ) : !projects.data?.length ? (
          <EmptyState
            title="No projects yet"
            action={
              <>
                <button className="btn" onClick={() => setCreating(true)}>
                  New project
                </button>
                <button className="btn ghost" onClick={() => sample.mutate()} disabled={sample.isPending}>
                  {sample.isPending ? "Creating sample…" : "Open the sample project"}
                </button>
              </>
            }
          >
            Create a project, then choose its ontology starting point: documents, a template, or an existing ontology. The sample includes a
            technical manual and its ontology.
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table projects-table">
                <caption className="sr-only">Your projects</caption>
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Ontology</th>
                    <th scope="col">Documents</th>
                    <th scope="col">Status</th>
                    <th scope="col">Updated</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <ProjectRow key={p.id} p={p} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              {archivedCount > 0 && (
                <label className="check">
                  <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show {archivedCount}{" "}
                  archived
                </label>
              )}
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => sample.mutate()} disabled={sample.isPending}>
                {sample.isPending ? "Creating sample…" : "Add sample project"}
              </button>
            </div>
          </>
        )}
      </div>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}
