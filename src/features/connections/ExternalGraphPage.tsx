import { useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProject } from "../../app/project";
import { useTheme } from "../../app/theme";
import { connectionsApi, connectionKey, providerNames, type ExternalResult } from "../../lib/connectionsApi";
import { corpusKeys } from "../../lib/corpusApi";
import { qk } from "../../lib/projectApi";
import { InlineError, LoadingState, PageHead, StatusBadge } from "../../components/ui/ui";
import { ForceGraph, type GraphNode, type GraphEdge } from "../explore/ForceGraph";
import type { Binding } from "../../types/graphChat";
import "./connections.css";

export default function ExternalGraphPage() {
  const { pid, project } = useProject(),
    { theme } = useTheme(),
    location = useLocation(),
    qc = useQueryClient();
  const [params] = useSearchParams();
  const binding = project!.settings.externalGraph!;
  const tab = location.pathname.endsWith("/sparql")
    ? "query"
    : params.get("tab") === "settings"
      ? "settings"
      : params.get("tab") === "query"
        ? "query"
        : "browse";
  const connections = useQuery({ queryKey: connectionKey, queryFn: connectionsApi.list }),
    connection = connections.data?.find((c) => c.id === binding.connectionId);
  const neo = connection?.provider === "neo4j";
  const starter = neo
    ? "MATCH (s)-[r]->(o) RETURN s, type(r) AS relationship, o LIMIT 100"
    : "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100";
  const browse = useQuery({
    queryKey: ["external-browse", pid, binding.connectionId, connection?.version, binding.graph],
    queryFn: ({ signal }) => connectionsApi.query(pid, starter, signal),
    enabled: !!connection && tab === "browse",
    retry: false,
    staleTime: 30000,
  });
  const [text, setText] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [hidden, setHidden] = useState<Set<string>>(new Set());
  const controller = useRef<AbortController | null>(null);
  const query = useMutation({
    mutationFn: () => {
      controller.current = new AbortController();
      return connectionsApi.query(pid, text ?? starter, controller.current.signal);
    },
  });
  const result = tab === "query" ? query.data : browse.data;
  const graph = useMemo(() => previewGraph(result?.result.rows ?? [], !!neo), [result, neo]);
  const [name, setName] = useState(project!.name),
    [cid, setCid] = useState(binding.connectionId),
    [scope, setScope] = useState(binding.graph ?? "");
  const settingsConnection = connections.data?.find((c) => c.id === cid);
  const save = useMutation({
    mutationFn: () =>
      connectionsApi.settings(pid, { name, connectionId: cid, graph: settingsConnection?.provider === "neo4j" ? undefined : scope }),
    onSuccess: () => {
      setText(null);
      query.reset();
      void qc.invalidateQueries({ queryKey: qk.project(pid) });
      void qc.invalidateQueries({ queryKey: corpusKeys.list(binding.parentProjectId) });
      void qc.invalidateQueries({ queryKey: ["external-browse", pid] });
    },
  });
  return (
    <div className="page">
      <div className="page-wide">
        <PageHead
          title={project!.name}
          actions={
            <Link className="btn" to={`/p/${pid}/assistant`}>
              Ask this graph →
            </Link>
          }
        >
          Explore the live graph in your connected database.
        </PageHead>
        <div className="external-source">
          <div>
            <strong>
              {connection
                ? `${connection.name} · ${providerNames[connection.provider]}`
                : connections.isLoading
                  ? "Loading connection…"
                  : "Connection unavailable"}
            </strong>
            <p>{binding.graph ?? (neo ? "Database selected by connection" : "Endpoint default dataset")}</p>
          </div>
          <StatusBadge tone="info">Read only · Live data</StatusBadge>
        </div>
        <nav className="external-tabs" aria-label="Connected graph">
          <Link className="btn ghost sm" to={`/p/${pid}/graph`} aria-current={tab === "browse" ? "page" : undefined}>
            Explore
          </Link>
          <Link className="btn ghost sm" to={`/p/${pid}/graph?tab=query`} aria-current={tab === "query" ? "page" : undefined}>
            {neo ? "Cypher" : "SPARQL"}
          </Link>
          <Link className="btn ghost sm" to={`/p/${pid}/graph?tab=settings`} aria-current={tab === "settings" ? "page" : undefined}>
            Graph settings
          </Link>
        </nav>
        <InlineError error={connections.error} />
        {!connections.isLoading && !connection && (
          <div className="banner warn">
            The saved connection was disconnected or is unavailable. Choose another connection in Graph settings or{" "}
            <Link to="/settings?section=connections">add a connection</Link>.
          </div>
        )}
        {tab === "settings" ? (
          <section className="card connection-card connections-stack">
            <h2>Source graph</h2>
            <label className="field">
              <span>Graph name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>Connection</span>
              <select value={cid} onChange={(e) => setCid(e.target.value)}>
                {!connections.data?.some((c) => c.id === cid) && <option value={cid}>Unavailable connection</option>}
                {connections.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {providerNames[c.provider]}
                  </option>
                ))}
              </select>
            </label>
            {settingsConnection?.provider !== "neo4j" && (
              <label className="field">
                <span>Named graph IRI</span>
                <input value={scope} onChange={(e) => setScope(e.target.value)} />
                <small>
                  Empty uses the endpoint default dataset. Changing this scope changes future queries; earlier answers keep their recorded
                  source.
                </small>
              </label>
            )}
            <div>
              <button className="btn" disabled={save.isPending || !settingsConnection} onClick={() => save.mutate()}>
                Save graph settings
              </button>{" "}
              <Link to="/settings?section=connections">Manage connections →</Link>
            </div>
            {save.isSuccess && <p role="status">Graph settings saved.</p>}
            <InlineError error={save.error} />
          </section>
        ) : (
          <>
            {tab === "query" ? (
              <section className="card connection-card">
                <label className="field">
                  <span>{neo ? "Read-only Cypher" : "Read-only SPARQL"}</span>
                  <textarea
                    className="external-query"
                    value={text ?? starter}
                    onChange={(e) => setText(e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <div className="connection-actions">
                  <button className="btn" disabled={!connection || query.isPending} onClick={() => query.mutate()}>
                    {query.isPending ? "Running…" : "Run query"}
                  </button>
                  {query.isPending && (
                    <button className="btn ghost" onClick={() => controller.current?.abort()}>
                      Cancel query
                    </button>
                  )}
                </div>
                <p className="field-hint">
                  Up to 200 rows and 15 seconds per request.{" "}
                  {neo
                    ? "MATCH/RETURN queries; procedures and writes are disabled."
                    : "SELECT or ASK only. The workspace controls the graph scope."}
                </p>
                <InlineError error={query.error} />
              </section>
            ) : (
              <>
                <div className="connection-heading">
                  <div>
                    <h2>Graph preview</h2>
                    <p className="muted">A sample of up to 100 relationships. Refresh to read the current data.</p>
                  </div>
                  <button className="btn ghost sm" disabled={browse.isFetching || !connection} onClick={() => void browse.refetch()}>
                    Refresh preview
                  </button>
                </div>
                <InlineError error={browse.error} />
                {browse.isLoading && <LoadingState label="Reading the connected graph…" />}
                {!!graph.nodes.length && (
                  <div className="external-graph">
                    <ForceGraph
                      nodes={graph.nodes.filter((n) => !hidden.has(n.type))}
                      edges={graph.edges}
                      all={graph.nodes}
                      total={graph.nodes.length}
                      theme={theme}
                      hidden={hidden}
                      onToggleType={(type) =>
                        setHidden((old) => {
                          const next = new Set(old);
                          if (next.has(type)) next.delete(type);
                          else next.add(type);
                          return next;
                        })
                      }
                      selectedId={selected}
                      onSelect={setSelected}
                      noun={{ one: "entity", many: "entities" }}
                    />
                  </div>
                )}
              </>
            )}
            {result && <ResultTable data={result} />}
          </>
        )}
      </div>
    </div>
  );
}
function ResultTable({ data }: { data: ExternalResult }) {
  return (
    <>
      <div className="external-result-meta">
        <span>{data.result.total} rows · bounded result</span>
        <span>
          Read {new Date(data.context.readAt).toLocaleString()} · Connection v{data.context.connectionVersion}
        </span>
      </div>
      <div className="external-results">
        <table>
          <thead>
            <tr>
              {data.result.vars.map((v) => (
                <th key={v} scope="col">
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.result.rows.map((row, i) => (
              <tr key={i}>
                {data.result.vars.map((v) => (
                  <td key={v} title={row[v]?.value}>
                    {row[v]?.value ?? "—"}
                    {row[v]?.type === "literal" && row[v].lang ? ` @${row[v].lang}` : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!data.result.rows.length && <p className="muted">No matching rows in this graph scope.</p>}
      </div>
    </>
  );
}
function previewGraph(rows: Binding[], neo: boolean) {
  const nodes = new Map<string, GraphNode>(),
    edges: GraphEdge[] = [];
  const add = (id: string, label: string, type: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, type, degree: 0 });
    nodes.get(id)!.degree++;
  };
  for (const row of rows) {
    if (!row.s || !row.o) continue;
    if (neo) {
      try {
        const s = JSON.parse(row.s.value),
          o = JSON.parse(row.o.value);
        if (!s.elementId || !o.elementId) continue;
        add(s.elementId, String(s.properties?.name ?? s.properties?.label ?? s.elementId), (s.labels ?? ["Entity"]).join(", "));
        add(o.elementId, String(o.properties?.name ?? o.properties?.label ?? o.elementId), (o.labels ?? ["Entity"]).join(", "));
        edges.push({ from: s.elementId, to: o.elementId, name: row.relationship?.value ?? "related" });
      } catch {
        continue;
      }
    } else {
      const s = row.s.value,
        o = row.o.type === "literal" ? `literal:${row.o.value}:${row.o.lang ?? row.o.datatype ?? ""}` : row.o.value;
      add(s, short(row.s.value), "Resource");
      add(o, short(row.o.value), row.o.type === "literal" ? "Value" : "Resource");
      edges.push({ from: s, to: o, name: short(row.p?.value ?? "") });
    }
  }
  return { nodes: [...nodes.values()], edges };
}
function short(value: string) {
  const label = value.split(/[#/:]/).filter(Boolean).at(-1) ?? value;
  return label.length > 70 ? `${label.slice(0, 67)}…` : label;
}
