import type { GraphReadContext } from "../../src/types/connections.ts";
// Where graph chat's queries run. Two backends answer the same calls:
//   project — the revision's own graph (T-Box + A-Box) in the in-process
//             SPARQL worker; nothing to install;
//   graphdb — a GraphDB repository through GraphDB's MCP server (graphdb.ts).

import type { GraphSource, QueryKind } from "../../src/types/graphChat.ts";
import type { RevisionWithContent } from "../../src/types/project.ts";
import type { TBoxModel } from "../../src/types/tbox.ts";
import { serializeABox } from "../../src/lib/ontology/aboxSerializer.ts";
import type { ReviewPolicy } from "../../src/lib/ontology/factReview.ts";
import { graphAbox, graphKey } from "../services/ontology.ts";
import { mergedGraphTurtle } from "../extract.ts";
import { querySparqlTyped } from "../services/sparqlPool.ts";
import { COMMON_PREFIXES, localName, PrefixMap, type Binding, type Triple } from "./rdf.ts";

export type QueryOutcome = { ok: true; vars: string[]; rows: Binding[]; total: number; triples?: Triple[] } | { ok: false; error: string };

export interface Described {
  label?: string;
  types: string[];
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, { type?: string; description?: string; [k: string]: unknown }>;
  required?: string[];
  [k: string]: unknown;
}

/** A tool as the model sees it. */
export interface LlmTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface GraphBackend {
  queryLanguage?: "sparql" | "cypher";
  signal?: AbortSignal;
  sourceContext?: GraphReadContext;
  source: GraphSource;
  /** "Revision 3" or "GraphDB · my-repo" */
  label: string;
  /** recorded on each SPARQL run */
  repositoryId: string;
  workbenchUrl?: string;
  /** query forms this backend runs (the project graph runs SELECT and ASK only) */
  kinds: QueryKind[];
  /** the predicate that gives an individual's most specific class */
  directType: string;
  query(sparql: string, opts?: { timeoutMs?: number; maxRows?: number }): Promise<QueryOutcome>;
  prefixes(): Promise<Record<string, string>>;
  describe(iris: string[]): Promise<Map<string, Described>>;
  /** schema summary for the system prompt, and starter questions */
  digest(): Promise<{ text: string; suggestions: string[] }>;
  /** tools beyond sparql_query and search_documents */
  tools(): Promise<LlmTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
  /** the project individual an IRI stands for */
  individualOf?(iri: string): string | undefined;
}

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const MAX_TRANSPORT_ROWS = 500;

export const projectGraphImplementation = () => [
  projectBackend.toString(),
  projectDigest.toString(),
  JSON.stringify(COMMON_PREFIXES),
  String(MAX_TRANSPORT_ROWS),
];

/* ───────────────────────── project graph ───────────────────────── */

