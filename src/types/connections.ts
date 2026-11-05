/** Connection DTOs contain no credentials, including in project exports. */
export type GraphProvider = "graphdb" | "fuseki" | "rdf4j" | "sparql" | "neo4j";
export type ConnectionAuth = { type: "none" } | { type: "basic"; username: string; password: string } | { type: "bearer"; token: string };
export interface GraphConnection {
  id: string;
  name: string;
  provider: GraphProvider;
  queryEndpoint: string;
  /** RDF Graph Store endpoint, or RDF4J /statements endpoint. Explicitly opt-in. */
  publishEndpoint?: string;
  authType: ConnectionAuth["type"];
  hasCredentials: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ConnectionInput {
  name: string;
  provider: GraphProvider;
  queryEndpoint: string;
  publishEndpoint?: string;
  auth?: ConnectionAuth;
  /** Required on updates to prevent overwriting a concurrent credential rotation. */
  version?: number;
}
export interface GraphBinding {
  connectionId: string;
  /** A single RDF named graph. Empty means the endpoint's default dataset. */
  graph?: string;
}
export interface ExternalGraph extends GraphBinding {
  parentProjectId: string;
  parentName: string;
}
export interface GraphReadContext extends GraphBinding {
  connectionVersion: number;
  provider: GraphProvider;
  endpoint: string;
  readAt: string;
}
export interface GraphPublication {
  id: string;
  connectionId: string;
  connectionVersion: number;
  revisionId: string;
  contentHash: string;
  graph: string;
  createdAt: string;
  status: "publishing" | "published" | "failed";
  error?: string;
}
