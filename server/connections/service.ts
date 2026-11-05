import { createHash } from "node:crypto";
import type { ConnectionInput, GraphConnection, GraphPublication } from "../../src/types/connections.ts";
import type { Project } from "../../src/types/project.ts";
import { HttpError } from "../http.ts";
import { ConflictError, NotFoundError } from "../store/types.ts";
import { iso, newId, type ServiceCtx } from "../services/context.ts";
import { requireProject } from "../services/projects.ts";
import { requireRevision } from "../services/revisions.ts";
import { exportTurtle } from "../services/archive.ts";
import { endpoint, remoteRequest } from "./http.ts";
import { decryptAuth, encryptAuth } from "./secrets.ts";
import { graphIri, queryConnection } from "./query.ts";
import type { StoredConnection } from "./types.ts";

export const connectionDto = ({ encryptedAuth: _secret, ...dto }: StoredConnection): GraphConnection => dto;
export async function requireConnection(ctx: ServiceCtx, id: string) {
  const c = await ctx.store.connections.get(id);
  if (!c) throw new NotFoundError("connection");
  return c;
}
export async function saveConnection(ctx: ServiceCtx, input: ConnectionInput, id?: string): Promise<GraphConnection> {
  if (!input || !["graphdb", "fuseki", "rdf4j", "sparql", "neo4j"].includes(input.provider))
    throw new HttpError(400, "Choose a supported graph provider.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 200) throw new HttpError(400, "Enter a connection name of 1–200 characters.");
  const old = id ? await requireConnection(ctx, id) : undefined;
  if (old && input.version !== old.version) throw new ConflictError("Connection changed. Refresh before updating credentials.");
  const queryEndpoint = endpoint(input.queryEndpoint);
  const publishEndpoint = input.publishEndpoint ? endpoint(input.publishEndpoint) : undefined;
  if (input.provider === "neo4j" && publishEndpoint)
    throw new HttpError(400, "RDF publishing is unavailable for Neo4j. Connect it for read-only Cypher queries.");
  if (input.provider === "neo4j" && !/\/db\/[^/]+\/query\/v2\/?$/.test(new URL(queryEndpoint).pathname))
    throw new HttpError(400, "Use the Neo4j HTTP Query API endpoint: https://host:7473/db/neo4j/query/v2 (Neo4j 5.25+).");
  if (publishEndpoint && new URL(publishEndpoint).origin !== new URL(queryEndpoint).origin)
    throw new HttpError(400, "Query and publishing endpoints must share the same origin.");
  if (
    old &&
    !input.auth &&
    (old.queryEndpoint !== queryEndpoint || old.publishEndpoint !== publishEndpoint || old.provider !== input.provider)
  )
    throw new HttpError(400, "Re-enter credentials when changing endpoints or provider.");
  const auth = input.auth;
  if (
    auth &&
    (!["none", "basic", "bearer"].includes(auth.type) ||
      (auth.type === "basic" &&
        (typeof auth.username !== "string" ||
          typeof auth.password !== "string" ||
          !auth.username ||
          !auth.password ||
          auth.username.includes(":"))) ||
      (auth.type === "bearer" && (typeof auth.token !== "string" || !auth.token)))
  )
    throw new HttpError(400, "Enter valid connection credentials.");
  if (auth && JSON.stringify(auth).length > 10000) throw new HttpError(400, "Credentials are too long.");
  const cid = old?.id ?? newId("conn"),
    now = iso(ctx.now());
  const value: StoredConnection = {
    id: cid,
    name,
    provider: input.provider,
    queryEndpoint,
    publishEndpoint,
    authType: auth?.type ?? old?.authType ?? "none",
    hasCredentials: auth ? auth.type !== "none" : (old?.hasCredentials ?? false),
    version: (old?.version ?? 0) + 1,
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
    encryptedAuth: auth ? await encryptAuth(auth, ctx.user.id, cid) : old?.encryptedAuth,
  };
  await ctx.store.connections.put(value, old?.version ?? null);
  return connectionDto(value);
}
export async function deleteConnection(ctx: ServiceCtx, id: string, version: number) {
  await requireConnection(ctx, id);
  if (!Number.isInteger(version)) throw new HttpError(400, "Connection version is required.");
  await ctx.store.connections.delete(id, version);
  return { disconnected: true };
}
const active = new Map<string, number>();
export async function bounded<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  if ((active.get(owner) ?? 0) >= 4 || [...active.values()].reduce((a, b) => a + b, 0) >= 16)
    throw new HttpError(429, "Too many database requests. Wait for an existing query to finish.");
  active.set(owner, (active.get(owner) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const n = (active.get(owner) ?? 1) - 1;
    if (n) active.set(owner, n);
    else active.delete(owner);
  }
}
export async function testConnection(ctx: ServiceCtx, id: string, signal?: AbortSignal) {
  const c = await requireConnection(ctx, id);
  await bounded(ctx.user.id, () =>
    queryConnection(ctx.user.id, c, { connectionId: id }, c.provider === "neo4j" ? "RETURN 1 AS connected" : "ASK {}", signal),
  );
  return {
    reachable: true,
    queryLanguage: c.provider === "neo4j" ? "cypher" : "sparql",
    readOnly: true,
    publishingConfigured: !!c.publishEndpoint,
    publishingVerified: false,
  };
}
export async function createConnectedGraph(
  ctx: ServiceCtx,
  parentId: string,
  input: { name?: string; connectionId?: string; graph?: string },
) {
  const parent = await requireProject(ctx, parentId);
  if (parent.settings.corpus || parent.settings.externalGraph) throw new HttpError(400, "Choose an ontology project as the parent.");
  const c = await requireConnection(ctx, input.connectionId ?? "");
  const graph = graphIri(input.graph);
  if (c.provider === "neo4j" && graph) throw new HttpError(400, "Neo4j uses the database in its connection endpoint.");
  const name = typeof input.name === "string" ? input.name.trim() : undefined;
  if (!name || name.length > 200) throw new HttpError(400, "Enter a graph name of 1–200 characters.");
  const now = iso(ctx.now());
  const project: Project = {
    id: newId("ext"),
    ownerId: ctx.user.id,
    name,
    purpose: "",
    scope: "",
    competencyQuestions: [],
    currentRevisionId: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
    settings: { externalGraph: { parentProjectId: parentId, parentName: parent.name, connectionId: c.id, ...(graph ? { graph } : {}) } },
  };
  return ctx.store.projects.create(project);
}
export async function externalQuery(ctx: ServiceCtx, id: string, query: string, signal?: AbortSignal) {
  const p = await requireProject(ctx, id),
    binding = p.settings.externalGraph;
  if (!binding) throw new HttpError(400, "This workspace is not connected to an external graph.");
  const c = await requireConnection(ctx, binding.connectionId);
  return bounded(ctx.user.id, () => queryConnection(ctx.user.id, c, { connectionId: c.id, graph: binding.graph }, query, signal));
}
export async function externalSettings(ctx: ServiceCtx, id: string, input: { name?: string; connectionId?: string; graph?: string }) {
  const p = await requireProject(ctx, id);
  if (!p.settings.externalGraph) throw new HttpError(400, "This workspace is not an external graph.");
  const connectionId = input.connectionId ?? p.settings.externalGraph.connectionId;
  const c = await requireConnection(ctx, connectionId),
    graph = graphIri(input.graph);
  if (c.provider === "neo4j" && graph) throw new HttpError(400, "Neo4j does not use an RDF named graph.");
  const name = (typeof input.name === "string" ? input.name.trim() : undefined) ?? p.name;
  if (!name || name.length > 200) throw new HttpError(400, "Enter a graph name of 1–200 characters.");
  const updated = await ctx.store.projects.compareAndSwapSettings(
    id,
    p.settings,
    { ...p.settings, externalGraph: { ...p.settings.externalGraph, connectionId, graph } },
    iso(ctx.now()),
  );
  if (name !== p.name) return ctx.store.projects.update(id, { name, updatedAt: iso(ctx.now()) });
  return updated;
}
async function publicationRecord(ctx: ServiceCtx, pid: string, record: GraphPublication) {
  for (let n = 0; n < 8; n++) {
    const p = await requireProject(ctx, pid);
    const records = p.settings.publications ?? [];
    const next = records.some((r) => r.id === record.id) ? records.map((r) => (r.id === record.id ? record : r)) : [...records, record];
    try {
      await ctx.store.projects.compareAndSwapSettings(pid, p.settings, { ...p.settings, publications: next }, iso(ctx.now()));
      return;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new ConflictError("Publication record changed repeatedly. Refresh the workspace.");
}
export async function publishVersion(
  ctx: ServiceCtx,
  pid: string,
  rid: string,
  input: { connectionId?: string; acknowledged?: boolean },
  signal?: AbortSignal,
) {
  const p = await requireProject(ctx, pid);
  if (p.settings.externalGraph) throw new HttpError(400, "Connected graphs are read-only. Publish from a saved OntoLab version.");
  const rev = await requireRevision(ctx, pid, rid);
  if (rev.status !== "committed") throw new HttpError(409, "Save and review the version before publishing.");
  const c = await requireConnection(ctx, input.connectionId ?? "");
  if (!c.publishEndpoint || c.provider === "neo4j") throw new HttpError(409, "Enable an RDF publishing endpoint in this connection first.");
  if (input.acknowledged !== true) throw new HttpError(400, "Confirm publication to this external connection.");
  const { turtle } = await exportTurtle(ctx, pid, rid, "combined", true);
  if (Buffer.byteLength(turtle) > 16_000_000) throw new HttpError(413, "This version exceeds the 16 MB publication limit.");
  const id = newId("pub"),
    graph = `urn:ontolab:publication:${id}`;
  const record: GraphPublication = {
    id,
    connectionId: c.id,
    connectionVersion: c.version,
    revisionId: rid,
    contentHash: createHash("sha256").update(turtle).digest("hex"),
    graph,
    createdAt: iso(ctx.now()),
    status: "publishing",
  };
  await publicationRecord(ctx, pid, record);
  try {
    const url = new URL(c.publishEndpoint),
      rdf4j = ["graphdb", "rdf4j"].includes(c.provider);
    url.searchParams.set(rdf4j ? "context" : "graph", rdf4j ? `<${graph}>` : graph);
    const auth = await decryptAuth(c.encryptedAuth, ctx.user.id, c.id);
    await bounded(ctx.user.id, () =>
      remoteRequest(url, auth, { method: rdf4j ? "POST" : "PUT", body: turtle, contentType: "text/turtle", signal, timeoutMs: 30000 }),
    );
    record.status = "published";
    await publicationRecord(ctx, pid, record);
    return { publication: record };
  } catch (e) {
    record.status = "failed";
    record.error =
      "Publication did not complete. A partial graph may remain at this attempt’s graph IRI. Earlier publications are unchanged.";
    await publicationRecord(ctx, pid, record);
    throw e;
  }
}
