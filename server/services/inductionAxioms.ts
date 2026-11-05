// Beyond classes and properties (Research Area 1): an induced ontology without
// disjointness, restrictions or inverses cannot catch a wrong extraction or
// support a reasoner. The model proposes such axioms in a structured form; the
// reasoner admits only those that leave every class satisfiable. Also: the
// grounding of induced terms in the documents (every term should be traceable
// to a passage — the guard against hallucinated concepts).

import { Parser, Writer } from "n3";
import type { TermEvidence } from "../../src/types/project.ts";
import type { PropertyCharacteristic } from "../../src/types/tbox.ts";
import type { OntoModule } from "../../src/types/validation.ts";
import {
  serializeTBoxStructured,
  toTermLocalName,
  type RawRestriction,
  type RawTBox,
  type RawTBoxClass,
  type RawTBoxDataProp,
  type RawTBoxObjectProp,
} from "../../src/lib/ontology/tboxSerializer.ts";
import { reasonModules } from "../../src/lib/ontology/reasoner/index.ts";
import { OWL, RDF, RDFS, XSD } from "../../src/lib/ontology/iri.ts";
import { locateQuote } from "./evidence.ts";

/* ───────────────────────── grounding ───────────────────────── */

/** Locate each term's supporting quote in the text it was induced from. */
export function groundTerms(
  items: { name: string; quote?: string; kind: TermEvidence["kind"] }[],
  docs: { text: string; documentId?: string; chunkId?: string; start?: number }[],
): TermEvidence[] {
  return items.map((it) => {
    const quote = (it.quote ?? "").trim().slice(0, 400);
    let hit: { doc: (typeof docs)[number]; span: { start: number; end: number } } | undefined;
    if (quote)
      for (const doc of docs) {
        const span = locateQuote(quote, doc.text);
        if (span) {
          hit = { doc, span };
          break;
        }
      }
    return {
      term: toTermLocalName(it.name),
      kind: it.kind,
      quote,
      located: !!hit,
      ...(hit?.doc.documentId ? { documentId: hit.doc.documentId } : {}),
      ...(hit?.doc.chunkId ? { chunkId: hit.doc.chunkId } : {}),
      ...(hit?.span && hit.doc.start !== undefined ? { start: hit.doc.start + hit.span.start, end: hit.doc.start + hit.span.end } : {}),
    };
  });
}

/**
 * Keep grounded classes, plus ungrounded ones that are parents of grounded
 * classes (a mid-level class like "Agent" is rarely stated in the text, but is
 * needed to hold the hierarchy together).
 */
export function keepGrounded(classes: RawTBoxClass[], evidence: TermEvidence[]): { kept: RawTBoxClass[]; dropped: string[] } {
  const located = new Set(evidence.filter((e) => e.located).map((e) => e.term));
  const keep = new Set(classes.filter((c) => located.has(toTermLocalName(c.name))).map((c) => toTermLocalName(c.name)));
  // close upwards over parents
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of classes) {
      if (!keep.has(toTermLocalName(c.name))) continue;
      for (const p of c.parents ?? []) {
        const n = toTermLocalName(p);
        if (!keep.has(n) && classes.some((x) => toTermLocalName(x.name) === n)) {
          keep.add(n);
          grew = true;
        }
      }
    }
  }
  return {
    kept: classes.filter((c) => keep.has(toTermLocalName(c.name))),
    dropped: classes.filter((c) => !keep.has(toTermLocalName(c.name))).map((c) => c.name),
  };
}

/* ───────────────────────── axiom proposals ───────────────────────── */

export const AXIOM_SCHEMA = {
  type: "object",
  properties: {
    disjointGroups: {
      type: "array",
      description: "groups of classes no individual can belong to two of at once",
      items: {
        type: "object",
        properties: { classes: { type: "array", items: { type: "string" } }, why: { type: "string" } },
        required: ["classes", "why"],
        additionalProperties: false,
      },
    },
    restrictions: {
      type: "array",
      description: "class-level constraints the text states (every X has at least one Y, at most one Z, only W)",
      items: {
        type: "object",
        properties: {
          class: { type: "string" },
          property: { type: "string" },
          kind: { type: "string", enum: ["some", "only", "min", "max", "exactly"] },
          value: { type: "string", description: "filler class name (for some/only, or a qualified count); omit for an unqualified count" },
          n: { type: "integer", description: "the bound for min/max/exactly" },
          why: { type: "string" },
        },
        required: ["class", "property", "kind", "why"],
        additionalProperties: false,
      },
    },
    inverses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          property: { type: "string" },
          inverseName: { type: "string", description: "camelCase name of the inverse relation" },
          why: { type: "string" },
        },
        required: ["property", "inverseName", "why"],
        additionalProperties: false,
      },
    },
    characteristics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          property: { type: "string" },
          characteristic: { type: "string", enum: ["transitive", "symmetric", "asymmetric", "irreflexive", "inverseFunctional"] },
          why: { type: "string" },
        },
        required: ["property", "characteristic", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["disjointGroups", "restrictions", "inverses", "characteristics"],
  additionalProperties: false,
} as const;

