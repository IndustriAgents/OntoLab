// GraphDB (11+): chat through its built-in MCP server, and publishing a
// revision into a repository through its REST API. Ported from kg_chatbot.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { GraphDbStatus, QueryKind } from "../../src/types/graphChat.ts";
import { GRAPHDB_AUTH, GRAPHDB_MCP_URL, GRAPHDB_URL, GRAPHDB_WORKBENCH_URL } from "../config.ts";
import { localConnectionInstall } from "../connections/policy.ts";
import { HttpError } from "../http.ts";
import type { GraphBackend, LlmTool, JsonSchema, Described } from "./backend.ts";
import { COMMON_PREFIXES, localName, parseTsv, parseTurtle, PrefixMap, type Term } from "./rdf.ts";

const SESAME_DIRECT_TYPE = "http://www.openrdf.org/schema/sesame#directType";
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;

// Server-wide credentials are a single-user compatibility path. Hosted users
// must use owner-bound connections rather than share a privileged repository.
export const graphdbConfigured = () => !!GRAPHDB_URL && localConnectionInstall();

function authHeader(): Record<string, string> {
  return GRAPHDB_AUTH ? { authorization: `Basic ${Buffer.from(GRAPHDB_AUTH).toString("base64")}` } : {};
}

export function checkRepository(repo: string | undefined): string {
  if (!repo || !REPO_RE.test(repo)) throw new HttpError(400, "Choose a GraphDB repository first (letters, digits, dot, dash and underscore only).");
  return repo;
}

/* ───────────────────────── MCP client ───────────────────────── */

/**
 * Thin, self-healing client for GraphDB's MCP server. A dropped session
 * (GraphDB restart, idle timeout) is retried once on a fresh connection.
 */
class GraphDbMcp {
  private client?: Client;
  private connecting?: Promise<Client>;
  private toolList?: Tool[];

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!GRAPHDB_MCP_URL) throw new Error("GraphDB is not configured on this server.");
    this.connecting ??= (async () => {
      const client = new Client({ name: "ontolab", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(GRAPHDB_MCP_URL), { requestInit: { headers: authHeader() } }));
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private reset() {
    const c = this.client;
    this.client = undefined;
    this.toolList = undefined;
    c?.close().catch(() => {});
  }

  async listTools(): Promise<Tool[]> {
    if (this.toolList) return this.toolList;
    const client = await this.connect();
    const { tools } = await client.listTools();
    this.toolList = tools;
    return tools;
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<{ ok: boolean; text: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.connect();
        const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
        const parts = Array.isArray(res.content) ? res.content : [];
        const text = parts.map((p) => (p && typeof p === "object" && "text" in p ? decode(String(p.text)) : "")).join("\n");
        return { ok: !res.isError, text };
      } catch (err) {
        this.reset();
        if (attempt >= 1) return { ok: false, text: `GraphDB MCP error: ${(err as Error).message}` };
      }
    }
  }

  sparql(repositoryId: string, query: string, timeoutMs?: number) {
    return this.call("sparql_query", { repositoryId, query, addMissingNamespaces: true }, timeoutMs);
  }

  async ping(): Promise<boolean> {
    try {
      await this.listTools();
      return true;
    } catch {
      this.reset();
      return false;
    }
  }
}

/** GraphDB's MCP server returns tool output as a JSON-encoded string. */
function decode(text: string): string {
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const v = JSON.parse(text);
      if (typeof v === "string") return v;
    } catch {
      /* not JSON - keep as is */
    }
  }
  return text;
}

const mcp = new GraphDbMcp();

/* ───────────────────────── REST ───────────────────────── */

