// Evidence graph for a graph-chat answer (ported from kg_chatbot).

import SparqlJs from "sparqljs";
import type { Binding, EvidenceGraph, GEdge, GNode, Term } from "../../src/types/graphChat.ts";
import type { GraphBackend } from "./backend.ts";
import { localName, PrefixMap, termKey } from "./rdf.ts";
import { runSparql, type RunRecord } from "./sparql.ts";

/*
 * Evidence graph
 * --------------
 * For a SELECT query, the triples that "made" the answer are the query's own
 * triple patterns with each result row's bindings substituted in. If the query
 * hides variables (aggregates, GROUP BY, or variables not projected), we re-run
 * its WHERE clause as `SELECT DISTINCT *` so every joined variable is bound,
 * then instantiate. CONSTRUCT / DESCRIBE results are triples already.
 */

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const MAX_ROWS = 200;
const MAX_EDGES = 300;
const GENERIC_TYPES = new Set([
  "http://www.w3.org/2002/07/owl#NamedIndividual",
  "http://www.w3.org/2002/07/owl#Thing",
  "http://www.w3.org/2000/01/rdf-schema#Resource",
]);

type PatternTerm = SparqlJs.Term | SparqlJs.PropertyPath;

interface TriplePattern {
  subject: PatternTerm;
  predicate: PatternTerm;
  object: PatternTerm;
}

interface EvTriple {
  s: Term;
  o: Term;
  /** Predicate IRI, or a property-path string when path is true. */
  p: string;
  path: boolean;
  source: string;
}

function collectPatterns(patterns: SparqlJs.Pattern[] | undefined, out: TriplePattern[]) {
  for (const p of patterns ?? []) {
    switch (p.type) {
      case "bgp":
        out.push(...(p.triples as TriplePattern[]));
        break;
      case "group":
      case "optional":
      case "union":
      case "graph":
      case "service":
        collectPatterns(p.patterns, out);
        break;
      case "query":
        collectPatterns(p.where, out);
        break;
      // minus / filter / bind / values contribute no positive evidence
    }
  }
}

function patternVars(patterns: TriplePattern[]): Set<string> {
  const vars = new Set<string>();
  for (const t of patterns) {
    for (const term of [t.subject, t.object, t.predicate]) {
      if ("termType" in term && term.termType === "Variable") vars.add(term.value);
    }
  }
  return vars;
}

function needsExpansion(q: SparqlJs.SelectQuery, vars: Set<string>): boolean {
  if (q.group || q.having) return true;
  const projected = q.variables;
  if (projected.length === 1 && "termType" in projected[0] && projected[0].termType === "Wildcard") return false;
  const names = new Set<string>();
  for (const v of projected as (SparqlJs.Variable | SparqlJs.VariableExpression)[]) {
    if ("termType" in v) names.add(v.value);
    else return true; // (expr AS ?x): aggregate or computed column
  }
  for (const v of vars) if (!names.has(v)) return true;
  return false;
}

const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const RDF_LANGSTRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

function toSparqlTerm(t: Term): SparqlJs.Term | undefined {
  if (t.type === "uri") return { termType: "NamedNode", value: t.value } as SparqlJs.IriTerm;
  if (t.type === "bnode") return undefined;
  return {
    termType: "Literal",
    value: t.value,
    language: t.lang ?? "",
    datatype: { termType: "NamedNode", value: t.lang ? RDF_LANGSTRING : (t.datatype ?? XSD_STRING) },
  } as unknown as SparqlJs.LiteralTerm;
}

/**
 * Re-runs the WHERE clause as SELECT DISTINCT * so every joined variable is
 * bound. The plain variables the original query projected are pinned with a
 * VALUES block to the rows it actually returned, so the evidence covers the
 * answer (e.g. the top 3 after ORDER BY / LIMIT), not arbitrary matches.
 */
