import { request } from "./http";
import type { ConnectionInput, GraphConnection, GraphPublication, GraphReadContext } from "../types/connections";
import type { Binding } from "../types/graphChat";
import type { Project } from "../types/project";
export interface ExternalResult {
  result: { ok: true; vars: string[]; rows: Binding[]; total: number };
  context: GraphReadContext;
}
export const connectionKey = ["graph-connections"] as const;
export const connectionsApi = {
  list: () => request<{ connections: GraphConnection[] }>("GET", "api/connections").then((r) => r.connections),
  save: (input: ConnectionInput, id?: string) =>
    request<{ connection: GraphConnection }>(id ? "PUT" : "POST", `api/connections${id ? `/${id}` : ""}`, { body: input }).then(
      (r) => r.connection,
    ),
  test: (id: string) => request<{ reachable: boolean }>("POST", `api/connections/${id}/test`, { body: {} }),
  remove: (c: GraphConnection) => request("DELETE", `api/connections/${c.id}?version=${c.version}`),
  connect: (pid: string, input: { name: string; connectionId: string; graph?: string }) =>
    request<{ project: Project }>("POST", `api/projects/${pid}/connected-graphs`, { body: input }).then((r) => r.project),
  query: (pid: string, query: string, signal?: AbortSignal) =>
    request<ExternalResult>("POST", `api/projects/${pid}/external/query`, { body: { query }, signal }),
  settings: (pid: string, input: { name?: string; connectionId: string; graph?: string }) =>
    request<{ project: Project }>("PUT", `api/projects/${pid}/external`, { body: input }).then((r) => r.project),
  publish: (pid: string, rid: string, connectionId: string) =>
    request<{ publication: GraphPublication }>("POST", `api/projects/${pid}/revisions/${rid}/publish`, {
      body: { connectionId, acknowledged: true },
    }),
};
export const providerNames = {
  graphdb: "GraphDB",
  fuseki: "Apache Jena Fuseki",
  rdf4j: "Eclipse RDF4J",
  sparql: "Generic SPARQL",
  neo4j: "Neo4j",
} as const;
export const endpointExamples = {
  graphdb: "http://localhost:17200/repositories/ontolab",
  fuseki: "http://localhost:13030/ds/query",
  rdf4j: "http://localhost:18080/rdf4j-server/repositories/ontolab",
  sparql: "https://example.org/sparql",
  neo4j: "http://localhost:17474/db/neo4j/query/v2",
} as const;
