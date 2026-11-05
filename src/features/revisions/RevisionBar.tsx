// Which revision a page shows, and what can be done with it: switch revision,
// undo/redo edits to the working copy, and the draft → validate → commit flow.

import { Link } from "react-router";
import { listFacts } from "../../lib/ontology/factReview";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import type { OntologyRevision } from "../../types/project";
import type { ValidationIssue } from "../../types/abox";
import { ConfirmButton, InlineError, LoadingState, Modal, StatusBadge, errorMessage, fmtDate } from "../../components/ui/ui";
import { IconRedo, IconUndo } from "../../components/icons";
import { ApiError } from "../../lib/http";

export function revisionLabel(r: OntologyRevision): string {
  if (r.status === "committed") return `Version ${r.number}`;
  const src = {
    extraction: "extraction",
    assistant: "assistant",
    manual: "manual edits",
    import: "import",
    restore: "restore",
    ontology: "ontology change",
    induction: "induced ontology",
    template: "template",
    merge: "merges",
  }[r.source];
  return `Draft · ${src}`;
}

export function CommitDialog({
  revision,
  onClose,
  onCommitted,
}: {
  revision: OntologyRevision;
  onClose: () => void;
  onCommitted?: () => void;
}) {
  const { pid, project, working, select } = useProject();
  const qc = useQueryClient();
  const corpus = !!project?.settings.corpus;
  const [ackCandidates, setAckCandidates] = useState(false);
  const candidates = corpus && working.content?.abox ? listFacts(working.content.abox).filter((f) => f.status === "candidate").length : 0;
  const lost = corpus ? (working.content?.corpus?.losses.filter((l) => l.decision === "pending").length ?? 0) : 0;
  const [ackStale, setAckStale] = useState(false);
  const [ackWarnings, setAckWarnings] = useState(false);
  const diff = useQuery({ queryKey: ["diff", pid, revision.id, revision.contentHash], queryFn: () => api.diff(pid, revision.id) });
  // The change is judged against its parent: what it introduces must validate, older findings don't count against it.
  const check = useQuery({
    queryKey: qk.check(pid, revision.id, revision.contentHash),
    queryFn: async () => {
      await working.flush();
      return api.check(pid, revision.id);
    },
  });
  const stale = revision.parentId !== (project?.currentRevisionId ?? null);
  const commit = useMutation({
    mutationFn: async () => {
      const saved = await working.flush();
      if (!saved && ["saving", "error", "conflict"].includes(working.save))
        throw new Error("Resolve draft saving before saving a version.");
      if (stale && !corpus) await api.rebase(pid, revision.id);
      return api.commit(pid, revision.id, {
        acknowledgedWarnings: ackWarnings,
        acknowledged: ackCandidates,
        expectedHash: check.data?.contentHash,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.project(pid) });
      void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
      void qc.invalidateQueries({ queryKey: qk.revision(pid, revision.id) });
      void qc.invalidateQueries({ queryKey: qk.projects });
      select(null);
      onCommitted?.();
      onClose();
    },
  });
  const c = check.data;
  const errors = c ? [...c.blocking, ...(c.reasoner?.introduced ?? []).filter((i) => i.severity === "error")] : [];
  const warnings = c ? [...c.introduced, ...(c.reasoner?.introduced ?? [])].filter((i) => i.severity !== "error") : [];
  const d = diff.data;
  const blocked = errors.length > 0 || !!lost || (corpus && stale);
  const needsAck = (warnings.length > 0 && !ackWarnings) || (stale && !ackStale) || (!!candidates && !ackCandidates);

  return (
    <Modal
      title={corpus ? "Save graph version" : "Save ontology version"}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => commit.mutate()} disabled={commit.isPending || check.isLoading || blocked || needsAck}>
            {commit.isPending ? "Saving…" : "Save version"}
          </button>
        </>
      }
    >
      <p>
        {corpus
          ? "Saving publishes this graph version with its pinned ontology, source versions and review decisions. Earlier versions stay in history."
          : "Saving makes this the project’s current ontology version. Earlier versions stay in history and can be compared or restored."}
      </p>
      {!!lost && <p className="banner warn">Review {lost} facts losing source support before saving.</p>}
      {corpus && stale && (
        <p className="banner warn">
          A newer graph version was saved.{" "}
          <Link to={`/p/${pid}/graph?tab=updates`}>Prepare an updated draft against the latest version.</Link>
        </p>
      )}
      {!!candidates && (
        <label className="check">
          <input type="checkbox" checked={ackCandidates} onChange={(e) => setAckCandidates(e.target.checked)} />
          Save accepted facts only; leave {candidates} unreviewed facts out of graph answers and exports.
        </label>
      )}
      {diff.isLoading ? (
        <LoadingState label="Comparing…" />
      ) : d ? (
        <ul className="diff-summary">
          <li>
            <b>{d.individuals.added.length}</b> individuals added, <b>{d.individuals.removed.length}</b> removed,{" "}
            <b>{d.individuals.changed.length}</b> changed
          </li>
          {(d.modules.added.length > 0 || d.modules.removed.length > 0 || d.modules.changed.length > 0) && (
            <li>
              Ontology modules: {d.modules.added.length} added, {d.modules.removed.length} removed, {d.modules.changed.length} changed
            </li>
          )}
        </ul>
      ) : (
        <InlineError error={diff.error} />
      )}
      {check.isLoading ? (
        <LoadingState label="Validating the change…" />
      ) : c ? (
        <>
          <p>
            Validation of this change:{" "}
            {blocked ? (
              <StatusBadge tone="alert">
                {errors.length} new error{errors.length === 1 ? "" : "s"}
              </StatusBadge>
            ) : (
              <StatusBadge tone="ok">No new errors</StatusBadge>
            )}{" "}
            {warnings.length > 0 && (
              <StatusBadge tone="warn">
                {warnings.length} new warning{warnings.length === 1 ? "" : "s"}
              </StatusBadge>
            )}{" "}
            {c.resolved.length > 0 && <StatusBadge tone="ok">{c.resolved.length} resolved</StatusBadge>}{" "}
            {c.reasoner &&
              (c.reasoner.consistent ? (
                <StatusBadge tone="ok">Consistent ({c.reasoner.tier.toUpperCase()})</StatusBadge>
              ) : (
                <StatusBadge tone="alert">Inconsistent</StatusBadge>
              ))}
          </p>
          {blocked && (
            <div className="commit-blocked" role="alert">
              <p>Fix these before saving a version (Explore shows them on each individual):</p>
              <IssueList issues={errors} />
            </div>
          )}
          {!blocked && warnings.length > 0 && <IssueList issues={warnings} />}
        </>
      ) : (
        <InlineError error={check.error} />
      )}
      {stale && !corpus && (
        <div className="banner subtle">
          This draft has a different starting point from the current version. Saving will make this draft the current version. The previous
          version stays in history.
        </div>
      )}
      {!blocked && warnings.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={ackWarnings} onChange={(e) => setAckWarnings(e.target.checked)} />
          Save with these warnings — they stay visible on the Validate page
        </label>
      )}
      {stale && (
        <label className="check">
          <input type="checkbox" checked={ackStale} onChange={(e) => setAckStale(e.target.checked)} />
          Make this draft the current version
        </label>
      )}
      {commit.error && (
        <div className="dz-error" role="alert">
          {commit.error instanceof ApiError && commit.error.status === 409 && !/review/i.test(commit.error.message)
            ? "Another revision was committed meanwhile. Close and reopen to review it."
            : errorMessage(commit.error)}
        </div>
      )}
    </Modal>
  );
}