function expansionQuery(q: SparqlJs.SelectQuery, answerRows: Binding[], vars: Set<string>): string {
  const pinned = (q.variables as (SparqlJs.Variable | SparqlJs.VariableExpression | SparqlJs.Wildcard)[])
    .filter((v): v is SparqlJs.VariableTerm => "termType" in v && v.termType === "Variable" && vars.has(v.value))
    .map((v) => v.value);
  const where = [...(q.where ?? [])];
  if (pinned.length) {
    const seen = new Set<string>();
    const values: SparqlJs.ValuePatternRow[] = [];
    for (const row of answerRows) {
      const entry: SparqlJs.ValuePatternRow = {};
      for (const v of pinned) {
        const t = row[v] && toSparqlTerm(row[v]);
        if (t) entry[`?${v}`] = t as SparqlJs.IriTerm | SparqlJs.LiteralTerm;
      }
      const key = JSON.stringify(entry);
      if (!Object.keys(entry).length || seen.has(key)) continue;
      seen.add(key);
      values.push(entry);
      if (values.length >= 100) break;
    }
    if (values.length) where.unshift({ type: "values", values });
  }
  const expanded: SparqlJs.SelectQuery = {
    ...q,
    where,
    variables: [new SparqlJs.Wildcard()],
    distinct: true,
    reduced: undefined,
    group: undefined,
    having: undefined,
    order: undefined,
    offset: undefined,
    limit: MAX_ROWS,
  };
  return new SparqlJs.Generator().stringify(expanded);
}

function pathString(p: PatternTerm, pm: PrefixMap): string {
  if ("termType" in p) return p.value === RDF_TYPE ? "a" : pm.compact(p.value);
  const items = p.items.map((i) => pathString(i as PatternTerm, pm));
  switch (p.pathType) {
    case "/":
      return items.join("/");
    case "|":
      return `(${items.join("|")})`;
    case "^":
      return `^${items[0]}`;
    case "!":
      return `!${items[0]}`;
    default:
      return `${items[0]}${p.pathType}`;
  }
}

function resolve(t: PatternTerm, row: Binding, varsOf: Map<string, Set<string>>): Term | undefined {
  if (!("termType" in t)) return undefined;
  switch (t.termType) {
    case "Variable": {
      const v = row[t.value];
      if (v) {
        const k = termKey(v);
        if (!varsOf.has(k)) varsOf.set(k, new Set());
        varsOf.get(k)!.add(t.value);
      }
      return v;
    }
    case "NamedNode":
      return { type: "uri", value: t.value };
    case "Literal":
      return { type: "literal", value: t.value, lang: t.language || undefined, datatype: t.language ? undefined : t.datatype?.value };
    default:
      return undefined; // blank nodes in patterns act as unprojected variables
  }
}

function instantiate(patterns: TriplePattern[], rows: Binding[], source: string, pm: PrefixMap, varsOf: Map<string, Set<string>>): EvTriple[] {
  const out: EvTriple[] = [];
  for (const row of rows.slice(0, MAX_ROWS)) {
    for (const tp of patterns) {
      let s = resolve(tp.subject, row, varsOf);
      let o = resolve(tp.object, row, varsOf);
      if (!s || !o) continue;
      const pred = tp.predicate;
      if ("termType" in pred) {
        const p = pred.termType === "Variable" ? row[pred.value] : pred.termType === "NamedNode" ? { type: "uri" as const, value: pred.value } : undefined;
        if (p?.type !== "uri") continue;
        out.push({ s, o, p: p.value, path: false, source });
      } else if (pred.pathType === "^" && pred.items.length === 1 && "termType" in pred.items[0] && pred.items[0].termType === "NamedNode") {
        [s, o] = [o, s];
        out.push({ s, o, p: pred.items[0].value, path: false, source });
      } else {
        out.push({ s, o, p: pathString(pred, pm), path: true, source });
      }
    }
  }
  return out;
}

