// Competency-question queries are model-written, so they are parsed before they
// run: only SELECT and ASK are allowed, and nothing that could reach outside
// the in-memory project snapshot (SERVICE, FROM/FROM NAMED, LOAD) survives.

import sparqljs from "sparqljs";
import { HttpError } from "../http.ts";

const MAX_QUERY_CHARS = 20_000;

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const v of Object.values(node)) if (v && typeof v === "object") walk(v, visit);
}

/** Throws 400 unless `sparql` is a single read-only SELECT or ASK query. */
export function assertReadOnlyQuery(sparql: string): "SELECT" | "ASK" {
  if (sparql.length > MAX_QUERY_CHARS) throw new HttpError(400, "The query is too long.");
  let parsed: ReturnType<sparqljs.SparqlParser["parse"]>;
  try {
    parsed = new sparqljs.Parser().parse(sparql);
  } catch (e) {
    throw new HttpError(400, `The SPARQL query could not be parsed: ${e instanceof Error ? e.message.split("\n")[0] : "syntax error"}`);
  }
  if (parsed.type !== "query") throw new HttpError(400, "Only read-only queries can run here — updates are not allowed.");
  if (parsed.queryType !== "SELECT" && parsed.queryType !== "ASK") {
    throw new HttpError(400, `Only SELECT and ASK queries can run here (got ${parsed.queryType}).`);
  }
  if (parsed.from && ((parsed.from.default?.length ?? 0) > 0 || (parsed.from.named?.length ?? 0) > 0)) {
    throw new HttpError(400, "FROM / FROM NAMED are not allowed — queries run against the project snapshot only.");
  }
  walk(parsed.where, (n) => {
    if (n.type === "service") throw new HttpError(400, "SERVICE (federated queries) is not allowed — external retrieval is disabled.");
  });
  return parsed.queryType;
}