export function projectBackend(rev: RevisionWithContent, tbox: TBoxModel, policy: ReviewPolicy = "exclude-rejected"): GraphBackend {
  const baseIri = rev.content.baseIri || tbox.baseIri;
  // answers come only from facts the review policy lets in
  const abox = graphAbox(rev.content, policy);
  const { idToUri } = serializeABox(abox, tbox, baseIri, { header: false });
  const uriToId = new Map([...idToUri].map(([id, uri]) => [uri, id]));
  const byId = new Map(abox.individuals.map((i) => [i.id, i]));
  const termLabel = new Map<string, string>();
  for (const t of [...tbox.classes, ...tbox.objectProps, ...tbox.dataProps]) if (t.label) termLabel.set(t.uri, t.label);
  const key = graphKey(rev.contentHash, policy);
  const turtle = () => mergedGraphTurtle({ tbox, abox, question: "", baseIri });
  const prefixes: Record<string, string> = { ...COMMON_PREFIXES, ...tbox.prefixes };
  const base = /[#/]$/.test(baseIri) ? baseIri : `${baseIri}#`;
  if (!Object.values(prefixes).includes(base)) prefixes[prefixes[""] ? "ind" : ""] = base;

  const findIndividuals = (q: string, limit = 10) => {
    const words = q
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 1);
    if (!words.length) return [];
    return abox.individuals
      .map((i) => {
        const hay = `${i.label ?? ""} ${i.id.replace(/[-_]/g, " ")}`.toLowerCase();
        const hits = words.filter((w) => hay.includes(w)).length;
        return { i, score: hits / words.length + (hay.includes(q.toLowerCase()) ? 1 : 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.i);
  };

  return {
    source: "project",
    label: rev.number != null ? `Revision ${rev.number}` : "Draft revision",
    repositoryId: rev.id,
    kinds: ["select", "ask"],
    directType: RDF_TYPE,
    async query(sparql, opts = {}) {
      try {
        const r = await querySparqlTyped(key, turtle, sparql, {
          timeoutMs: opts.timeoutMs,
          maxRows: opts.maxRows ?? MAX_TRANSPORT_ROWS * 4,
        });
        return { ok: true, vars: r.columns, rows: r.rows, total: r.total };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Query failed" };
      }
    },
    async prefixes() {
      return prefixes;
    },
    async describe(iris) {
      const out = new Map<string, Described>();
      for (const iri of iris) {
        const id = uriToId.get(iri);
        const ind = id ? byId.get(id) : undefined;
        if (ind) out.set(iri, { label: ind.label || ind.id, types: [ind.classUri] });
        else if (termLabel.has(iri)) out.set(iri, { label: termLabel.get(iri), types: [] });
      }
      return out;
    },
    async digest() {
      return projectDigest(tbox, rev, prefixes, base);
    },
    async tools() {
      return [
        {
          name: "find_individuals",
          description:
            "Find individuals in the project graph by name. Returns up to 10 matches with their IRI, label and class. Use it when the user names something and you need its IRI for a SPARQL query.",
          input_schema: {
            type: "object",
            properties: { query: { type: "string", description: "words from the individual's name" } },
            required: ["query"],
          },
        },
      ];
    },
    async callTool(name, args) {
      if (name !== "find_individuals") return { ok: false, text: "Unknown tool." };
      const hits = findIndividuals(String(args.query ?? ""));
      if (!hits.length) return { ok: true, text: "No individuals match. Try other words, or query rdfs:label with a FILTER." };
      return { ok: true, text: hits.map((i) => `<${idToUri.get(i.id)}> "${i.label || i.id}" (${localName(i.classUri)})`).join("\n") };
    },
    individualOf: (iri) => uriToId.get(iri),
  };
}

function projectDigest(
  tbox: TBoxModel,
  rev: RevisionWithContent,
  prefixes: Record<string, string>,
  base: string,
): { text: string; suggestions: string[] } {
  const pm = new PrefixMap(prefixes);
  const individuals = rev.content.abox?.individuals ?? [];
  const count = new Map<string, number>();
  for (const i of individuals) count.set(i.classUri, (count.get(i.classUri) ?? 0) + 1);
  const used = new Map<string, number>();
  for (const i of individuals) {
    for (const o of i.objectProperties ?? []) used.set(o.propUri, (used.get(o.propUri) ?? 0) + 1);
    for (const d of i.dataProperties ?? []) used.set(d.propUri, (used.get(d.propUri) ?? 0) + 1);
  }
  const lines: string[] = [];
  lines.push("Prefixes:");
  const shown = new Set<string>();
  for (const iri of [...tbox.classes.map((c) => c.uri), ...tbox.objectProps.map((p) => p.uri), ...tbox.dataProps.map((p) => p.uri), base]) {
    const c = pm.compact(iri);
    const m = c.match(/^([\w-]*):/);
    if (m && !shown.has(m[1]) && prefixes[m[1]] !== undefined) shown.add(m[1]);
  }
  for (const p of [...shown].sort()) lines.push(`PREFIX ${p}: <${prefixes[p]}>`);
  lines.push("PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>");
  lines.push("", `Individuals: ${individuals.length}. Their IRIs start with <${base}>; names are in rdfs:label.`);
  lines.push("Instances also carry rdf:type for every superclass, so `?x a :Parent` finds instances of its subclasses.");
  lines.push("", "Classes (direct instance counts):");
  for (const c of [...tbox.classes].sort((a, b) => (count.get(b.uri) ?? 0) - (count.get(a.uri) ?? 0)).slice(0, 80)) {
    const parents = (tbox.subClassOf[c.uri] ?? []).map((p) => pm.compact(p));
    lines.push(
      `- ${pm.compact(c.uri)}${c.label && c.label !== localName(c.uri) ? ` "${c.label}"` : ""} (${count.get(c.uri) ?? 0})${parents.length ? ` ⊑ ${parents.join(", ")}` : ""}`,
    );
  }
  const prop = (p: TBoxModel["objectProps"][number]) =>
    `- ${pm.compact(p.uri)}: ${p.domain.map((d) => pm.compact(d)).join("|") || "?"} → ${p.range.map((r) => pm.compact(r)).join("|") || "?"} (used ${used.get(p.uri) ?? 0}×)`;
  if (tbox.objectProps.length) lines.push("", "Object properties (domain → range):", ...tbox.objectProps.slice(0, 80).map(prop));
  if (tbox.dataProps.length) lines.push("", "Data properties (domain → datatype):", ...tbox.dataProps.slice(0, 80).map(prop));
  const named = tbox.classes.filter((c) => (count.get(c.uri) ?? 0) > 0).sort((a, b) => (count.get(b.uri) ?? 0) - (count.get(a.uri) ?? 0));
  const name = (c: (typeof named)[number]) => c.label || localName(c.uri);
  const suggestions = [
    "What kinds of things are described in this knowledge graph?",
    named[0] && `List every ${name(named[0])} with its key properties.`,
    named[1] && named[0] && `How are ${name(named[0])} and ${name(named[1])} connected?`,
    named[2] && `Which ${name(named[2])} has the most relationships?`,
  ].filter((x): x is string => !!x);
  return { text: lines.join("\n"), suggestions };
}
