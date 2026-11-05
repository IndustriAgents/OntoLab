// Standard imports (A6): FIBO, SNOMED subsets, ISO 15926 and schema.org ship as
// RDF/XML or JSON-LD rather than Turtle. Modules are stored as Turtle, so other
// formats are converted once, on import, with Oxigraph's parsers (already a
// dependency for SPARQL). JSON-LD with remote @context documents is not fetched;
// such files need an inline context.

import { HttpError } from "../http.ts";

export type RdfFormat = "turtle" | "rdfxml" | "jsonld" | "ntriples" | "nquads" | "trig";

const MEDIA: Record<RdfFormat, string> = {
  turtle: "text/turtle",
  rdfxml: "application/rdf+xml",
  jsonld: "application/ld+json",
  ntriples: "application/n-triples",
  nquads: "application/n-quads",
  trig: "application/trig",
};

/** Guess the format from the file name, then from the content. */
export function detectRdfFormat(name: string, text: string): RdfFormat {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["owl", "rdf", "xml"].includes(ext)) return /^\s*(<\?xml|<rdf:RDF|<Ontology)/.test(text) ? "rdfxml" : "turtle";
  if (["jsonld", "json"].includes(ext)) return "jsonld";
  if (ext === "nt") return "ntriples";
  if (ext === "nq") return "nquads";
  if (ext === "trig") return "trig";
  const head = text.trimStart().slice(0, 200);
  if (head.startsWith("<?xml") || head.startsWith("<rdf:RDF")) return "rdfxml";
  if (head.startsWith("{") || head.startsWith("[")) return "jsonld";
  return "turtle";
}

/** Convert any supported RDF serialisation to Turtle (default graph only). */
export async function toTurtle(name: string, text: string, format?: RdfFormat): Promise<{ turtle: string; format: RdfFormat; triples: number }> {
  const fmt = format ?? detectRdfFormat(name, text);
  if (fmt === "turtle") return { turtle: text, format: fmt, triples: -1 };
  if (/<Ontology\b[^>]*xmlns="http:\/\/www\.w3\.org\/2002\/07\/owl#"/.test(text.slice(0, 2000))) {
    throw new HttpError(415, `${name} is in OWL/XML syntax. Save it as RDF/XML or Turtle (for example with Protégé) and import again.`);
  }
  const oxigraph = await import("oxigraph");
  const store = new oxigraph.Store();
  try {
    store.load(text, { format: MEDIA[fmt], base_iri: "http://ontolab.local/import/" } as Parameters<typeof store.load>[1]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HttpError(422, `Could not read ${name} as ${fmt === "rdfxml" ? "RDF/XML" : fmt === "jsonld" ? "JSON-LD" : fmt}: ${msg.slice(0, 300)}`);
  }
  const turtle = store.dump({ format: "text/turtle", from_graph_name: oxigraph.defaultGraph() } as Parameters<typeof store.dump>[0]);
  return { turtle, format: fmt, triples: store.size };
}
