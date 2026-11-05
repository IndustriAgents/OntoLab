import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { connectionsApi, connectionKey } from "../../lib/connectionsApi";
import { qk } from "../../lib/projectApi";
import { corpusKeys } from "../../lib/corpusApi";
import { InlineError, Modal, StatusBadge } from "../../components/ui/ui";
import "./connections.css";
export function PublishVersionCard() {
  const { pid, project, revisions, selectedId } = useProject(),
    qc = useQueryClient();
  const navigate = useNavigate();
  const connections = useQuery({ queryKey: connectionKey, queryFn: connectionsApi.list });
  const [cid, setCid] = useState(""),
    [confirm, setConfirm] = useState(false);
  const selected = connections.data?.filter((c) => c.publishEndpoint && c.provider !== "neo4j").find((c) => c.id === cid);
  const revision = revisions.find((r) => r.id === selectedId);
  const publish = useMutation({
    mutationFn: () => connectionsApi.publish(pid, selectedId!, selected!.id),
    onSuccess: () => {
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: qk.project(pid) });
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: qk.project(pid) });
    },
  });
  const open = useMutation({
    mutationFn: (publication: { connectionId: string; graph: string }) =>
      connectionsApi.connect(project!.settings.corpus?.parentProjectId ?? pid, {
        name: `${project!.name} · published version`,
        connectionId: publication.connectionId,
        graph: publication.graph,
      }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: corpusKeys.list(project!.settings.corpus?.parentProjectId ?? pid) });
      navigate(`/p/${p.id}/graph`);
    },
  });
  return (
    <section className="card publication-card">
      <h2>Publish a saved version</h2>
      <p>
        Write this version to a fresh named graph in an RDF database. Earlier publications stay available. Publishing does not enable
        automatic synchronization.
      </p>
      <label className="field">
        <span>Publishing connection</span>
        <select value={cid} onChange={(e) => setCid(e.target.value)}>
          <option value="">Choose a connection</option>
          {connections.data
            ?.filter((c) => c.publishEndpoint && c.provider !== "neo4j")
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <div className="connection-actions">
        <button
          className="btn"
          disabled={!selected || revision?.status !== "committed" || publish.isPending}
          onClick={() => {
            publish.reset();
            setConfirm(true);
          }}
        >
          Publish version {revision?.number ?? ""}
        </button>
        <Link className="btn ghost" to="/settings?section=connections">
          Manage connections →
        </Link>
      </div>
      {revision?.status !== "committed" && <p className="field-hint">Choose a saved version above before publishing.</p>}
      <InlineError error={connections.error} />
      {publish.isSuccess && (
        <p className="connection-success" role="status">
          Version published. Named graph: <code>{publish.data.publication.graph}</code>
        </p>
      )}
      {publish.isSuccess && (
        <button className="btn ghost sm" disabled={open.isPending} onClick={() => open.mutate(publish.data.publication)}>
          Open published graph →
        </button>
      )}
      <InlineError error={open.error} />
      {!!project?.settings.publications?.length && (
        <details className="method-details">
          <summary>Publication history ({project.settings.publications.length})</summary>
          <div className="method-details-body">
            {[...project.settings.publications].reverse().map((p) => (
              <div className="publication-row" key={p.id}>
                <div>
                  <StatusBadge tone={p.status === "published" ? "ok" : p.status === "failed" ? "alert" : "muted"}>{p.status}</StatusBadge> ·{" "}
                  {new Date(p.createdAt).toLocaleString()}
                </div>
                <span>
                  {connections.data?.find((c) => c.id === p.connectionId)?.name ?? "Disconnected connection"} · Connection v
                  {p.connectionVersion}
                </span>
                <code>{p.graph}</code>
                {p.error && <p>{p.error}</p>}
              </div>
            ))}
          </div>
        </details>
      )}
      {confirm && (
        <Modal
          title="Publish to external database?"
          onClose={() => {
            if (!publish.isPending) setConfirm(false);
          }}
          footer={
            <>
              <button className="btn ghost" disabled={publish.isPending} onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button className="btn" disabled={publish.isPending} onClick={() => publish.mutate()}>
                {publish.isPending ? "Publishing…" : "Publish saved version"}
              </button>
            </>
          }
        >
          <p>
            Publish version {revision?.number} of <strong>{project?.name}</strong> to <strong>{selected?.name}</strong>?
          </p>
          <p>
            This creates a new named graph containing the ontology and facts allowed by this workspace’s review policy. The current data in
            the database stays intact.
          </p>
          <InlineError error={publish.error} />
        </Modal>
      )}
    </section>
  );
}
