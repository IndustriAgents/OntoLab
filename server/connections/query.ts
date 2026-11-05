import SparqlJs from "sparqljs";
import type { Binding, Term } from "../../src/types/graphChat.ts";
import type { GraphBinding, GraphReadContext, ConnectionAuth } from "../../src/types/connections.ts";
import type { QueryOutcome } from "../graphchat/backend.ts";
import { HttpError } from "../http.ts";
import { remoteRequest } from "./http.ts";
import type { StoredConnection } from "./types.ts";
import { decryptAuth } from "./secrets.ts";

export function graphIri(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 2000 || !/^[a-z][a-z0-9+.-]*:[^<>"{}|^`\\\s]+$/i.test(value))
    throw new HttpError(400, "Named graph must be an absolute IRI.");
  return value;
}
/** Parse, fail closed, reject federated requests and dataset overrides at every depth. */
export function readSparql(query: string, maxRows = 200): string {
  if (typeof query !== "string" || query.length > 20000) throw new HttpError(400, "Query must be at most 20,000 characters.");
  try {
    const parsed = new SparqlJs.Parser().parse(query);
    if (parsed.type !== "query" || !["SELECT", "ASK"].includes(parsed.queryType))
      throw new Error("Only SELECT and ASK queries are supported.");
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "service" || obj.type === "graph" || obj.from)
        throw new Error("SERVICE, GRAPH and FROM are not allowed. Select the named graph in workspace settings.");
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(walk);
        else walk(v);
      }
    };
    walk(parsed);
    if (parsed.queryType === "SELECT") parsed.limit = Math.min(parsed.limit ?? maxRows, maxRows);
    return new SparqlJs.Generator().stringify(parsed);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? `Read-only query refused: ${e.message}` : "Invalid read-only query.");
  }
}

