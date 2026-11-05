import { DataFactory, Writer, type Quad, type BlankNode, type NamedNode } from "n3";
import { normalizeBase } from "./uri";
import { RDF, RDF_TYPE, RDFS, RDFS_LABEL, RDFS_COMMENT, OWL, XSD, xsdUri } from "./iri";
import type { PropertyCharacteristic, RestrictionKind } from "../../types/tbox";

const { namedNode, literal, quad, blankNode } = DataFactory;

const RDFS_DOMAIN = RDFS + "domain";
const RDFS_RANGE = RDFS + "range";
const RDFS_SUBCLASS = RDFS + "subClassOf";
const RDFS_SUBPROP = RDFS + "subPropertyOf";
const OWL_CLASS = OWL + "Class";
const OWL_OBJECT_PROPERTY = OWL + "ObjectProperty";
const OWL_DATATYPE_PROPERTY = OWL + "DatatypeProperty";
const OWL_FUNCTIONAL = OWL + "FunctionalProperty";
const RDF_FIRST = RDF + "first";
const RDF_REST = RDF + "rest";
const RDF_NIL = RDF + "nil";
const CHARACTERISTIC_TYPES: Record<PropertyCharacteristic, string> = {
  transitive: OWL + "TransitiveProperty",
  symmetric: OWL + "SymmetricProperty",
  asymmetric: OWL + "AsymmetricProperty",
  reflexive: OWL + "ReflexiveProperty",
  irreflexive: OWL + "IrreflexiveProperty",
  inverseFunctional: OWL + "InverseFunctionalProperty",
};
const QUALIFIED: Record<string, string> = {
  minCardinality: "minQualifiedCardinality",
  maxCardinality: "maxQualifiedCardinality",
  cardinality: "qualifiedCardinality",
};

/* The structured T-Box the LLM emits via the emit_tbox tool. Class/property
 * `name`s are local names; `parents`/`domain`/`range` reference class `name`s. */

/** A class axiom of the form `Class SubClassOf property kind [n] [value]`. */
export interface RawRestriction {
  property: string;
  kind: RestrictionKind;
  /** filler class name (object property) or datatype (data property, or an `xsd:` name); optional for cardinalities */
  value?: string;
  /** bound for the cardinality kinds (defaults to 1) */
  n?: number;
}
export interface RawTBoxClass {
  name: string;
  label?: string;
  comment?: string;
  parents?: string[];
  /** names of classes this one shares no members with (owl:disjointWith) */
  disjointWith?: string[];
  /** names of classes with exactly the same members (owl:equivalentClass) */
  equivalentTo?: string[];
  restrictions?: RawRestriction[];
}
export interface RawTBoxObjectProp {
  name: string;
  label?: string;
  comment?: string;
  domain?: string[];
  range?: string[];
  functional?: boolean;
  inverseOf?: string;
  /** super-properties (rdfs:subPropertyOf) */
  parents?: string[];
  characteristics?: PropertyCharacteristic[];
}
export interface RawTBoxDataProp {
  name: string;
  label?: string;
  comment?: string;
  domain?: string[];
  datatype?: string;
  functional?: boolean;
  parents?: string[];
}
export interface RawTBox {
  classes: RawTBoxClass[];
  objectProperties?: RawTBoxObjectProp[];
  dataProperties?: RawTBoxDataProp[];
  /** groups of mutually disjoint classes (owl:AllDisjointClasses) */
  disjointGroups?: string[][];
}

/** Turn a name into a safe IRI local name (NCName-ish), preserving case so
 * PascalCase classes / camelCase properties survive. */
export function toTermLocalName(name: string): string {
  const cleaned = (name ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "")
    .replace(/^[^A-Za-z_]+/, "");
  return cleaned || "X";
}

/**
 * Deterministically serialize a structured T-Box (as emitted by the LLM) to
 * Turtle. URIs are minted from the base IRI; the result round-trips through
 * parseTBox (owl:Class / owl:ObjectProperty / owl:DatatypeProperty with
 * rdfs:subClassOf / rdfs:domain / rdfs:range, plus disjointness, equivalence,
 * owl:Restrictions, inverses, sub-properties and property characteristics), so
 * a generated T-Box behaves exactly like an uploaded one. Unknown datatype
 * hints fall back to xsd:string (never an invalid `xsd:text`-style IRI).
 */
