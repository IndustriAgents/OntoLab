// RDF terms, result parsing and prefixes for graph chat (from kg_chatbot).

import { Parser as TurtleParser } from "n3";
import type { Binding, Term } from "../../src/types/graphChat.ts";

export type { Binding, Term };

export interface Triple {
  s: Term;
  p: Term;
  o: Term;
}

const XSD = "http://www.w3.org/2001/XMLSchema#";

export const termKey = (t: Term): string => (t.type === "literal" ? `"${t.value}"@${t.lang ?? ""}^^${t.datatype ?? ""}` : t.type === "bnode" ? `_:${t.value}` : t.value);

/** One term in N-Triples-like syntax, for the model to read. */
export function termText(t: Term | undefined): string {
  if (!t) return "";
  if (t.type === "uri") return `<${t.value}>`;
  if (t.type === "bnode") return `_:${t.value}`;
  const v = JSON.stringify(t.value);
  return t.lang ? `${v}@${t.lang}` : t.datatype && t.datatype !== `${XSD}string` ? `${v}^^<${t.datatype}>` : v;
}

/** Parses one RDF term in N-Triples syntax, as used by SPARQL TSV results. */
export function parseNTerm(raw: string): Term | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  if (s.startsWith("<") && s.endsWith(">")) return { type: "uri", value: s.slice(1, -1) };
  if (s.startsWith("_:")) return { type: "bnode", value: s.slice(2) };
  if (s.startsWith('"')) {
    let i = 1;
    let value = "";
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\" && i + 1 < s.length) {
        const c = s[i + 1];
        if (c === "u" || c === "U") {
          const len = c === "u" ? 4 : 8;
          value += String.fromCodePoint(parseInt(s.slice(i + 2, i + 2 + len), 16));
          i += 2 + len;
          continue;
        }
        value += ({ t: "\t", n: "\n", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[c] ?? c;
        i += 2;
        continue;
      }
      value += s[i++];
    }
    const rest = s.slice(i + 1);
    if (rest.startsWith("@")) return { type: "literal", value, lang: rest.slice(1) };
    if (rest.startsWith("^^<")) return { type: "literal", value, datatype: rest.slice(3, -1) };
    return { type: "literal", value };
  }
  // Unquoted numeric / boolean shorthand allowed by the TSV format.
  if (/^[+-]?\d+$/.test(s)) return { type: "literal", value: s, datatype: XSD + "integer" };
  if (/^[+-]?\d*\.\d+$/.test(s)) return { type: "literal", value: s, datatype: XSD + "decimal" };
  if (/^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(s)) return { type: "literal", value: s, datatype: XSD + "double" };
  if (s === "true" || s === "false") return { type: "literal", value: s, datatype: XSD + "boolean" };
  return { type: "literal", value: s };
}

/** Parses SPARQL 1.1 TSV results (what GraphDB's MCP returns for SELECT). */
export function parseTsv(text: string): { vars: string[]; rows: Binding[] } {
  const lines = text.replace(/\r/g, "").split("\n");
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const header = lines.shift() ?? "";
  const vars = header.split("\t").map((v) => v.replace(/^[?$]/, ""));
  const rows: Binding[] = [];
  for (const line of lines) {
    const cells = line.split("\t");
    const row: Binding = {};
    vars.forEach((v, i) => {
      const t = cells[i] !== undefined ? parseNTerm(cells[i]) : undefined;
      if (t) row[v] = t;
    });
    rows.push(row);
  }
  return { vars, rows };
}

/** Parses Turtle (what GraphDB's MCP returns for CONSTRUCT / DESCRIBE). */
export function parseTurtle(text: string): { triples: Triple[]; prefixes: Record<string, string> } {
  const prefixes: Record<string, string> = {};
  const quads = new TurtleParser().parse(text, null, (prefix, iri) => {
    prefixes[prefix] = typeof iri === "string" ? iri : iri.value;
  });
  const conv = (t: { termType: string; value: string; language?: string; datatype?: { value: string } }): Term =>
    t.termType === "NamedNode"
      ? { type: "uri", value: t.value }
      : t.termType === "BlankNode"
        ? { type: "bnode", value: t.value }
        : { type: "literal", value: t.value, lang: t.language || undefined, datatype: t.language ? undefined : t.datatype?.value };
  return { triples: quads.map((q) => ({ s: conv(q.subject), p: conv(q.predicate), o: conv(q.object) })), prefixes };
}

/* ───────────────────────── prefixes ───────────────────────── */

export const COMMON_PREFIXES: Record<string, string> = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: XSD,
  skos: "http://www.w3.org/2004/02/skos/core#",
  dct: "http://purl.org/dc/terms/",
  dc: "http://purl.org/dc/elements/1.1/",
  foaf: "http://xmlns.com/foaf/0.1/",
  schema: "http://schema.org/",
  sh: "http://www.w3.org/ns/shacl#",
  prov: "http://www.w3.org/ns/prov#",
  sosa: "http://www.w3.org/ns/sosa/",
  ssn: "http://www.w3.org/ns/ssn/",
  time: "http://www.w3.org/2006/time#",
  geo: "http://www.opengis.net/ont/geosparql#",
  qudt: "http://qudt.org/schema/qudt/",
  unit: "http://qudt.org/vocab/unit/",
  sesame: "http://www.openrdf.org/schema/sesame#",
};

/** Adds prefixes from a query/turtle doc, then shortens IRIs for display. */
export class PrefixMap {
  private byNs = new Map<string, string>();

  constructor(prefixes: Record<string, string>) {
    for (const [p, ns] of Object.entries(prefixes)) this.add(p, ns);
  }

  add(prefix: string, ns: string) {
    if (!this.byNs.has(ns)) this.byNs.set(ns, prefix);
  }

  compact(iri: string): string {
    let best: [string, string] | undefined;
    for (const [ns, p] of this.byNs) {
      if (iri.startsWith(ns) && (!best || ns.length > best[0].length)) best = [ns, p];
    }
    if (best) {
      const local = iri.slice(best[0].length);
      if (/^[\w.-]*$/.test(local)) return `${best[1]}:${local}`;
    }
    return iri;
  }

  toObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [ns, p] of this.byNs) out[p] = ns;
    return out;
  }
}

/** Human-friendly name for an IRI when no label is known: its local name. */
export function localName(iri: string): string {
  const m = iri.match(/[#/:]([^#/:]+)\/?$/);
  if (!m) return iri;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
