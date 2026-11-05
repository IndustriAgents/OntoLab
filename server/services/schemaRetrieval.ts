// Schema retrieval (B2, the Extract-Define-Canonicalize schema retriever, EMNLP
// 2024). A large ontology (FIBO, SNOMED subsets) does not fit in one prompt,
// and every class and property becoming a JSON-schema enum makes it worse. For
// such ontologies each chunk gets only the relevant part: the terms whose
// label + definition are closest to the chunk, closed under ancestors and the
// domain/range classes of the chosen properties, so the sub-schema stays
// consistent (every property's subject and object types are present).

import type { TechnicalResult } from "../../src/types/research.ts";
import type { TBoxModel, TBoxProperty } from "../../src/types/tbox.ts";
import { localName } from "../../src/lib/ontology/iri.ts";
import { SCHEMA_RETRIEVAL_MIN_TERMS, SCHEMA_TOP_K } from "../config.ts";
import { cosine, type Embedder } from "../ml/embeddings.ts";

export function termCount(tbox: TBoxModel): number {
  return tbox.classes.length + tbox.objectProps.length + tbox.dataProps.length;
}

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");

/** The text a term is embedded as: its name, label and definition. */
export function termText(t: { uri: string; label?: string; comment?: string }, kind: "class" | "object" | "data"): string {
  const name = words(localName(t.uri));
  const head = t.label && t.label.toLowerCase() !== name.toLowerCase() ? `${name} (${t.label})` : name;
  return `${kind === "class" ? "class" : kind === "object" ? "relation" : "attribute"}: ${head}${t.comment ? ` — ${t.comment}` : ""}`;
}

function ancestors(tbox: TBoxModel, uris: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...uris];
  while (stack.length) {
    const c = stack.pop()!;
    if (out.has(c)) continue;
    out.add(c);
    stack.push(...(tbox.subClassOf[c] ?? []));
  }
  return out;
}

/** Restrict a T-Box to the given classes and properties (subclass links and restrictions inside the set). */
export function subTBox(tbox: TBoxModel, classUris: Set<string>, propUris: Set<string>): TBoxModel {
  const keepProp = (p: TBoxProperty) => propUris.has(p.uri);
  return {
    ...tbox,
    classes: tbox.classes.filter((c) => classUris.has(c.uri)),
    objectProps: tbox.objectProps.filter(keepProp),
    dataProps: tbox.dataProps.filter(keepProp),
    subClassOf: Object.fromEntries(
      Object.entries(tbox.subClassOf)
        .filter(([c]) => classUris.has(c))
        .map(([c, ps]) => [c, ps.filter((p) => classUris.has(p))]),
    ),
    restrictions: (tbox.restrictions ?? []).filter((r) => classUris.has(r.onClass) && propUris.has(r.onProperty)),
  };
}

export interface RetrievedSchema {
  tbox: TBoxModel;
  /** true when the full T-Box was used (small ontology or no embeddings) */
  full: boolean;
  retrievedTerms: number;
  totalTerms: number;
  technical?: TechnicalResult;
}

/** Term embeddings per (embedder, T-Box), computed once per process. */
const termVectors = new Map<string, Float32Array[]>();

async function vectorsFor(tbox: TBoxModel, embedder: Embedder, key: string): Promise<Float32Array[]> {
  const cacheKey = `${embedder.id}|${key}`;
  const hit = termVectors.get(cacheKey);
  if (hit) return hit;
  const texts = [
    ...tbox.classes.map((c) => termText(c, "class")),
    ...tbox.objectProps.map((p) => termText(p, "object")),
    ...tbox.dataProps.map((p) => termText(p, "data")),
  ];
  const vecs = await embedder.embed(texts);
  termVectors.set(cacheKey, vecs);
  if (termVectors.size > 20) termVectors.delete(termVectors.keys().next().value!);
  return vecs;
}

/** Windows of the chunk, so a long chunk's later topics still count. */
function windows(text: string, size = 1500): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

/**
 * Per-term relevance to a chunk: max cosine over the chunk's windows, plus a
 * lexical bonus when the term's name or label literally occurs in the text.
 */