async function rest(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  if (!GRAPHDB_URL) throw new HttpError(400, "GraphDB is not configured on this server (set GRAPHDB_URL).");
  try {
    return await fetch(`${GRAPHDB_URL}${path}`, {
      ...init,
      headers: { ...authHeader(), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
  } catch {
    throw new HttpError(502, `Could not reach GraphDB at ${GRAPHDB_URL}.`);
  }
}

export async function listRepositories(): Promise<string[]> {
  const res = await rest("/rest/repositories", { headers: { accept: "application/json" } });
  if (!res.ok) throw new HttpError(502, `GraphDB refused the repository list (${res.status}).`);
  const list = (await res.json()) as { id?: string }[];
  return list.map((r) => String(r.id ?? "")).filter(Boolean);
}

export async function graphdbStatus(): Promise<GraphDbStatus> {
  if (!graphdbConfigured()) return { configured: false };
  const status: GraphDbStatus = { configured: true, url: GRAPHDB_WORKBENCH_URL || GRAPHDB_URL };
  try {
    status.repositories = await listRepositories();
    status.reachable = true;
  } catch (e) {
    status.reachable = false;
    status.error = e instanceof Error ? e.message : "GraphDB is unreachable.";
  }
  status.mcp = status.reachable ? await mcp.ping() : false;
  return status;
}

/**
 * Replace one named graph of a repository with `turtle`. Clearing first makes
 * a republish exact (no triples left over from the previous revision).
 */
export async function publishTurtle(repo: string, graph: string, turtle: string): Promise<void> {
  checkRepository(repo);
  const ctx = `?context=${encodeURIComponent(`<${graph}>`)}`;
  const put = await rest(`/repositories/${encodeURIComponent(repo)}/statements${ctx}`, {
    method: "POST",
    headers: { "content-type": "text/turtle; charset=utf-8" },
    body: turtle,
    timeoutMs: 120_000,
  });
  if (!put.ok) {
    const text = (await put.text().catch(() => "")).slice(0, 300);
    throw new HttpError(502, `GraphDB rejected the upload (${put.status})${text ? `: ${text}` : ""}.`);
  }
}

/* ───────────────────────── backend ───────────────────────── */

// Fixed order keeps the tool list byte-stable across requests (prompt caching).
const EXPOSED = ["autocomplete_iri_discovery_search", "iri_discovery_search", "fts_search", "ontology_schema", "get_similarity_options", "similarity_search"];
const HIDDEN_PARAMS = new Set(["repositoryId", "addMissingNamespaces"]);
const ONTOLOGY_NS = /^http:\/\/www\.w3\.org\/(2002\/07\/owl|2000\/01\/rdf-schema|1999\/02\/22-rdf-syntax-ns)#|^http:\/\/www\.w3\.org\/ns\/shacl#/;
const LABEL_PREDICATES = [
  "http://www.w3.org/2000/01/rdf-schema#label",
  "http://www.w3.org/2004/02/skos/core#prefLabel",
  "http://purl.org/dc/terms/title",
  "http://schema.org/name",
  "http://xmlns.com/foaf/0.1/name",
];

const prefixCache = new Map<string, Promise<Record<string, string>>>();
const digestCache = new Map<string, { at: number; value: Promise<{ text: string; suggestions: string[] }> }>();
const DIGEST_TTL_MS = 10 * 60_000;

/** GraphDB's MCP rejects queries that mention IRIs absent from the data; this lists them. */
export function unusedIris(error: string): string[] {
  const m = error.match(/IRIs are not used in the data[^:]*:\s*(.+)$/m);
  return m ? m[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean) : [];
}

function sniffKind(query: string): QueryKind {
  const body = query.replace(/#[^\n]*/g, " ").replace(/<[^>]*>/g, " ");
  const m = body.match(/\b(SELECT|CONSTRUCT|DESCRIBE|ASK)\b/i);
  return (m?.[1].toLowerCase() as QueryKind) ?? "unknown";
}

export function graphdbBackend(repo: string): GraphBackend {
  checkRepository(repo);
  const prefixes = () => {
    let p = prefixCache.get(repo);
    if (!p) {
      p = (async () => {
        const merged: Record<string, string> = { ...COMMON_PREFIXES };
        try {
          const res = await rest(`/repositories/${encodeURIComponent(repo)}/namespaces`, { headers: { accept: "application/sparql-results+json" }, timeoutMs: 5000 });
          if (res.ok) {
            const json = (await res.json()) as { results: { bindings: { prefix: { value: string }; namespace: { value: string } }[] } };
            for (const b of json.results.bindings) if (b.prefix.value) merged[b.prefix.value] = b.namespace.value;
          }
        } catch {
          /* namespaces are a display nicety only */
        }
        return merged;
      })();
      prefixCache.set(repo, p);
    }
    return p;
  };
  const select = async (query: string) => {
    const res = await mcp.sparql(repo, query, 30_000);
    if (!res.ok) return [];
    try {
      return parseTsv(res.text).rows;
    } catch {
      return [];
    }
  };

  const backend: GraphBackend = {
    source: "graphdb",
    label: `GraphDB · ${repo}`,
    repositoryId: repo,
    workbenchUrl: GRAPHDB_WORKBENCH_URL || undefined,
    kinds: ["select", "construct", "describe", "ask"],
    directType: SESAME_DIRECT_TYPE,
    async query(sparql, opts = {}) {
      const res = await mcp.sparql(repo, sparql, opts.timeoutMs);
      if (!res.ok) return { ok: false, error: res.text };
      const text = res.text;
      const kind = sniffKind(sparql);
      try {
        if (kind === "ask" || /^\s*(true|false)\s*$/i.test(text)) {
          return { ok: true, vars: ["result"], rows: [{ result: { type: "literal", value: text.trim().toLowerCase(), datatype: "http://www.w3.org/2001/XMLSchema#boolean" } }], total: 1 };
        }
        if (kind === "select" || (kind === "unknown" && (/^[?$]/.test(text) || !text.includes("@prefix")))) {
          const { vars, rows } = parseTsv(text);
          return { ok: true, vars, rows, total: rows.length };
        }
        const { triples } = parseTurtle(text);
        return { ok: true, vars: ["subject", "predicate", "object"], rows: triples.map((t) => ({ subject: t.s, predicate: t.p, object: t.o })), total: triples.length, triples };
      } catch (err) {
        return { ok: false, error: `Could not parse results: ${(err as Error).message}` };
      }
    },
    prefixes,
    async describe(iris) {
      const out = new Map<string, Described>();
      if (!iris.length) return out;
      const values = iris.map((i) => `<${i.replace(/[<>"{}|^`\\\s]/g, encodeURIComponent)}>`).join(" ");
      let labelPreds = LABEL_PREDICATES;
      for (let attempt = 0; attempt < 2; attempt++) {
        const labelPattern = labelPreds.length
          ? `OPTIONAL { ?s ${labelPreds.map((p) => `<${p}>`).join("|")} ?lbl . FILTER(LANG(?lbl) = "" || LANGMATCHES(LANG(?lbl), "en")) }`
          : "";
        const query = `SELECT ?s (SAMPLE(?lbl) AS ?label) (GROUP_CONCAT(DISTINCT STR(?t); SEPARATOR=" ") AS ?types) WHERE {
  VALUES ?s { ${values} }
  ${labelPattern}
  OPTIONAL { ?s <${SESAME_DIRECT_TYPE}> ?t . FILTER(isIRI(?t)) }
} GROUP BY ?s`;
        const res = await mcp.sparql(repo, query, 20_000);
        if (!res.ok) {
          const unused = new Set(unusedIris(res.text));
          if (!unused.size) return out;
          labelPreds = labelPreds.filter((p) => !unused.has(p));
          continue;
        }
        try {
          for (const row of parseTsv(res.text).rows) {
            if (row.s?.type !== "uri") continue;
            out.set(row.s.value, { label: row.label?.value, types: (row.types?.value ?? "").split(" ").filter(Boolean) });
          }
        } catch {
          /* labels are best-effort */
        }
        return out;
      }
      return out;
    },
    digest() {
      const hit = digestCache.get(repo);
      if (hit && Date.now() - hit.at < DIGEST_TTL_MS) return hit.value;
      const value = buildDigest(repo, prefixes, select);
      digestCache.set(repo, { at: Date.now(), value });
      value.catch(() => digestCache.delete(repo));
      return value;
    },
    async tools() {
      const mcpTools = await mcp.listTools();
      const tools: LlmTool[] = [];
      for (const name of EXPOSED) {
        const t = mcpTools.find((x) => x.name === name);
        if (!t) continue;
        const schema = t.inputSchema as JsonSchema;
        const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => !HIDDEN_PARAMS.has(k)));
        const required = (schema.required ?? []).filter((k) => !HIDDEN_PARAMS.has(k));
        tools.push({ name, description: (t.description ?? "").trim().slice(0, 1500), input_schema: { type: "object", properties, required } });
      }
      return tools;
    },
    callTool(name, args) {
      return mcp.call(name, { ...args, repositoryId: repo });
    },
  };
  return backend;
}

async function buildDigest(
  repo: string,
  prefixes: () => Promise<Record<string, string>>,
  select: (q: string) => Promise<Record<string, Term>[]>,
): Promise<{ text: string; suggestions: string[] }> {
  const pm = new PrefixMap(await prefixes());
  const classRows = await select(
    `PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?c (COUNT(DISTINCT ?s) AS ?n) (SAMPLE(?l) AS ?label) WHERE {
  ?s <${SESAME_DIRECT_TYPE}> ?c . FILTER(isIRI(?c))
  OPTIONAL { ?c rdfs:label ?l FILTER(LANG(?l) = "" || LANGMATCHES(LANG(?l), "en")) }
} GROUP BY ?c ORDER BY DESC(?n) LIMIT 60`,
  );
  const classes = classRows
    .filter((r) => r.c?.type === "uri")
    .map((r) => ({ iri: r.c.value, compact: pm.compact(r.c.value), label: r.label?.value ?? localName(r.c.value), count: Number(r.n?.value ?? 0) }));
  const predRows = await select(`SELECT ?p (COUNT(*) AS ?n) WHERE { ?s ?p ?o } GROUP BY ?p ORDER BY DESC(?n) LIMIT 80`);
  const predicates = predRows.filter((r) => r.p?.type === "uri").map((r) => ({ iri: r.p.value, compact: pm.compact(r.p.value), count: Number(r.n?.value ?? 0) }));

  // Outgoing properties (with an example value) for the main domain classes.
  const domain = classes.filter((c) => !ONTOLOGY_NS.test(c.iri)).slice(0, 25);
  const shape = new Map<string, string[]>();
  if (domain.length) {
    const rows = await select(
      `SELECT ?c ?p (COUNT(*) AS ?n) (SAMPLE(?o) AS ?ex) WHERE {
  VALUES ?c { ${domain.map((c) => `<${c.iri}>`).join(" ")} }
  ?s <${SESAME_DIRECT_TYPE}> ?c ; ?p ?o .
  FILTER(?p != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)
} GROUP BY ?c ?p ORDER BY ?c DESC(?n) LIMIT 600`,
    );
    for (const r of rows) {
      if (r.c?.type !== "uri" || r.p?.type !== "uri") continue;
      const list = shape.get(r.c.value) ?? [];
      if (list.length >= 14) continue;
      const ex = r.ex ? (r.ex.type === "literal" ? JSON.stringify(r.ex.value.slice(0, 40)) : r.ex.type === "uri" ? pm.compact(r.ex.value) : "_:b") : "";
      list.push(`${pm.compact(r.p.value)} (e.g. ${ex})`);
      shape.set(r.c.value, list);
    }
  }
  const all = pm.toObject();
  const usedNs = new Set<string>();
  for (const s of [...classes.map((c) => c.compact), ...predicates.map((p) => p.compact)]) {
    const m = s.match(/^([\w-]+):/);
    if (m && all[m[1]]) usedNs.add(m[1]);
  }
  const lines: string[] = [`Repository: ${repo}`, "", "Prefixes used below:"];
  for (const p of [...usedNs].sort()) lines.push(`PREFIX ${p}: <${all[p]}>`);
  lines.push("", "Classes (direct instance counts, via sesame:directType):");
  for (const c of classes) lines.push(`- ${c.compact}${c.label && c.label !== localName(c.iri) ? ` "${c.label}"` : ""} (${c.count})`);
  lines.push("", "Most used properties (triple counts):");
  for (const p of predicates) lines.push(`- ${p.compact} (${p.count})`);
  if (shape.size) {
    lines.push("", "Class → outgoing properties:");
    for (const c of domain) {
      const props = shape.get(c.iri);
      if (props) lines.push(`- ${c.compact}: ${props.join("; ")}`);
    }
  }
  const named = domain.filter((c) => c.count > 0);
  const suggestions = [
    "What kinds of things are described in this knowledge graph?",
    named[0] && `List every ${named[0].label} with its key properties.`,
    named[1] && named[0] && `How are ${named[0].label} and ${named[1].label} connected?`,
    named[2] && `Which ${named[2].label} has the most relationships?`,
  ].filter((x): x is string => !!x);
  return { text: lines.join("\n"), suggestions };
}
