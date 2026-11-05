import { useState } from "react";
import { Link, useLocation } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../../lib/http";
import { ErrorState, InlineError, LoadingState } from "../../components/ui/ui";
import type { Project } from "../../types/project";
import "./agent.css";
interface Connection {
  id: string;
  name: string;
  projects?: string[];
  revoked: boolean;
  effects: string[];
  lastSeen?: string;
}
interface Setup {
  connection: Connection;
  config: { command: string; args: string[] };
  codex: string;
  claude: string;
}
export default function AgentConnectionsSettings() {
  const qc = useQueryClient();
  const location = useLocation();
  const state = useQuery({
    queryKey: ["local-mcp"],
    queryFn: async () => {
      const result = await request<{ available: boolean; connections: Connection[]; projects: Project[] }>("GET", "api/local-mcp");
      if (!result || typeof result.available !== "boolean" || !Array.isArray(result.connections) || !Array.isArray(result.projects))
        throw new Error("The server returned an invalid assistant connection response.");
      return result;
    },
    retry: false,
  });
  const [name, setName] = useState("My assistant");
  const [scope, setScope] = useState("all");
  const [roots, setRoots] = useState("");
  const [allowSave, setAllowSave] = useState(false);
  const [setup, setSetup] = useState<Setup>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState("");
  async function create() {
    setBusy(true);
    setError(undefined);
    try {
      const created = await request<Setup>("POST", "api/local-mcp/connections", {
        body: {
          name,
          ...(scope === "all" ? {} : { projects: [scope] }),
          fileRoots: roots
            .split("\n")
            .map((p) => p.trim())
            .filter(Boolean),
          allowSave,
        },
      });
      setSetup(created);
      await qc.invalidateQueries({ queryKey: ["local-mcp"] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setError(undefined);
    try {
      await request("DELETE", `api/local-mcp/connections/${id}`);
      if (setup?.connection.id === id) setSetup(undefined);
      await qc.invalidateQueries({ queryKey: ["local-mcp"] });
    } catch (e) {
      setError(e);
    }
  }
  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setError(new Error("Select and copy the setup command below."));
    }
  }
  const providerGuidance = (
    <p className="agent-provider-guidance">
      Choose the models used by OntoLab for answers and extraction in{" "}
      <Link className="agent-provider-link" to="/settings?section=providers" state={location.state}>
        AI providers
      </Link>
      . Available Codex and Claude CLI providers are listed there too.
    </p>
  );
  if (state.isLoading) return <LoadingState label="Checking external assistant connections…" />;
  if (state.isError)
    return (
      <section className="card settings-card">
        {providerGuidance}
        <ErrorState title="Could not load assistant connections" error={state.error} onRetry={() => void state.refetch()} />
      </section>
    );
  if (state.data?.available === false)
    return (
      <section className="card settings-card agent-connection-info">
        <h2>Connect an external assistant</h2>
        <p>MCP connections let Claude Code or Codex access OntoLab projects, read sources and prepare drafts from your assistant.</p>
        <p>Set up these connections in the OntoLab desktop app for its local projects.</p>
        {providerGuidance}
      </section>
    );
  return (
    <>
      <section className="card settings-card">
        <div className="settings-section-head">
          <h2>Connect Claude or Codex</h2>
          <p>
            Give your external assistant access to OntoLab projects through MCP. Review its drafts, sources and activities here, and keep
            OntoLab running while connected.
          </p>
          {providerGuidance}
        </div>
        <form
          className="agent-connections-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label>
            Connection name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          </label>
          <label>
            Project access
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All projects, including new projects</option>
              {state.data?.projects
                .filter((p) => !p.settings.corpus && !p.settings.externalGraph)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} and its knowledge graphs
                  </option>
                ))}
            </select>
          </label>
          <label>
            Folders for importing local files (optional)
            <textarea value={roots} onChange={(e) => setRoots(e.target.value)} placeholder="One absolute folder path per line" rows={2} />
          </label>
          <label>
            <input type="checkbox" checked={allowSave} onChange={(e) => setAllowSave(e.target.checked)} />
            Allow this connection to review facts and save versions
          </label>
          <p className="muted">
            Connections can read, prepare sources, propose separate drafts and start activities. Version saving remains in OntoLab unless
            enabled above. Model inputs follow your selected assistant or provider.
          </p>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {busy ? "Creating connection…" : "Create connection"}
          </button>
          <InlineError error={error} />
        </form>
      </section>
      {setup && (
        <section className="card settings-card" aria-label="Connection setup">
          <h2>Connect {setup.connection.name}</h2>
          <p>Run the command for your assistant, then use its MCP status command to check the connection.</p>
          {(
            [
              ["Codex", setup.codex],
              ["Claude Code", setup.claude],
            ] as const
          ).map(([label, command]) => (
            <div key={label}>
              <h3>{label}</h3>
              <pre className="agent-connection-code">{command}</pre>
              <button className="btn ghost sm" onClick={() => void copy(label, command)}>
                {copied === label ? "Copied" : `Copy ${label} command`}
              </button>
            </div>
          ))}
          <details>
            <summary>Configuration for another MCP client</summary>
            <pre className="agent-connection-code">{JSON.stringify({ mcpServers: { ontolab: setup.config } }, null, 2)}</pre>
          </details>
          <p>Try: “List my OntoLab projects and help me build an ontology from my sources.”</p>
        </section>
      )}
      <section className="card settings-card">
        <h2>Your connections</h2>
        {state.data?.connections.filter((c) => !c.revoked).length ? (
          state.data.connections
            .filter((c) => !c.revoked)
            .map((c) => (
              <div className="settings-row" key={c.id}>
                <div>
                  <h3>{c.name}</h3>
                  <p>
                    {c.projects ? "Selected project and its graphs" : "All projects"} ·{" "}
                    {c.effects.includes("save") ? "Can save versions" : "Drafts and activities"}
                  </p>
                  <small>
                    {c.lastSeen ? `Last connected ${new Date(c.lastSeen).toLocaleString()}` : "Waiting for the first connection"}
                  </small>
                </div>
                <button className="btn ghost sm" onClick={() => void revoke(c.id)}>
                  Revoke
                </button>
              </div>
            ))
        ) : (
          <p>No active connections.</p>
        )}
      </section>
    </>
  );
}
