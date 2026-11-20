// OAEI benchmark support. A track directory holds the two ontologies and the
// reference alignment in the Alignment API's RDF/XML format:
//
//   eval/gold-oaei/<track>/source.(owl|rdf|ttl)
//   eval/gold-oaei/<track>/target.(owl|rdf|ttl)
//   eval/gold-oaei/<track>/reference.rdf
//
// The OAEI test sets are not bundled (their licences differ by track); download
// e.g. the Conference track pairs from https://oaei.ontologymatching.org and put
// them here. The track runs the product's alignment service (lexical, semantic
// and structural matchers, optional model verification) and reports precision,
// recall, F1 and how many classes the accepted mappings make unsatisfiable.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTBox } from "../src/lib/ontology/tboxParser.ts";
import { toTurtle } from "../server/services/rdfConvert.ts";
import { alignOntologies, coherentSubset, mappingTurtle, type AlignOptions } from "../server/services/alignment.ts";
import { alignmentMetrics, coherence, type ReferenceCell } from "./research.ts";

const ALIGN = "http://knowledgeweb.semanticweb.org/heterogeneity/alignment#";

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decodeXml = (s: string) => s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => XML_ENTITIES[e]);

/**
 * Read the cells of an Alignment API file directly from the XML. Published OAEI
 * references often declare the alignment namespace without a trailing '#'
 * (so RDF predicates do not match), and add un-namespaced attributes (cid) or
 * literal text (<location>) that strict RDF/XML parsers reject.
 */
function readCells(xml: string): ReferenceCell[] {
  const cells: ReferenceCell[] = [];
  for (const [, body] of xml.matchAll(/<(?:[\w-]+:)?Cell\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Cell\s*>/g)) {
    const resource = (tag: string) => body.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*?rdf:resource\\s*=\\s*["']([^"']+)["']`))?.[1];
    const text = (tag: string) => body.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([^<]*)<`))?.[1]?.trim();
    const e1 = resource("entity1");
    const e2 = resource("entity2");
    if (!e1 || !e2) continue;
    const measure = text("measure");
    cells.push({ e1: decodeXml(e1), e2: decodeXml(e2), relation: decodeXml(text("relation") || "="), ...(measure ? { measure: Number(measure) } : {}) });
  }
  return cells;
}

/** Read a reference alignment (Alignment API RDF/XML) into cells. */
export async function loadOaeiAlignment(rdfxml: string): Promise<ReferenceCell[]> {
  const direct = readCells(rdfxml);
  if (direct.length) return direct;
  const oxigraph = await import("oxigraph");
  const store = new oxigraph.Store();
  store.load(rdfxml, { format: "application/rdf+xml", base_iri: "http://ontolab.local/oaei/" } as Parameters<typeof store.load>[1]);
  const rows = store.query(`PREFIX a: <${ALIGN}>
SELECT ?e1 ?e2 ?r ?m WHERE { ?c a:entity1 ?e1 ; a:entity2 ?e2 . OPTIONAL { ?c a:relation ?r } OPTIONAL { ?c a:measure ?m } }`) as Map<string, { value: string }>[];
  return rows.map((b) => ({
    e1: b.get("e1")!.value,
    e2: b.get("e2")!.value,
    relation: b.get("r")?.value ?? "=",
    ...(b.get("m") ? { measure: Number(b.get("m")!.value) } : {}),
  }));
}

async function readOntology(dir: string, stem: string): Promise<{ name: string; turtle: string }> {
  const files = await readdir(dir);
  const f = files.find((x) => x.startsWith(`${stem}.`));
  if (!f) throw new Error(`${dir}: no ${stem}.(owl|rdf|ttl)`);
  const text = await readFile(join(dir, f), "utf8");
  return { name: f, turtle: (await toTurtle(f, text)).turtle };
}

export interface OaeiResult {
  track: string;
  reference: number;
  proposed: number;
  /** set when no model verified the mappings: candidates at or above it were scored as equivalences */
  unverifiedThreshold?: number;
  /** before the coherence repair */
  raw: ReturnType<typeof alignmentMetrics> & { unsatisfiable: number };
  /** after holding back mappings that make classes unsatisfiable */
  repaired: ReturnType<typeof alignmentMetrics> & { unsatisfiable: number; heldBack: number };
  usage: { inputTokens: number; outputTokens: number };
}

/** Run one OAEI track directory through the product's matcher. */
/**
 * Without model verification every mapping is a `candidate`, which the metric
 * (rightly) does not count as a logical mapping, so matcher-only ablations scored
 * F1 = 0 by construction. Unverified candidates at or above this score are
 * treated as equivalences for scoring, as for any unverified OAEI matcher.
 */
export const UNVERIFIED_EQUIVALENCE_THRESHOLD = 0.85;

/** Unverified candidates at or above the threshold become equivalences; verified mappings are unchanged. */
export function thresholdUnverified<T extends { relation: string; score: number; verified?: boolean }>(mappings: T[], threshold: number): T[] {
  return mappings.map((m) => (m.relation === "candidate" && !m.verified && m.score >= threshold ? { ...m, relation: "equivalent" } : m));
}

export async function runOaeiTrack(
  dir: string,
  track: string,
  opts: AlignOptions & { unverifiedThreshold?: number },
): Promise<OaeiResult> {
  const source = await readOntology(dir, "source");
  const target = await readOntology(dir, "target");
  const reference = await loadOaeiAlignment(await readFile(join(dir, "reference.rdf"), "utf8"));
  const { unverifiedThreshold = UNVERIFIED_EQUIVALENCE_THRESHOLD, ...alignOpts } = opts;
  const aligned = await alignOntologies(parseTBox(source.turtle), parseTBox(target.turtle), { maxSource: 5000, ...alignOpts });
  const usage = aligned.usage;
  const mappings = opts.call ? aligned.mappings : thresholdUnverified(aligned.mappings, unverifiedThreshold);
  const logical = mappings.filter((m) => ["equivalent", "broader", "narrower"].includes(m.relation));
  const modules = [source, target];
  const { accepted, conflicts } = coherentSubset(modules, logical);
  return {
    track,
    reference: reference.length,
    proposed: mappings.length,
    ...(opts.call ? {} : { unverifiedThreshold }),
    raw: { ...alignmentMetrics(mappings, reference), ...coherence(modules, mappingTurtle(logical)) },
    repaired: { ...alignmentMetrics(accepted, reference), ...coherence(modules, mappingTurtle(accepted)), heldBack: conflicts.length },
    usage,
  };
}

/** Every track directory under the OAEI gold folder (empty when none were downloaded). */
export async function oaeiTracks(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}
