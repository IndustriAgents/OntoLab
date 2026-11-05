// Reuse before minting (A3). Before a new class or property is kept, look for
// an existing term with the same meaning in public vocabularies — LOV (Linked
// Open Vocabularies, a search over hundreds of ontologies), schema.org, and
// BioPortal for biomedical projects — and propose reusing it (owl:equivalentClass
// / owl:equivalentProperty). The extended NeOn-GPT study (Semantic Web J. 2026)
// found an explicit reuse step raised alignment with the gold ontology.
//
// Network lookups are optional (REUSE_SOURCES) and cached per process; a
// failed source is skipped, never fatal.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReuseSuggestion } from "../../src/types/project.ts";
import type { TBoxModel } from "../../src/types/tbox.ts";
import { localName, OWL } from "../../src/lib/ontology/iri.ts";
import { BIOPORTAL_API_KEY, DATA_DIR, EXTERNAL_TIMEOUT_MS, REUSE_SOURCES } from "../config.ts";

type Source = "lov" | "schemaorg" | "bioportal";
type Fetch = typeof fetch;

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().trim();
const norm = (s: string) => words(s).replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ");

async function getJson(f: Fetch, url: string): Promise<unknown> {
  const res = await f(url, { headers: { accept: "application/json", "user-agent": "OntoLab/0.2 (ontology reuse lookup)" }, signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/* ───────────────────────── schema.org (local index of the published vocabulary) ───────────────────────── */

interface SchemaTerm {
  iri: string;
  label: string;
  kind: "class" | "property";
}

let schemaIndex: Promise<SchemaTerm[]> | null = null;
const SCHEMA_URL = "https://schema.org/version/latest/schemaorg-current-https.jsonld";

async function schemaOrg(f: Fetch): Promise<SchemaTerm[]> {
  schemaIndex ??= (async () => {
    const cacheFile = join(DATA_DIR, "vocab", "schemaorg.json");
    try {
      return JSON.parse(await readFile(cacheFile, "utf8")) as SchemaTerm[];
    } catch {
      /* not cached yet */
    }
    const data = (await getJson(f, SCHEMA_URL)) as { "@graph"?: Record<string, unknown>[] };
    const out: SchemaTerm[] = [];
    for (const n of data["@graph"] ?? []) {
      const id = String(n["@id"] ?? "");
      const type = ([] as unknown[]).concat(n["@type"] ?? []).map(String);
      const label = n["rdfs:label"];
      const text = typeof label === "string" ? label : label && typeof label === "object" ? String((label as { "@value"?: string })["@value"] ?? "") : "";
      if (!id.startsWith("schema:") || !text) continue;
      const kind = type.includes("rdfs:Class") ? "class" : type.includes("rdf:Property") ? "property" : null;
      if (kind) out.push({ iri: `https://schema.org/${id.slice(7)}`, label: text, kind });
    }
    await mkdir(join(DATA_DIR, "vocab"), { recursive: true }).catch(() => {});
    await writeFile(cacheFile, JSON.stringify(out)).catch(() => {});
    return out;
  })().catch((e) => {
    schemaIndex = null;
    throw e;
  });
  return schemaIndex;
}

/* ───────────────────────── lookups ───────────────────────── */

type Candidate = ReuseSuggestion["candidates"][number];

async function lookupLov(name: string, kind: "class" | "property", f: Fetch): Promise<Candidate[]> {
  const data = (await getJson(f, `https://lov.linkeddata.es/dataset/lov/api/v2/term/search?type=${kind}&page_size=5&q=${encodeURIComponent(words(name))}`)) as {
    results?: { uri?: string[]; prefixedName?: string[]; "vocabulary.prefix"?: string[]; score?: number }[];
  };
  const want = norm(name);
  return (data.results ?? [])
    .map((r) => {
      const iri = r.uri?.[0] ?? "";
      const label = (r.prefixedName?.[0] ?? localName(iri)).split(":").pop() ?? "";
      return { iri, label, source: "lov" as const, vocabulary: r["vocabulary.prefix"]?.[0], score: norm(label) === want ? 1 : Math.min(0.9, (r.score ?? 0) / 10) };
    })
    .filter((c) => c.iri);
}

async function lookupSchemaOrg(name: string, kind: "class" | "property", f: Fetch): Promise<Candidate[]> {
  const want = norm(name);
  return (await schemaOrg(f))
    .filter((t) => t.kind === kind && norm(t.label) === want)
    .map((t) => ({ iri: t.iri, label: t.label, source: "schemaorg" as const, vocabulary: "schema", score: 1 }));
}

async function lookupBioportal(name: string, f: Fetch): Promise<Candidate[]> {
  if (!BIOPORTAL_API_KEY) return [];
  const data = (await getJson(f, `https://data.bioontology.org/search?require_exact_match=true&pagesize=5&apikey=${encodeURIComponent(BIOPORTAL_API_KEY)}&q=${encodeURIComponent(words(name))}`)) as {
    collection?: { "@id"?: string; prefLabel?: string; links?: { ontology?: string } }[];
  };
  return (data.collection ?? [])
    .filter((c) => c["@id"])
    .map((c) => ({ iri: c["@id"]!, label: c.prefLabel ?? localName(c["@id"]!), source: "bioportal" as const, vocabulary: c.links?.ontology?.split("/").pop(), score: 0.95 }));
}

export interface ReuseOptions {
  sources?: string[];
  /** at most this many terms are looked up */
  max?: number;
  fetch?: Fetch;
}

/** Reuse suggestions for the T-Box's own classes and properties (best candidates first, one list per term). */
export async function suggestReuse(tbox: TBoxModel, opts: ReuseOptions = {}): Promise<ReuseSuggestion[]> {
  const sources = (opts.sources ?? REUSE_SOURCES).filter((s): s is Source => s === "lov" || s === "schemaorg" || s === "bioportal");
  if (!sources.length) return [];
  const f = opts.fetch ?? fetch;
  const terms = [...tbox.classes.map((c) => ({ uri: c.uri, kind: "class" as const })), ...[...tbox.objectProps, ...tbox.dataProps].map((p) => ({ uri: p.uri, kind: "property" as const }))]
    // Terms already in a public vocabulary need no lookup.
    .filter((t) => !/schema\.org|w3\.org|purl\.org|xmlns\.com/.test(t.uri))
    .slice(0, opts.max ?? 60);
  const out: ReuseSuggestion[] = [];
  for (let i = 0; i < terms.length; i += 4) {
    await Promise.all(
      terms.slice(i, i + 4).map(async (t) => {
        const name = localName(t.uri);
        const found: Candidate[] = [];
        for (const s of sources) {
          try {
            if (s === "lov") found.push(...(await lookupLov(name, t.kind, f)));
            else if (s === "schemaorg") found.push(...(await lookupSchemaOrg(name, t.kind, f)));
            else found.push(...(await lookupBioportal(name, f)));
          } catch {
            /* a source that is down is skipped */
          }
        }
        const strong = found.filter((c) => c.score >= 0.9 && c.iri !== t.uri);
        const unique = [...new Map(strong.map((c) => [c.iri, c])).values()].sort((a, b) => b.score - a.score).slice(0, 3);
        if (unique.length) out.push({ term: t.uri, kind: t.kind, candidates: unique, status: "open" });
      }),
    );
  }
  return out;
}

/** The Turtle to add when a reuse is accepted: an equivalence axiom. */
export function reuseTriples(termUri: string, kind: "class" | "property", iri: string): string {
  const pred = kind === "class" ? `${OWL}equivalentClass` : `${OWL}equivalentProperty`;
  return `<${termUri}> <${pred}> <${iri}> .\n`;
}