export async function buildEvidence(
  backend: GraphBackend,
  runs: RunRecord[],
  citedIds: string[],
  onRun: (run: RunRecord) => void,
): Promise<EvidenceGraph | undefined> {
  const answering = runs.filter((r) => r.purpose === "agent" && r.ok && r.rowCount > 0 && r.kind !== "ask");
  let chosen = answering.filter((r) => citedIds.includes(r.id));
  if (!chosen.length && answering.length) chosen = [answering[answering.length - 1]];
  if (!chosen.length) return undefined;

  const pm = new PrefixMap(await backend.prefixes());
  const varsOf = new Map<string, Set<string>>();
  let triples: EvTriple[] = [];
  const notes: string[] = [];

  for (const run of chosen) {
    if (run.triples) {
      triples.push(...run.triples.slice(0, MAX_EDGES).flatMap((t) => (t.p.type === "uri" ? [{ s: t.s, o: t.o, p: t.p.value, path: false, source: run.id }] : [])));
      continue;
    }
    const q = run.parsed;
    if (!q || q.type !== "query" || q.queryType !== "SELECT") {
      notes.push(`${run.id}: query could not be analysed for triple patterns.`);
      continue;
    }
    for (const [p, ns] of Object.entries(q.prefixes ?? {})) pm.add(p, ns);
    const patterns: TriplePattern[] = [];
    collectPatterns(q.where, patterns);
    if (!patterns.length) continue;

    let rows = run.allRows;
    const vars = patternVars(patterns);
    if (needsExpansion(q, vars)) {
      const exp = await runSparql(backend, expansionQuery(q, run.allRows, vars), `${run.id}·e`, "evidence", run.id);
      onRun(exp);
      if (exp.ok) rows = exp.allRows;
      else notes.push(`${run.id}: evidence expansion failed; showing projected bindings only.`);
    }
    triples.push(...instantiate(patterns, rows, run.id, pm, varsOf));
  }

  // De-duplicate, merging sources.
  const byKey = new Map<string, EvTriple & { sources: Set<string> }>();
  for (const t of triples) {
    const k = `${termKey(t.s)}|${t.p}|${termKey(t.o)}`;
    const hit = byKey.get(k);
    if (hit) hit.sources.add(t.source);
    else byKey.set(k, { ...t, sources: new Set([t.source]) });
  }
  let unique = [...byKey.values()];
  const truncated = unique.length > MAX_EDGES;
  if (truncated) unique = unique.slice(0, MAX_EDGES);
  triples = unique;

  // Labels and direct types for every IRI on the graph (nodes and predicates).
  const iriSet = new Set<string>();
  for (const t of unique) {
    if (t.s.type === "uri") iriSet.add(t.s.value);
    if (t.o.type === "uri") iriSet.add(t.o.value);
    if (!t.path) iriSet.add(t.p);
  }
  const info = await backend.describe([...iriSet].slice(0, 400));

  const nodes = new Map<string, GNode>();
  const explicitType = new Map<string, string>();
  // The first rdf:type seen comes from the query's own pattern order, so a type the query asked for wins.
  for (const t of unique) {
    if (!t.path && t.p === RDF_TYPE && t.o.type === "uri" && !explicitType.has(termKey(t.s))) explicitType.set(termKey(t.s), t.o.value);
  }

  const nodeFor = (term: Term, sources: Set<string>, ctx?: { subject: string; predicate: string }): string => {
    const key = term.type === "literal" && ctx ? `lit:${ctx.subject}|${ctx.predicate}|${termKey(term)}` : termKey(term);
    let n = nodes.get(key);
    if (!n) {
      if (term.type === "literal") {
        n = { id: key, kind: "literal", label: term.value.length > 60 ? term.value.slice(0, 57) + "…" : term.value, value: term.value, datatype: term.datatype ? pm.compact(term.datatype) : undefined, lang: term.lang, vars: [], sources: [] };
      } else if (term.type === "bnode") {
        n = { id: key, kind: "bnode", label: `_:${term.value.slice(0, 8)}`, vars: [], sources: [] };
      } else {
        const meta = info.get(term.value);
        const typeIri = explicitType.get(key) ?? meta?.types.find((t) => !GENERIC_TYPES.has(t));
        n = {
          id: key,
          kind: "resource",
          label: meta?.label ?? localName(term.value),
          iri: term.value,
          compact: pm.compact(term.value),
          typeIri,
          type: typeIri ? (info.get(typeIri)?.label ?? localName(typeIri)) : undefined,
          individualId: backend.individualOf?.(term.value),
          vars: [],
          sources: [],
        };
      }
      n.vars = [...(varsOf.get(termKey(term)) ?? [])];
      nodes.set(key, n);
    }
    for (const s of sources) if (!n.sources.includes(s)) n.sources.push(s);
    return key;
  };

  const edges: GEdge[] = [];
  for (const t of unique) {
    const s = nodeFor(t.s, t.sources);
    const o = nodeFor(t.o, t.sources, { subject: s, predicate: t.p });
    const isType = !t.path && t.p === RDF_TYPE;
    if (isType) {
      const cls = nodes.get(o)!;
      if (cls.kind === "resource") cls.kind = "class";
    }
    edges.push({
      id: `e${edges.length}`,
      source: s,
      target: o,
      predicate: t.p,
      label: isType ? "a" : t.path ? t.p : (info.get(t.p)?.label ?? localName(t.p)),
      compact: t.path ? t.p : pm.compact(t.p),
      isType,
      path: t.path,
      sources: [...t.sources],
    });
  }

  return {
    nodes: [...nodes.values()],
    edges,
    queryIds: chosen.map((r) => r.id),
    prefixes: pm.toObject(),
    truncated,
    note: notes.length ? notes.join(" ") : undefined,
  };
}
