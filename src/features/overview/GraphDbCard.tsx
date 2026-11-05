// GraphDB (shown when the server has one configured): pick the repository this
// project publishes to, write the current revision into it, and Ask can then
// answer from GraphDB through its MCP server.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { api, qk } from "../../lib/projectApi";
import { ApiError } from "../../lib/http";
import { InlineError, StatusBadge, fmtDate } from "../../components/ui/ui";

export function GraphDbCard({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { pid, project, current } = useProject();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["graphdb-status"], queryFn: api.graphdbStatus, staleTime: 30_000 });
  const saved = project?.settings.graphdb ?? {};
  const [repository, setRepository] = useState(saved.repository ?? "");
  const [graph, setGraph] = useState(saved.graph ?? "");
  const [needsAck, setNeedsAck] = useState(false);
  useEffect(() => {
    setRepository(saved.repository ?? "");
    setGraph(saved.graph ?? "");
  }, [saved.repository, saved.graph]);

  const save = useMutation({
    mutationFn: () => api.updateProject(pid, { settings: { ...project!.settings, graphdb: { ...saved, repository, graph } } }),
    onSuccess: (p) => qc.setQueryData(qk.project(pid), p),
  });
  const publish = useMutation({
    mutationFn: (acknowledged: boolean) => api.publishGraphDb(pid, current!.id, { repository, graph, acknowledged }),
    onSuccess: () => {
      setNeedsAck(false);
      void qc.invalidateQueries({ queryKey: qk.project(pid) });
    },
    onError: (e) => setNeedsAck(e instanceof ApiError && e.isConflict),
  });

  const s = status.data;
  const repos = s?.repositories ?? [];
  const dirty = repository !== (saved.repository ?? "") || graph !== (saved.graph ?? "");
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const pub = saved.published;
  return (
    <section className="card" aria-labelledby="ov-graphdb">
      <div className="card-head">
        <h3 id="ov-graphdb">GraphDB</h3>
        {status.isPending ? (
          <StatusBadge tone="muted">Checking…</StatusBadge>
        ) : s?.reachable ? (
          <StatusBadge tone={s.mcp ? "ok" : "warn"}>{s.mcp ? "Connected" : "Connected"}</StatusBadge>
        ) : (
          <StatusBadge tone="alert">Unreachable</StatusBadge>
        )}
      </div>
      <p className="field-hint">
        Legacy server connection. Publish a saved version to a new named graph, then ask questions about that publication.
        {s?.url && (
          <>
            {" "}
            Server:{" "}
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.url}
            </a>
            .
          </>
        )}
      </p>
      {s?.error && <p className="dz-error">{s.error}</p>}
      <div className="field-row">
        <div className="field">
          <label htmlFor="gdb-repo">Repository</label>
          <select id="gdb-repo" value={repository} onChange={(e) => setRepository(e.target.value)} disabled={!repos.length}>
            <option value="">{repos.length ? "Choose a repository" : "No repositories found"}</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
            {repository && !repos.includes(repository) && <option value={repository}>{repository} (not found)</option>}
          </select>
        </div>
        <div className="field">
          <label htmlFor="gdb-graph">Named graph</label>
          <input id="gdb-graph" value={graph} onChange={(e) => setGraph(e.target.value)} placeholder={`urn:ontolab:project:${pid}`} />
        </div>
      </div>
      <p className="field-hint">
        {pub
          ? `Revision ${pub.revisionNumber} was published ${fmtDate(pub.at)} into ${pub.graph} (${pub.triples.toLocaleString()} triples).`
          : "Nothing published yet. Each publication creates a fresh named graph and preserves earlier publications."}
        {pub && current && pub.revisionId !== current.id && ` The current revision is ${current.number}.`}
      </p>
      <div className="row-actions">
        <span className="pqs-save-status" role="status">
          {save.isPending ? "Saving…" : dirty ? "Unsaved changes" : save.isSuccess ? "Connection saved" : "All changes saved"}
        </span>
        {dirty && (
          <button
            className="btn ghost sm"
            disabled={save.isPending}
            onClick={() => {
              setRepository(saved.repository ?? "");
              setGraph(saved.graph ?? "");
              save.reset();
            }}
          >
            Discard changes
          </button>
        )}
        <button className="btn ghost sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save connection"}
        </button>
        <button
          className="btn sm"
          disabled={!repository || !current || publish.isPending || !s?.reachable}
          onClick={() => publish.mutate(false)}
        >
          {publish.isPending ? "Publishing…" : `Publish revision ${current?.number ?? ""}`}
        </button>
        {needsAck && (
          <button className="btn ghost sm danger" disabled={publish.isPending} onClick={() => publish.mutate(true)}>
            Publish anyway
          </button>
        )}
      </div>
      <InlineError error={save.error ?? publish.error} />
    </section>
  );
}