export function serializeTBoxStructured(raw: RawTBox, baseIri?: string): string {
  const base = normalizeBase(baseIri || "http://ontolab.example/onto#");
  const classUri = (name: string) => base + toTermLocalName(name);
  const dataPropNames = new Set((raw.dataProperties ?? []).map((p) => p?.name));

  const quads: Quad[] = [];
  const labelComment = (subj: ReturnType<typeof namedNode>, label?: string, comment?: string) => {
    if (label) quads.push(quad(subj, namedNode(RDFS_LABEL), literal(label)));
    if (comment) quads.push(quad(subj, namedNode(RDFS_COMMENT), literal(comment)));
  };

  /** An RDF list of terms; returns its head. */
  const list = (items: NamedNode[]): BlankNode | NamedNode => {
    if (!items.length) return namedNode(RDF_NIL);
    const head = blankNode();
    let cur: BlankNode = head;
    items.forEach((item, i) => {
      quads.push(quad(cur, namedNode(RDF_FIRST), item));
      if (i === items.length - 1) quads.push(quad(cur, namedNode(RDF_REST), namedNode(RDF_NIL)));
      else {
        const next = blankNode();
        quads.push(quad(cur, namedNode(RDF_REST), next));
        cur = next;
      }
    });
    return head;
  };

  /** One owl:Restriction blank node, or null when the input is unusable. */
  const restriction = (r: RawRestriction): BlankNode | null => {
    if (!r?.property || !r.kind) return null;
    const isData = dataPropNames.has(r.property) || /^xsd:/i.test(r.value ?? "");
    const filler = r.value ? namedNode(isData ? xsdUri(r.value) : classUri(r.value)) : null;
    const bn = blankNode();
    quads.push(quad(bn, namedNode(RDF_TYPE), namedNode(OWL + "Restriction")));
    quads.push(quad(bn, namedNode(OWL + "onProperty"), namedNode(classUri(r.property))));
    if (r.kind === "someValuesFrom" || r.kind === "allValuesFrom") {
      quads.push(quad(bn, namedNode(OWL + r.kind), filler ?? namedNode(OWL + "Thing")));
      return bn;
    }
    const n = Math.max(0, Math.floor(Number.isFinite(Number(r.n)) ? Number(r.n) : 1));
    const count = literal(String(n), namedNode(XSD + "nonNegativeInteger"));
    if (filler) {
      quads.push(quad(bn, namedNode(OWL + QUALIFIED[r.kind]), count));
      quads.push(quad(bn, namedNode(OWL + (isData ? "onDataRange" : "onClass")), filler));
    } else {
      quads.push(quad(bn, namedNode(OWL + r.kind), count));
    }
    return bn;
  };

  for (const c of raw.classes ?? []) {
    if (!c?.name) continue;
    const subj = namedNode(classUri(c.name));
    quads.push(quad(subj, namedNode(RDF_TYPE), namedNode(OWL_CLASS)));
    labelComment(subj, c.label, c.comment);
    for (const p of c.parents ?? []) {
      if (p) quads.push(quad(subj, namedNode(RDFS_SUBCLASS), namedNode(classUri(p))));
    }
    for (const d of c.disjointWith ?? []) if (d && d !== c.name) quads.push(quad(subj, namedNode(OWL + "disjointWith"), namedNode(classUri(d))));
    for (const e of c.equivalentTo ?? []) if (e && e !== c.name) quads.push(quad(subj, namedNode(OWL + "equivalentClass"), namedNode(classUri(e))));
    for (const r of c.restrictions ?? []) {
      const bn = restriction(r);
      if (bn) quads.push(quad(subj, namedNode(RDFS_SUBCLASS), bn));
    }
  }

  for (const group of raw.disjointGroups ?? []) {
    const members = [...new Set((group ?? []).filter(Boolean))];
    if (members.length < 2) continue;
    const bn = blankNode();
    quads.push(quad(bn, namedNode(RDF_TYPE), namedNode(OWL + "AllDisjointClasses")));
    quads.push(quad(bn, namedNode(OWL + "members"), list(members.map((m) => namedNode(classUri(m))))));
  }

  for (const p of raw.objectProperties ?? []) {
    if (!p?.name) continue;
    const subj = namedNode(classUri(p.name));
    quads.push(quad(subj, namedNode(RDF_TYPE), namedNode(OWL_OBJECT_PROPERTY)));
    if (p.functional) quads.push(quad(subj, namedNode(RDF_TYPE), namedNode(OWL_FUNCTIONAL)));
    for (const ch of p.characteristics ?? []) {
      const t = CHARACTERISTIC_TYPES[ch];
      if (t) quads.push(quad(subj, namedNode(RDF_TYPE), namedNode(t)));
    }
    labelComment(subj, p.label, p.comment);
    for (const d of p.domain ?? []) if (d) quads.push(quad(subj, namedNode(RDFS_DOMAIN), namedNode(classUri(d))));
    for (const r of p.range ?? []) if (r) quads.push(quad(subj, namedNode(RDFS_RANGE), namedNode(classUri(r))));
    if (p.inverseOf) quads.push(quad(subj, namedNode(OWL + "inverseOf"), namedNode(classUri(p.inverseOf))));
    for (const s of p.parents ?? []) if (s) quads.push(quad(subj, namedNode(RDFS_SUBPROP), namedNode(classUri(s))));
  }

  for (const p of raw.dataProperties ?? []) {
    if (!p?.name) continue;
    const subj = namedNode(classUri(p.name));
    quads.push(quad(subj, namedNode(RDF_TYPE), namedNode(OWL_DATATYPE_PROPERTY)));
    if (p.functional) quads.push(quad(subj, namedNode(RDF_TYPE), namedNode(OWL_FUNCTIONAL)));
    labelComment(subj, p.label, p.comment);
    for (const d of p.domain ?? []) if (d) quads.push(quad(subj, namedNode(RDFS_DOMAIN), namedNode(classUri(d))));
    quads.push(quad(subj, namedNode(RDFS_RANGE), namedNode(xsdUri(p.datatype))));
    for (const s of p.parents ?? []) if (s) quads.push(quad(subj, namedNode(RDFS_SUBPROP), namedNode(classUri(s))));
  }

  const prefixes: Record<string, string> = { "": base, owl: OWL, rdf: RDF, rdfs: RDFS, xsd: XSD };
  const writer = new Writer({ prefixes });
  writer.addQuads(quads);
  let out = "";
  let writeErr: Error | null = null;
  writer.end((err, result) => {
    if (err) writeErr = err;
    else out = result;
  });
  if (writeErr) throw new Error(`T-Box serialize error: ${(writeErr as Error).message}`);
  return out;
}