function IssueList({ issues }: { issues: ValidationIssue[] }) {
  const shown = issues.slice(0, 8);
  return (
    <ul className="issue-mini">
      {shown.map((i, n) => (
        <li key={n}>
          <StatusBadge tone={i.severity === "error" ? "alert" : "warn"}>{i.severity === "error" ? "Error" : "Warning"}</StatusBadge>{" "}
          <b>{i.where}</b>: {i.message}
        </li>
      ))}
      {issues.length > shown.length && <li className="muted">…and {issues.length - shown.length} more</li>}
    </ul>
  );
}

export function RevisionBar({ editable = false }: { editable?: boolean }) {
  const { pid, revisions, selectedId, select, working, project } = useProject();
  const qc = useQueryClient();
  const [committing, setCommitting] = useState(false);
  const selected = revisions.find((r) => r.id === selectedId) ?? null;
  const discard = useMutation({
    mutationFn: () => api.discardDraft(pid, selectedId!),
    onSuccess: () => {
      select(null);
      void qc.invalidateQueries({ queryKey: qk.revisions(pid) });
    },
  });
  const sorted = [...revisions].sort((a, b) =>
    a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === "draft" ? -1 : 1,
  );

  if (!revisions.length) return null;
  return (
    <div className="revision-bar" role="toolbar" aria-label={project?.settings.corpus ? "Graph version" : "Ontology version"}>
      <label className="revision-select">
        <span className="sr-only">Version shown</span>
        <select value={selectedId ?? ""} onChange={(e) => select(e.target.value || null)}>
          {sorted.map((r) => (
            <option key={r.id} value={r.id}>
              {revisionLabel(r)}
              {r.id === project?.currentRevisionId ? " (current)" : ""} — {fmtDate(r.updatedAt)}
            </option>
          ))}
        </select>
      </label>
      {selected && selected.status === "draft" ? (
        <StatusBadge tone="warn">Draft — not saved as a version</StatusBadge>
      ) : selected?.id === project?.currentRevisionId ? (
        <StatusBadge tone="ok">Current</StatusBadge>
      ) : (
        <StatusBadge tone="muted">Older version</StatusBadge>
      )}
      {editable && selected?.status === "committed" && <span className="muted hide-narrow">Edits start a new draft</span>}
      <span className="spacer" />
      {editable && (
        <>
          <button
            className="btn ghost sm"
            onClick={working.undo}
            disabled={!working.canUndo}
            title={working.undoLabel ? `Undo ${working.undoLabel}` : "Undo"}
            aria-label="Undo"
          >
            <IconUndo /> <span className="hide-narrow">Undo</span>
          </button>
          <button className="btn ghost sm" onClick={working.redo} disabled={!working.canRedo} aria-label="Redo">
            <IconRedo /> <span className="hide-narrow">Redo</span>
          </button>
        </>
      )}
      {selected?.status === "draft" && (
        <>
          <ConfirmButton label="Discard" confirmLabel="Discard draft" onConfirm={() => discard.mutate()} />
          <button className="btn sm" onClick={() => setCommitting(true)}>
            Validate &amp; save version
          </button>
        </>
      )}
      {working.save === "conflict" && <span className="row-error">{working.saveError}</span>}
      {discard.error && <InlineError error={discard.error} />}
      {committing && selected && <CommitDialog revision={selected} onClose={() => setCommitting(false)} />}
    </div>
  );
}
