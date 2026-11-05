import { PublishVersionCard } from "../connections/PublishVersionCard";
// Export: Turtle from the current committed revision, or from a draft only
// when it is explicitly selected; validation reports; the portable project
// archive (the pilot's backup mechanism).

import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { ApiError } from "../../lib/http";
import { EmptyState, InlineError, PageHead, StatusBadge } from "../../components/ui/ui";
import { IconDownload } from "../../components/icons";
import { RevisionBar, revisionLabel } from "../revisions/RevisionBar";

export default function ExportPage() {
  const { pid, selectedId, revisions, project, current } = useProject();
  const [scope, setScope] = useState<"combined" | "abox" | "tbox">("combined");
  const [ack, setAck] = useState(false);
  const [provenance, setProvenance] = useState<"none" | "source" | "reified">("source");
  const selected = revisions.find((r) => r.id === selectedId) ?? null;
  const report = useQuery({
    queryKey: qk.report(pid, selectedId ?? "none"),
    queryFn: () => api.report(pid, selectedId!),
    enabled: !!selectedId,
  });
  const ttl = useMutation({ mutationFn: () => api.downloadTurtle(pid, selectedId!, scope, ack, provenance) });
  const archive = useMutation({ mutationFn: () => api.downloadArchive(pid) });
  const needsAck = ttl.error instanceof ApiError && ttl.error.status === 409;

  if (!current)
    return (
      <div className="page">
        <EmptyState
          title="Nothing to export yet"
          action={
            <Link className="btn" to={`/p/${pid}/ontology`}>
              Set up the ontology
            </Link>
          }
        />
      </div>
    );

  return (
    <div className="page-flex">
      <RevisionBar />
      <div className="page">
        <div className="page-wide">
          <PageHead title="Export">
            Download RDF, validation reports or a portable workspace archive. Graph workspace archives include their ontology package;
            project archives keep each graph workspace separate.
          </PageHead>

          <PublishVersionCard />
          <section className="card" aria-labelledby="ex-rdf">
            <div className="card-head">
              <h3 id="ex-rdf">RDF (Turtle)</h3>
              {selected && <span className="file">{revisionLabel(selected)}</span>}
            </div>
            {selected?.status === "draft" && (
              <div className="banner subtle" role="status">
                You are exporting a draft that has not been committed. Select the current revision above to export committed data.
              </div>
            )}
            <fieldset className="fieldset">
              <legend>Content</legend>
              {(
                [
                  ["combined", "Ontology + individuals", "One file: every T-Box module followed by the A-Box."],
                  ["abox", "Individuals only (A-Box)", "Imports the ontology by its IRI where declared."],
                  ["tbox", "Ontology only (T-Box)", "All modules merged."],
                ] as const
              ).map(([id, label, hint]) => (
                <label key={id} className="radio">
                  <input type="radio" name="scope" checked={scope === id} onChange={() => (setScope(id), ttl.reset())} />
                  <span>
                    {label}
                    <span className="row-sub">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {scope !== "tbox" && (
              <fieldset className="fieldset">
                <legend>Provenance</legend>
                {(
                  [
                    ["source", "Source notes", "Each individual's quoted source as dcterms:source."],
                    [
                      "reified",
                      "Full provenance (PROV-O)",
                      "Every claim as a statement with its quote and character offsets (Web Annotation), the run that made it, its confidence and its review state.",
                    ],
                    ["none", "Facts only", "No provenance."],
                  ] as const
                ).map(([id, label, hint]) => (
                  <label key={id} className="radio">
                    <input type="radio" name="provenance" checked={provenance === id} onChange={() => (setProvenance(id), ttl.reset())} />
                    <span>
                      {label}
                      <span className="row-sub">{hint}</span>
                    </span>
                  </label>
                ))}
                <span className="field-hint">
                  Facts rejected in review are never exported
                  {project?.settings.reviewPolicy === "accepted-only"
                    ? "; with this project's policy, facts waiting for review are left out too"
                    : ""}
                  .
                </span>
              </fieldset>
            )}
            <p>
              Validation:{" "}
              {!report.data ? (
                <span className="muted">
                  not validated —{" "}
                  <Link to={`/p/${pid}/validate${selected?.status === "draft" ? `?rev=${selectedId}` : ""}`}>validate first</Link>
                </span>
              ) : report.data.stale ? (
                <StatusBadge tone="warn">Report is stale</StatusBadge>
              ) : report.data.counts.errors ? (
                <StatusBadge tone="alert">{report.data.counts.errors} errors</StatusBadge>
              ) : (
                <StatusBadge tone="ok">No errors</StatusBadge>
              )}
            </p>
            {needsAck && (
              <label className="check attention">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                {ttl.error instanceof Error ? ttl.error.message : ""} Export anyway.
              </label>
            )}
            {!needsAck && <InlineError error={ttl.error} />}
            <div className="row-actions">
              <button className="btn" onClick={() => ttl.mutate()} disabled={!selectedId || ttl.isPending || (needsAck && !ack)}>
                <IconDownload /> {ttl.isPending ? "Preparing…" : "Download .ttl"}
              </button>
            </div>
          </section>

          <section className="card" aria-labelledby="ex-report">
            <div className="card-head">
              <h3 id="ex-report">Validation report</h3>
            </div>
            {report.data ? (
              <div className="row-actions">
                <button className="btn ghost" onClick={() => void api.downloadReport(pid, selectedId!, "md")}>
                  <IconDownload /> Markdown
                </button>
                <button className="btn ghost" onClick={() => void api.downloadReport(pid, selectedId!, "json")}>
                  <IconDownload /> JSON
                </button>
              </div>
            ) : (
              <p className="muted">
                Validate this revision on the <Link to={`/p/${pid}/validate`}>Validate</Link> page first.
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="ex-archive">
            <div className="card-head">
              <h3 id="ex-archive">Workspace archive</h3>
            </div>
            <p>
              A portable backup of “{project?.name}”, including retained source versions, graph and ontology history, extraction evidence
              and conversations. Project backups include their separate graph workspaces; graph backups include only that workspace and its
              ontology package. Import from Projects to restore a new workspace.
            </p>
            <InlineError error={archive.error} />
            <div className="row-actions">
              <button className="btn" onClick={() => archive.mutate()} disabled={archive.isPending}>
                <IconDownload /> {archive.isPending ? "Preparing…" : "Download archive"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
