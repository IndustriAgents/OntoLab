import type { GraphBinding, ConnectionAuth } from "../../src/types/connections.ts";
import type { GraphBackend, Described } from "../graphchat/backend.ts";
import { COMMON_PREFIXES } from "../graphchat/rdf.ts";
import type { ServiceCtx } from "../services/context.ts";
import type { StoredConnection } from "./types.ts";
import { bounded } from "./service.ts";
import { queryConnection } from "./query.ts";

/** No shared clients or caches: each backend belongs to one owner + binding + connection version. */
export function externalBackend(ctx: ServiceCtx, c: StoredConnection, binding: GraphBinding, authOverride?: ConnectionAuth): GraphBackend {
  const neo = c.provider === "neo4j";
  const backend: GraphBackend = {
    source: "external",
    label: `${c.name} · ${neo ? "Neo4j" : (binding.graph ?? "default dataset")}`,
    repositoryId: c.id,
    queryLanguage: neo ? "cypher" : "sparql",
    sourceContext: { ...binding, connectionVersion: c.version, provider: c.provider, endpoint: c.queryEndpoint, readAt: isoNow() },
    kinds: neo ? ["cypher"] : ["select", "ask"],
    directType: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    async query(query) {
      try {
        const response = await bounded(ctx.user.id, () => queryConnection(ctx.user.id, c, binding, query, backend.signal, authOverride));
        backend.sourceContext = response.context;
        return response.result;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Database query failed." };
      }
    },
    async prefixes() {
      return neo ? {} : COMMON_PREFIXES;
    },
    async describe(iris) {
      const out = new Map<string, Described>();
      if (neo || !iris.length) return out;
      // IRIs originate in database results. Only safe absolute IRIs enter generated queries.
      const safe = iris.filter((i) => /^[a-z][a-z0-9+.-]*:[^<>"{}|^`\\\s]+$/i.test(i)).slice(0, 30);
      if (!safe.length) return out;
      const r = await backend.query(
        `SELECT ?s ?label ?type WHERE { VALUES ?s { ${safe.map((i) => `<${i}>`).join(" ")} } OPTIONAL { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label } OPTIONAL { ?s a ?type } } LIMIT 100`,
      );
      if (r.ok)
        for (const row of r.rows) {
          if (!row.s) continue;
          const d = out.get(row.s.value) ?? { types: [] };
          if (row.label) d.label = row.label.value;
          if (row.type && !d.types.includes(row.type.value)) d.types.push(row.type.value);
          out.set(row.s.value, d);
        }
      return out;
    },
    async digest() {
      const query = neo
        ? "MATCH (n) RETURN labels(n) AS labels, keys(n) AS properties LIMIT 30"
        : "SELECT DISTINCT ?type ?property WHERE { ?s a ?type ; ?property ?o } LIMIT 50";
      const r = await backend.query(query);
      if (!r.ok) throw new Error(r.error);
      return {
        text: `Live read-only ${neo ? "Neo4j database (Cypher)" : "RDF dataset (SPARQL)"}: ${backend.label}. Bounded schema sample (not a complete inventory):\n${JSON.stringify(r.rows)}\n${neo ? "Use MATCH/RETURN and built-in functions. No procedures, writes or database switching. Return scalar properties when practical." : "Use standard SPARQL SELECT or ASK. Named graph is fixed by the workspace; do not use GRAPH, FROM or SERVICE. Use full IRIs or declare standard prefixes."}`,
        suggestions: [
          "What kinds of things are described in this graph?",
          "Show a few connected entities and explain their relationships.",
        ],
      };
    },
    async tools() {
      return [];
    },
    async callTool() {
      return { ok: false, text: "Unknown tool." };
    },
  };
  return backend;
}
function isoNow() {
  return new Date().toISOString();
}
