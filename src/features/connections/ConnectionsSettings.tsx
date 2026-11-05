import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { connectionKey, connectionsApi, endpointExamples, providerNames } from "../../lib/connectionsApi";
import type { ConnectionAuth, GraphConnection, GraphProvider } from "../../types/connections";
import { InlineError, LoadingState, Modal, StatusBadge } from "../../components/ui/ui";
import "./connections.css";

export default function ConnectionsSettings() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: connectionKey, queryFn: connectionsApi.list });
  const [editing, setEditing] = useState<GraphConnection | "new" | null>(null),
    [removing, setRemoving] = useState<GraphConnection | null>(null);
  const test = useMutation({ mutationFn: (connection: GraphConnection) => connectionsApi.test(connection.id) });
  const remove = useMutation({
    mutationFn: connectionsApi.remove,
    onSuccess: () => {
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: connectionKey });
    },
  });
  return (
    <div className="connections-stack">
      <section className="card connection-intro">
        <div>
          <h2>Your graph databases</h2>
          <p>Explore and ask questions about an existing graph, or publish saved OntoLab versions to an RDF store.</p>
        </div>
        <button className="btn" onClick={() => setEditing("new")}>
          Add connection
        </button>
      </section>
      <InlineError error={list.error} />
      {list.isLoading ? (
        <LoadingState label="Loading connections…" />
      ) : list.data?.length ? (
        list.data.map((c) => (
          <section className="card connection-card" key={c.id}>
            <div className="connection-heading">
              <div>
                <span className="eyebrow">{providerNames[c.provider]}</span>
                <h2>{c.name}</h2>
              </div>
              <StatusBadge tone="muted">{c.publishEndpoint ? "Read + publish" : "Read only"}</StatusBadge>
            </div>
            <code className="connection-endpoint">{c.queryEndpoint}</code>
            <p className="muted">
              {c.hasCredentials ? "Credentials encrypted on the server" : "No authentication"} · Connection version {c.version}
            </p>
            <div className="connection-actions">
              <button className="btn ghost sm" onClick={() => test.mutate(c)} disabled={test.isPending}>
                Test connection
              </button>
              <button className="btn ghost sm" onClick={() => setEditing(c)}>
                Edit connection
              </button>
              <button className="btn ghost sm danger" onClick={() => setRemoving(c)}>
                Disconnect
              </button>
            </div>
            {test.variables?.id === c.id && test.variables.version === c.version && (
              <>
                <InlineError error={test.error} />
                {test.isSuccess && (
                  <p className="connection-success" role="status">
                    Read connection works. Publishing permissions are checked when you publish.
                  </p>
                )}
              </>
            )}
          </section>
        ))
      ) : (
        <section className="card connection-empty">
          <h2>Bring your graph into OntoLab</h2>
          <p>
            Connect GraphDB, Fuseki, RDF4J, a SPARQL endpoint or Neo4j. Then choose “Connect existing graph” in a project’s Knowledge
            graphs.
          </p>
        </section>
      )}
      {editing && (
        <ConnectionForm
          key={typeof editing === "string" ? "new" : editing.id}
          connection={typeof editing === "string" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <Modal
          title={`Disconnect ${removing.name}?`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button className="btn danger" disabled={remove.isPending} onClick={() => remove.mutate(removing)}>
                Disconnect
              </button>
            </>
          }
        >
          <p>
            This removes the stored credentials. Connected workspaces keep their history and will need another connection. Data in the
            database stays intact.
          </p>
          <InlineError error={remove.error} />
        </Modal>
      )}
    </div>
  );
}
function ConnectionForm({ connection: c, onClose }: { connection?: GraphConnection; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(c?.name ?? ""),
    [provider, setProvider] = useState<GraphProvider>(c?.provider ?? "graphdb"),
    [url, setUrl] = useState(c?.queryEndpoint ?? ""),
    [publish, setPublish] = useState(c?.publishEndpoint ?? "");
  const [authType, setAuthType] = useState<ConnectionAuth["type"] | "keep">(c ? "keep" : "none"),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [token, setToken] = useState("");
  const save = useMutation({
    mutationFn: () =>
      connectionsApi.save(
        {
          name,
          provider,
          queryEndpoint: url,
          publishEndpoint: publish,
          version: c?.version,
          auth:
            authType === "keep"
              ? undefined
              : authType === "basic"
                ? { type: "basic", username, password }
                : authType === "bearer"
                  ? { type: "bearer", token }
                  : { type: "none" },
        },
        c?.id,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: connectionKey });
      onClose();
    },
  });
  const hint =
    provider === "neo4j"
      ? "Neo4j 5.25+ HTTP Query API. Use a database account with read access. Cypher browsing and Ask are read-only."
      : provider === "fuseki"
        ? "Use the dataset query endpoint, usually /dataset/query."
        : provider === "sparql"
          ? "Use a SPARQL 1.1 endpoint that returns JSON results."
          : "Use the repository query endpoint, usually /repositories/repository-id.";
  return (
    <Modal
      title={c ? "Edit graph connection" : "Add graph connection"}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => save.mutate()} disabled={!name.trim() || !url.trim() || save.isPending}>
            {save.isPending ? "Saving…" : "Save connection"}
          </button>
        </>
      }
    >
      <div className="connections-stack">
        <label className="field">
          <span>Connection name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder="Research database"
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>Database</span>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as GraphProvider);
              setPublish("");
            }}
          >
            {Object.entries(providerNames).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{provider === "neo4j" ? "Query API endpoint" : "SPARQL query endpoint"}</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={endpointExamples[provider]} autoComplete="off" />
          <small>{hint}</small>
        </label>
        <label className="field">
          <span>Authentication</span>
          <select value={authType} onChange={(e) => setAuthType(e.target.value as typeof authType)}>
            {c && <option value="keep">Keep current credentials</option>}
            <option value="none">None</option>
            <option value="basic">Username and password</option>
            <option value="bearer">Bearer token</option>
          </select>
        </label>
        {authType === "basic" && (
          <>
            <label className="field">
              <span>Username</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
          </>
        )}
        {authType === "bearer" && (
          <label className="field">
            <span>Token</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
          </label>
        )}
        {provider !== "neo4j" && (
          <details className="method-details">
            <summary>Enable publishing</summary>
            <div className="method-details-body">
              <p>Optional. OntoLab publishes only after you confirm a saved version. Each publication gets a fresh named graph.</p>
              <label className="field">
                <span>Publishing endpoint</span>
                <input
                  value={publish}
                  onChange={(e) => setPublish(e.target.value)}
                  placeholder={
                    provider === "fuseki"
                      ? "http://localhost:13030/ds/data"
                      : provider === "sparql"
                        ? "https://example.org/data"
                        : `${url.replace(/\/$/, "")}/statements`
                  }
                />
                <small>
                  {provider === "graphdb" || provider === "rdf4j" ? "Repository /statements endpoint" : "SPARQL Graph Store HTTP endpoint"}.
                  Leave empty for read-only access.
                </small>
              </label>
            </div>
          </details>
        )}
        <InlineError error={save.error} />
      </div>
    </Modal>
  );
}
