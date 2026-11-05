// Entity grounding (B3, SPIRES-style): link individuals to identifiers in
// public registries — Wikidata for organisations, people, products and works;
// GeoNames for places; UMLS for clinical concepts — as owl:sameAs. Types with
// real identifiers then match exactly across documents, and the export links
// out to the wider web of data.
//
// Precision over recall: a link is made only for an exact (normalised) name
// match with a single plausible hit. Anything else is left ungrounded.

import type { ABoxResult } from "../../src/types/abox.ts";
import type { TBoxModel } from "../../src/types/tbox.ts";
import { localName } from "../../src/lib/ontology/iri.ts";
import { displayName, normalizeEntityName } from "../../src/lib/ontology/resolution.ts";
import { EXTERNAL_TIMEOUT_MS, GEONAMES_USERNAME, UMLS_API_KEY } from "../config.ts";

export type GroundingSource = "wikidata" | "geonames" | "umls";

const SOURCE_FOR: [GroundingSource, RegExp][] = [
  ["geonames", /(location|place|city|country|region|site|address|municipality|state|province|jurisdiction)/i],
  ["umls", /(condition|diagnos|disease|disorder|medication|drug|substance|symptom|finding|procedure|allerg|observation|lab)/i],
  [
    "wikidata",
    /(organi[sz]ation|company|corporation|institution|agency|university|person|author|party|product|standard|regulation|law|journal|venue|software|brand|manufacturer|supplier|vendor|publisher)/i,
  ],
];

function classNames(tbox: TBoxModel, cls: string): string[] {
  const out: string[] = [];
  const labels = new Map(tbox.classes.map((c) => [c.uri, c.label ?? ""]));
  const seen = new Set<string>();
  const stack = [cls];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(localName(c), labels.get(c) ?? "");
    stack.push(...(tbox.subClassOf[c] ?? []));
  }
  return out.filter(Boolean);
}

/** Which registry fits an individual's class (or an ancestor), among the enabled ones. */
export function sourceForClass(tbox: TBoxModel, cls: string, enabled: GroundingSource[]): GroundingSource | null {
  const names = classNames(tbox, cls).join(" ");
  for (const [src, re] of SOURCE_FOR) if (enabled.includes(src) && re.test(names)) return src;
  return null;
}

export function availableSources(requested: string[]): GroundingSource[] {
  return requested.filter((s): s is GroundingSource =>
    s === "wikidata" ? true : s === "geonames" ? !!GEONAMES_USERNAME : s === "umls" ? !!UMLS_API_KEY : false,
  );
}

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string): Promise<unknown> {
  const res = await f(url, {
    headers: { "user-agent": "OntoLab/0.2 (knowledge-graph tool; entity grounding)", accept: "application/json" },
    signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/** One lookup: the identifier IRI when exactly one hit has exactly this name. */
export async function lookup(source: GroundingSource, name: string, f: Fetch = fetch): Promise<string | null> {
  const want = normalizeEntityName(name);
  if (want.length < 3) return null;
  if (source === "wikidata") {
    const data = (await getJson(
      f,
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=5&search=${encodeURIComponent(name)}`,
    )) as {
      search?: { id: string; label?: string; match?: { text?: string } }[];
    };
    const exact = (data.search ?? []).filter(
      (h) => normalizeEntityName(h.label ?? "") === want || normalizeEntityName(h.match?.text ?? "") === want,
    );
    return exact.length === 1 ? `http://www.wikidata.org/entity/${exact[0].id}` : null;
  }
  if (source === "geonames") {
    const data = (await getJson(
      f,
      `http://api.geonames.org/searchJSON?maxRows=5&isNameRequired=true&username=${encodeURIComponent(GEONAMES_USERNAME)}&q=${encodeURIComponent(name)}`,
    )) as {
      geonames?: { geonameId: number; name?: string; population?: number }[];
    };
    const exact = (data.geonames ?? []).filter((g) => normalizeEntityName(g.name ?? "") === want);
    // Several places share a name: take one only when it clearly dominates.
    if (!exact.length) return null;
    const sorted = [...exact].sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
    if (sorted.length > 1 && (sorted[1].population ?? 0) * 10 > (sorted[0].population ?? 0)) return null;
    return `https://sws.geonames.org/${sorted[0].geonameId}/`;
  }
  const data = (await getJson(
    f,
    `https://uts-ws.nlm.nih.gov/rest/search/current?searchType=exact&pageSize=3&apiKey=${encodeURIComponent(UMLS_API_KEY)}&string=${encodeURIComponent(name)}`,
  )) as {
    result?: { results?: { ui: string; name?: string }[] };
  };
  const hits = (data.result?.results ?? []).filter((r) => r.ui && r.ui !== "NONE");
  return hits.length === 1 ? `https://uts.nlm.nih.gov/uts/umls/concept/${hits[0].ui}` : null;
}

export interface GroundingResult {
  abox: ABoxResult;
  grounded: number;
  looked: number;
  failures: number;
}

/** Ground the individuals that have none yet; at most `max` lookups, a few at a time. */
export async function groundAbox(
  abox: ABoxResult,
  tbox: TBoxModel,
  sources: GroundingSource[],
  opts: { max?: number; fetch?: Fetch } = {},
): Promise<GroundingResult> {
  const f = opts.fetch ?? fetch;
  const max = opts.max ?? 200;
  const todo = abox.individuals
    .map((ind, i) => ({ ind, i, src: ind.sameAs?.length ? null : sourceForClass(tbox, ind.classUri, sources) }))
    .filter((x) => x.src)
    .slice(0, max);
  const out = abox.individuals.map((i) => ({ ...i }));
  const memo = new Map<string, Promise<string | null>>();
  let grounded = 0;
  let failures = 0;
  for (let k = 0; k < todo.length; k += 4) {
    await Promise.all(
      todo.slice(k, k + 4).map(async ({ ind, i, src }) => {
        const key = `${src}|${normalizeEntityName(displayName(ind))}`;
        if (!memo.has(key))
          memo.set(
            key,
            lookup(src!, displayName(ind), f).catch(() => (failures++, null)),
          );
        const iri = await memo.get(key)!;
        if (iri) {
          out[i].sameAs = [iri];
          grounded++;
        }
      }),
    );
  }
  return { abox: { ...abox, individuals: out }, grounded, looked: todo.length, failures };
}