export const AXIOM_SYSTEM = [
  "You are an ontology engineer adding LOGICAL AXIOMS to a draft ontology, so that a reasoner can detect contradictions and wrong data.",
  "Propose only axioms the domain clearly supports — a wrong axiom is worse than a missing one:",
  "- disjointGroups: sibling classes no single thing can be at once (a Person is never an Organization). Never make a class disjoint with its own parent or child.",
  "- restrictions: constraints the purpose, the definitions or the competency questions state (every Contract has at least one Party → some/min 1; a Patient has at most one DateOfBirth → max 1).",
  "- inverses: a relation that is naturally read in the other direction too (employs ↔ worksFor).",
  "- characteristics: transitive (partOf), symmetric (adjacentTo), asymmetric, irreflexive, inverseFunctional (a value identifies its subject).",
  "Use only the class and property names given. Give a one-line reason for each.",
].join("\n");

const KIND: Record<string, RawRestriction["kind"]> = {
  some: "someValuesFrom",
  only: "allValuesFrom",
  min: "minCardinality",
  max: "maxCardinality",
  exactly: "cardinality",
};

export interface AxiomUnit {
  /** readable form, for the review list */
  label: string;
  raw: RawTBox;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Turn the model's proposals into self-contained units, dropping any that name unknown terms. */
export function axiomUnits(
  data: Obj,
  known: { classes: Set<string>; objectProps: Map<string, { domain: string[]; range: string[] }>; dataProps: Map<string, string> },
  maxUnits = 60,
): AxiomUnit[] {
  const units: AxiomUnit[] = [];
  const cls = (n: string) => (known.classes.has(toTermLocalName(n)) ? toTermLocalName(n) : null);
  for (const g of (Array.isArray(data.disjointGroups) ? data.disjointGroups : []) as Obj[]) {
    const members = [...new Set((Array.isArray(g.classes) ? g.classes : []).map((c) => cls(String(c))).filter((c): c is string => !!c))];
    if (members.length >= 2) units.push({ label: `disjoint: ${members.join(", ")}`, raw: { classes: [], disjointGroups: [members] } });
  }
  for (const r of (Array.isArray(data.restrictions) ? data.restrictions : []) as Obj[]) {
    const c = cls(str(r.class));
    const p = toTermLocalName(str(r.property));
    const kind = KIND[str(r.kind)];
    if (!c || !kind || (!known.objectProps.has(p) && !known.dataProps.has(p))) continue;
    const isData = known.dataProps.has(p);
    const filler = str(r.value);
    const value = isData ? `xsd:${known.dataProps.get(p) || "string"}` : filler && cls(filler) ? cls(filler)! : undefined;
    if ((kind === "someValuesFrom" || kind === "allValuesFrom") && !value && !isData) continue;
    const n = kind === "someValuesFrom" || kind === "allValuesFrom" ? undefined : Number.isInteger(r.n) ? Math.max(0, Number(r.n)) : 1;
    const restr: RawRestriction = { property: p, kind, ...(value ? { value } : {}), ...(n != null ? { n } : {}) };
    units.push({
      label: `${c} ⊑ ${p} ${str(r.kind)}${n != null ? ` ${n}` : ""}${value ? ` ${value}` : ""}`,
      raw: { classes: [{ name: c, restrictions: [restr] }] },
    });
  }
  for (const inv of (Array.isArray(data.inverses) ? data.inverses : []) as Obj[]) {
    const p = toTermLocalName(str(inv.property));
    const q = toTermLocalName(str(inv.inverseName));
    const prop = known.objectProps.get(p);
    if (!prop || !q || q === p || known.dataProps.has(q) || known.classes.has(q)) continue;
    const existingInverse = known.objectProps.get(q);
    const op: RawTBoxObjectProp = existingInverse
      ? { name: q, inverseOf: p }
      : { name: q, inverseOf: p, comment: `Inverse of ${p}.`, domain: prop.range.slice(0, 1), range: prop.domain.slice(0, 1) };
    units.push({ label: `${q} inverse of ${p}`, raw: { classes: [], objectProperties: [op] } });
  }
  for (const ch of (Array.isArray(data.characteristics) ? data.characteristics : []) as Obj[]) {
    const p = toTermLocalName(str(ch.property));
    const c = str(ch.characteristic) as PropertyCharacteristic;
    if (!known.objectProps.has(p) || !["transitive", "symmetric", "asymmetric", "irreflexive", "inverseFunctional"].includes(c)) continue;
    units.push({ label: `${p} is ${c}`, raw: { classes: [], objectProperties: [{ name: p, characteristics: [c] }] } });
  }
  return units.slice(0, maxUnits);
}

/** The set of names an axiom proposal may use: the induced terms plus the existing ontology's. */
export function knownNames(
  raw: RawTBox,
  existing: {
    classes: string[];
    objectProps: { name: string; domain: string[]; range: string[] }[];
    dataProps: { name: string; datatype: string }[];
  },
) {
  const classes = new Set([...raw.classes.map((c) => toTermLocalName(c.name)), ...existing.classes]);
  const objectProps = new Map<string, { domain: string[]; range: string[] }>([
    ...existing.objectProps.map((p) => [p.name, { domain: p.domain, range: p.range }] as const),
    ...(raw.objectProperties ?? []).map((p) => [toTermLocalName(p.name), { domain: p.domain ?? [], range: p.range ?? [] }] as const),
  ]);
  const dataProps = new Map<string, string>([
    ...existing.dataProps.map((p) => [p.name, p.datatype] as const),
    ...(raw.dataProperties ?? []).map((p: RawTBoxDataProp) => [toTermLocalName(p.name), p.datatype ?? "string"] as const),
  ]);
  return { classes, objectProps, dataProps };
}

/* ───────────────────────── turtle helpers ───────────────────────── */

/** Union of two Turtle documents (blank nodes kept apart), re-serialised. */
export function mergeTurtle(a: string, b: string, prefixes: Record<string, string> = {}): string {
  const quads = [...new Parser().parse(a), ...new Parser().parse(b)];
  const seen = new Set<string>();
  const unique = quads.filter((q) => {
    const k = `${q.subject.termType}:${q.subject.value} ${q.predicate.value} ${q.object.termType}:${q.object.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const writer = new Writer({ prefixes: { owl: OWL, rdf: RDF, rdfs: RDFS, xsd: XSD, ...prefixes } });
  writer.addQuads(unique);
  let out = "";
  writer.end((err, result) => {
    if (!err) out = result;
  });
  return out;
}

/**
 * Admit axiom units one by one, keeping a unit only if every class stays
 * satisfiable (with the existing ontology loaded too). Returns the module with
 * the admitted axioms and the reasons units were turned down.
 */
export function admitAxioms(
  existingModules: Pick<OntoModule, "name" | "turtle">[],
  inducedTurtle: string,
  units: AxiomUnit[],
  ns: string,
): { turtle: string; accepted: string[]; rejected: { axiom: string; reason: string }[] } {
  const unsatOf = (turtle: string) =>
    new Set(reasonModules([...existingModules, { name: "induced.ttl", turtle }]).report.unsatisfiable.map((u) => u.cls));
  const baseline = unsatOf(inducedTurtle);
  const withUnits = (us: AxiomUnit[]) => us.reduce((t, u) => mergeTurtle(t, serializeTBoxStructured(u.raw, ns), { "": ns }), inducedTurtle);
  const newUnsat = (turtle: string) => [...unsatOf(turtle)].filter((c) => !baseline.has(c));

  // fast path: everything together is fine
  const all = withUnits(units);
  if (!newUnsat(all).length) return { turtle: all, accepted: units.map((u) => u.label), rejected: [] };

  let turtle = inducedTurtle;
  const accepted: string[] = [];
  const rejected: { axiom: string; reason: string }[] = [];
  for (const u of units) {
    const next = mergeTurtle(turtle, serializeTBoxStructured(u.raw, ns), { "": ns });
    const broken = newUnsat(next);
    if (broken.length)
      rejected.push({ axiom: u.label, reason: `would make ${broken.map((c) => c.replace(/^.*[#/]/, "")).join(", ")} unsatisfiable` });
    else {
      turtle = next;
      accepted.push(u.label);
    }
  }
  return { turtle, accepted, rejected };
}