export async function scoreTermsDetailed(tbox: TBoxModel, text: string, embedder: Embedder, tboxKey: string) {
  const termVecs = await vectorsFor(tbox, embedder, tboxKey);
  const texts = windows(text);
  const chunkVecs = await embedder.embed(texts);
  const lower = text.toLowerCase();
  const terms = [...tbox.classes, ...tbox.objectProps, ...tbox.dataProps];
  const rows = terms.map((t, i) => {
    const windowCosines = chunkVecs.map((v) => cosine(termVecs[i], v));
    const maxCosine = Math.max(-1, ...windowCosines);
    const name = words(localName(t.uri)).toLowerCase();
    const lexical = (name.length > 3 && lower.includes(name)) || (!!t.label && t.label.length > 3 && lower.includes(t.label.toLowerCase()));
    const lexicalBonus = lexical ? 0.3 : 0;
    return {
      term: t.uri,
      kind: i < tbox.classes.length ? "class" : "property",
      maxCosine,
      windowCosines,
      lexicalBonus,
      score: maxCosine + lexicalBonus,
    };
  });
  return {
    rows,
    parameters: {
      embedder: embedder.id,
      dimensions: termVecs[0]?.length ?? 0,
      windowChars: 1500,
      coverage: "Full source text; no window cap",
      evaluatedWindows: texts.length,
      embeddedChars: texts.reduce((n, t) => n + t.length, 0),
      inputChars: text.length,
      lexicalBonus: 0.3,
    },
  };
}

export async function scoreTerms(tbox: TBoxModel, text: string, embedder: Embedder, tboxKey: string): Promise<number[]> {
  return (await scoreTermsDetailed(tbox, text, embedder, tboxKey)).rows.map((r) => r.score);
}

export async function retrieveSchema(
  tbox: TBoxModel,
  text: string,
  embedder: Embedder | null,
  tboxKey: string,
  opts: { force?: boolean; k?: number } = {},
): Promise<RetrievedSchema> {
  const total = termCount(tbox);
  if (!embedder || (!opts.force && total < SCHEMA_RETRIEVAL_MIN_TERMS))
    return {
      tbox,
      full: true,
      retrievedTerms: total,
      totalTerms: total,
      technical: {
        title: "Schema selection",
        method: "Full ontology; no similarity ranking performed",
        parameters: {
          reason: !embedder ? "Embeddings unavailable or disabled" : "Ontology below retrieval size threshold",
          totalTerms: total,
          minimumTerms: SCHEMA_RETRIEVAL_MIN_TERMS,
        },
        rows: [],
        columns: [],
      },
    };
  const k = opts.k ?? SCHEMA_TOP_K;
  const scored = await scoreTermsDetailed(tbox, text, embedder, tboxKey);
  const scores = scored.rows.map((r) => r.score);
  const nC = tbox.classes.length;
  const props = [...tbox.objectProps, ...tbox.dataProps];
  const rank = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => from + i)
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, k);

  const direct = new Set([...rank(0, nC), ...rank(nC, nC + props.length)]);
  const classUris = new Set(rank(0, nC).map((i) => tbox.classes[i].uri));
  const propUris = new Set(rank(nC, nC + props.length).map((i) => props[i - nC].uri));
  // The chosen properties' subject and object classes come along…
  for (const p of props) if (propUris.has(p.uri)) for (const c of [...p.domain, ...(p.kind === "object" ? p.range : [])]) classUris.add(c);
  // …and every chosen class's ancestors, so inheritance still reads correctly.
  const closed = ancestors(tbox, classUris);
  const known = new Set(tbox.classes.map((c) => c.uri));
  const classes = new Set([...closed].filter((c) => known.has(c)));
  // Properties fully inside the chosen classes are cheap and often needed.
  for (const p of props)
    if (p.domain.length && p.domain.every((d) => classes.has(d)) && (p.kind === "data" || p.range.every((r) => classes.has(r))))
      propUris.add(p.uri);
  const sub = subTBox(tbox, classes, propUris);
  const rows = scored.rows
    .map((r, i) => ({
      ...r,
      decision: direct.has(i)
        ? "Top-k selection"
        : (r.kind === "class" ? classes.has(r.term) : propUris.has(r.term))
          ? "Included by schema closure"
          : "Excluded",
    }))
    .sort((a, b) => Number(a.decision === "Excluded") - Number(b.decision === "Excluded") || b.score - a.score);
  return {
    tbox: sub,
    full: false,
    retrievedTerms: termCount(sub),
    totalTerms: total,
    technical: {
      title: "Schema retrieval scores",
      method: "score = max cosine(term, chunk window) + lexical bonus; top-k classes and top-k properties, then schema closure",
      parameters: { ...scored.parameters, topKPerKind: k },
      rows: rows.slice(0, 2000),
      totalRows: rows.length,
      columns: ["term", "kind", "maxCosine", "lexicalBonus", "score", "decision", "windowCosines"],
      note: "Scores can exceed 1 because the lexical bonus is added. Ancestors and property domain/range terms may be included without a top-k rank. Window cosines follow source order, with at most six 1,500-character windows.",
    },
  };
}
