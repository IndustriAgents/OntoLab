import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { connectionsApi, connectionKey, providerNames } from "../../lib/connectionsApi";
import { corpusKeys } from "../../lib/corpusApi";
import { InlineError, Modal } from "../../components/ui/ui";
export function ConnectGraphDialog({ pid, onClose }: { pid: string; onClose: () => void }) {
  const navigate = useNavigate(),
    qc = useQueryClient();
  const connections = useQuery({ queryKey: connectionKey, queryFn: connectionsApi.list });
  const [name, setName] = useState(""),
    [cid, setCid] = useState(""),
    [graph, setGraph] = useState("");
  const selected = connections.data?.find((c) => c.id === cid) ?? connections.data?.[0];
  const create = useMutation({
    mutationFn: () =>
      connectionsApi.connect(pid, { name, connectionId: selected!.id, graph: selected?.provider === "neo4j" ? undefined : graph }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: corpusKeys.list(pid) });
      navigate(`/p/${p.id}/graph`);
    },
  });
  return (
    <Modal
      title="Connect existing graph"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!selected || !name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Connecting…" : "Connect graph"}
          </button>
        </>
      }
    >
      <div className="connections-stack">
        <p>Browse and ask questions about data already in your database. This workspace is read-only and uses the source graph live.</p>
        <label className="field">
          <span>Graph name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Research knowledge graph" />
        </label>
        <label className="field">
          <span>Connection</span>
          <select value={selected?.id ?? ""} onChange={(e) => setCid(e.target.value)}>
            {!connections.data?.length && <option value="">No connections available</option>}
            {connections.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {providerNames[c.provider]}
              </option>
            ))}
          </select>
        </label>
        <Link to="/settings?section=connections">Manage graph connections →</Link>
        {selected?.provider !== "neo4j" && (
          <label className="field">
            <span>
              Named graph IRI <small>Optional</small>
            </span>
            <input value={graph} onChange={(e) => setGraph(e.target.value)} placeholder="urn:example:research" />
            <small>
              Leave empty to use the endpoint’s default dataset. A named graph limits all workspace and Ask queries to that graph.
            </small>
          </label>
        )}
        <InlineError error={connections.error ?? create.error} />
      </div>
    </Modal>
  );
}