/** A deliberately small Cypher surface: no procedures, schema, writes or database switching. */
export function readCypher(query: string): string {
  if (typeof query !== "string" || query.length > 20000) throw new HttpError(400, "Query must be at most 20,000 characters.");
  const tokens: string[] = [];
  let i = 0;
  while (i < query.length) {
    const c = query[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (query.startsWith("//", i)) {
      i = query.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (query.startsWith("/*", i)) {
      const end = query.indexOf("*/", i + 2);
      if (end < 0) throw new HttpError(400, "Unclosed comment.");
      i = end + 2;
      continue;
    }
    if (["'", '"', "`"].includes(c)) {
      const quote = c;
      i++;
      let closed = false;
      while (i < query.length) {
        if (query[i] === "\\" && quote !== "`") {
          i += 2;
          continue;
        }
        if (query[i] === quote) {
          if (query[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new HttpError(400, "Unclosed string or identifier.");
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = query.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/)![0];
      tokens.push(m.toUpperCase());
      i += m.length;
      continue;
    }
    if (c === ";" || c === "\\") throw new HttpError(400, "Only one read-only Cypher query is allowed.");
    i++;
  }
  const forbidden = new Set(
    "CALL USE LOAD CREATE MERGE SET DELETE DETACH REMOVE DROP ALTER GRANT DENY REVOKE FOREACH INSERT FINISH TRANSACTIONS TERMINATE START STOP ENABLE DEALLOCATE REALLOCATE RENAME PROFILE EXPLAIN CYPHER".split(
      " ",
    ),
  );
  if (
    !tokens.includes("RETURN") ||
    !["MATCH", "OPTIONAL", "WITH", "UNWIND", "RETURN"].includes(tokens[0]) ||
    tokens.some((t) => forbidden.has(t))
  )
    throw new HttpError(400, "Only read-only MATCH/RETURN Cypher is allowed. Procedures, writes and database switching are disabled.");
  // Reject qualified extension functions; built-in functions have no namespace.
  const scrubbed = query.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:``|[^`])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
  if (/\b\w+\s*\.\s*\w+\s*\(/.test(scrubbed)) throw new HttpError(400, "Extension functions are disabled in read-only queries.");
  return `CALL {\n${query}\n} RETURN * LIMIT 200`;
}

export interface RemoteResult {
  result: QueryOutcome;
  context: GraphReadContext;
}
export async function queryConnection(
  owner: string,
  c: StoredConnection,
  binding: GraphBinding,
  query: string,
  signal?: AbortSignal,
  authOverride?: ConnectionAuth,
): Promise<RemoteResult> {
  const auth = authOverride ?? (await decryptAuth(c.encryptedAuth, owner, c.id));
  let result: QueryOutcome;
  if (c.provider === "neo4j") {
    if (binding.graph) throw new HttpError(400, "Neo4j databases are selected by the connection endpoint, not an RDF named graph.");
    const statement = readCypher(query);
    const text = await remoteRequest(new URL(c.queryEndpoint), auth, {
      body: JSON.stringify({ statement, accessMode: "Read" }),
      contentType: "application/json",
      signal,
    });
    const data = parseJson(text, true) as {
      data?: { fields: string[]; values: unknown[][] };
      errors?: { message?: string; code?: string }[];
    };
    if (data.errors?.length || !data.data)
      throw new HttpError(422, "Neo4j refused this query. Check its syntax and the database permissions.");
    const { fields, values } = data.data;
    if (
      !Array.isArray(fields) ||
      fields.length > 100 ||
      fields.some((f) => typeof f !== "string") ||
      !Array.isArray(values) ||
      values.some((v) => !Array.isArray(v))
    )
      throw new HttpError(502, "Neo4j returned an invalid or excessively wide result.");
    const term = (v: unknown): Term => {
      if (v && typeof v === "object" && "$ontolabInteger" in v)
        return { type: "literal", value: String(v.$ontolabInteger), datatype: "http://www.w3.org/2001/XMLSchema#integer" };
      return {
        type: "literal",
        value: typeof v === "object" ? JSON.stringify(v) : String(v),
        datatype:
          typeof v === "object"
            ? "http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON"
            : `http://www.w3.org/2001/XMLSchema#${typeof v === "boolean" ? "boolean" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "double") : "string"}`,
      };
    };
    result = {
      ok: true,
      vars: fields,
      rows: values.slice(0, 200).map((row) => Object.fromEntries(fields.flatMap((f, i) => (row[i] === null ? [] : [[f, term(row[i])]])))),
      total: Math.min(values.length, 200),
    };
  } else {
    const sparql = readSparql(query);
    const body = new URLSearchParams({ query: sparql });
    const graph = graphIri(binding.graph);
    if (graph) body.set("default-graph-uri", graph);
    const text = await remoteRequest(new URL(c.queryEndpoint), auth, {
      body: body.toString(),
      contentType: "application/x-www-form-urlencoded",
      accept: "application/sparql-results+json",
      signal,
    });
    const data = parseJson(text) as {
      boolean?: boolean;
      head?: { vars?: string[] };
      results?: { bindings?: Record<string, Record<string, string>>[] };
    };
    if (typeof data.boolean === "boolean")
      result = {
        ok: true,
        vars: ["result"],
        rows: [{ result: { type: "literal", value: String(data.boolean), datatype: "http://www.w3.org/2001/XMLSchema#boolean" } }],
        total: 1,
      };
    else {
      if (
        !Array.isArray(data.results?.bindings) ||
        !Array.isArray(data.head?.vars) ||
        data.head.vars.length > 100 ||
        data.head.vars.some((v) => typeof v !== "string")
      )
        throw new HttpError(502, "Endpoint did not return SPARQL JSON results.");
      for (const row of data.results.bindings.slice(0, 200)) {
        if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length > 100)
          throw new HttpError(502, "Endpoint returned invalid SPARQL bindings.");
        for (const term of Object.values(row))
          if (
            !term ||
            typeof term !== "object" ||
            typeof term.value !== "string" ||
            !["uri", "bnode", "literal", "typed-literal"].includes(term.type)
          )
            throw new HttpError(502, "Endpoint returned an invalid RDF term.");
      }
      const rows: Binding[] = data.results.bindings.slice(0, 200).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            v.type === "uri" || v.type === "bnode"
              ? { type: v.type, value: v.value }
              : {
                  type: "literal",
                  value: v.value,
                  ...(v["xml:lang"] ? { lang: v["xml:lang"] } : {}),
                  ...(v.datatype ? { datatype: v.datatype } : {}),
                },
          ]),
        ),
      );
      result = { ok: true, vars: data.head.vars, rows, total: rows.length };
    }
  }
  return {
    result,
    context: {
      ...binding,
      connectionVersion: c.version,
      provider: c.provider,
      endpoint: c.queryEndpoint,
      readAt: new Date().toISOString(),
    },
  };
}
function parseJson(text: string, preserveIntegers = false): unknown {
  try {
    // Node 22's source context retains integers beyond JavaScript's safe range.
    return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
      preserveIntegers && typeof value === "number" && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? "")
        ? { $ontolabInteger: context!.source }
        : value,
    );
  } catch {
    throw new HttpError(502, "Database returned an invalid JSON response.");
  }
}
