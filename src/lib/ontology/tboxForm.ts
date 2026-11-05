// Form-based T-Box editing: a class or property described as fields becomes
// quads in one module, replacing the term's previous declaration. The result
// is checked like any other ontology change (validateOntology), plus what it
// does to the individuals already in the A-Box.

import { DataFactory, Parser, Writer, type Quad, type Quad_Object } from "n3";
import type { OntoModule, ValidationReport } from "../../types/validation";
import type { ABoxResult, ValidationIssue } from "../../types/abox";
import type { TBoxModel } from "../../types/tbox";
import { OWL, RDF, RDFS, RDF_TYPE, XSD } from "./iri";
import { buildUpdatedModule, extractPrefixes } from "./tboxEdit";
import { parseTBox, mergeTBox } from "./tboxParser";
import { validateOntology } from "./validate";
import { validateABox } from "./aboxValidator";
import { diffIssues } from "./changeCheck";

const { namedNode, literal, blankNode, quad } = DataFactory;

interface TermBase {
  uri: string;
  label?: string;
  comment?: string;
}
export interface ClassTerm extends TermBase {
  kind: "class";
  parents: string[];
  disjointWith: string[];
}
export interface PropertyTerm extends TermBase {
  kind: "object" | "data";
  domain: string[];
  /** class URIs (object) or datatype URIs (data) */
  range: string[];
  parents?: string[];
  functional?: boolean;
  /** object properties only */
  inverseOf?: string;
}
export type TermSpec = ClassTerm | PropertyTerm;

export type TermEdit = { upsert: TermSpec } | { remove: string } | { rename: { from: string; to: string } };

/** Predicates the form owns on a term; anything else on it (restrictions, annotations) is kept. */
const MANAGED = new Set([
  RDF_TYPE,
  RDFS + "label",
  RDFS + "comment",
  RDFS + "subClassOf",
  RDFS + "subPropertyOf",
  RDFS + "domain",
  RDFS + "range",
  OWL + "disjointWith",
  OWL + "inverseOf",
]);
/** Symmetric links also stated from the other side; the form replaces both directions. */
const SYMMETRIC = new Set([OWL + "disjointWith", OWL + "inverseOf"]);

/** An owl:unionOf list for several domain/range members; a single member is itself. */
function classExpr(members: string[], out: Quad[]): Quad_Object {
  if (members.length === 1) return namedNode(members[0]);
  const head = blankNode();
  let cell = blankNode();
  out.push(quad(head, namedNode(OWL + "unionOf"), cell));
  members.forEach((m, i) => {
    out.push(quad(cell, namedNode(RDF + "first"), namedNode(m)));
    const next = i === members.length - 1 ? namedNode(RDF + "nil") : blankNode();
    out.push(quad(cell, namedNode(RDF + "rest"), next));
    if (next.termType === "BlankNode") cell = next;
  });
  return head;
}

/** The quads that declare a term. */
export function termQuads(t: TermSpec): Quad[] {
  const s = namedNode(t.uri);
  const out: Quad[] = [];
  const add = (p: string, o: Quad_Object) => out.push(quad(s, namedNode(p), o));
  if (t.label?.trim()) add(RDFS + "label", literal(t.label.trim()));
  if (t.comment?.trim()) add(RDFS + "comment", literal(t.comment.trim()));
  if (t.kind === "class") {
    add(RDF_TYPE, namedNode(OWL + "Class"));
    for (const p of t.parents) if (p !== t.uri) add(RDFS + "subClassOf", namedNode(p));
    for (const d of t.disjointWith) if (d !== t.uri) add(OWL + "disjointWith", namedNode(d));
    return out;
  }
  add(RDF_TYPE, namedNode(t.kind === "object" ? OWL + "ObjectProperty" : OWL + "DatatypeProperty"));
  if (t.functional) add(RDF_TYPE, namedNode(OWL + "FunctionalProperty"));
  for (const p of t.parents ?? []) if (p !== t.uri) add(RDFS + "subPropertyOf", namedNode(p));
  if (t.domain.length) add(RDFS + "domain", classExpr(t.domain, out));
  if (t.range.length) {
    if (t.kind === "data" && t.range.length > 1) add(RDFS + "range", namedNode(RDFS + "Literal"));
    else add(RDFS + "range", classExpr(t.range, out));
  }
  if (t.kind === "object" && t.inverseOf) add(OWL + "inverseOf", namedNode(t.inverseOf));
  return out;
}

function serialize(quads: Quad[], prefixes: Record<string, string>): string {
  const writer = new Writer({ prefixes });
  writer.addQuads(quads);
  let result = "";
  let failure: Error | null = null;
  writer.end((err, res) => {
    if (err) failure = err;
    else result = res;
  });
  if (failure) throw new Error(`module serialize error: ${(failure as Error).message}`);
  return result;
}

/** Replace a term's form-managed declaration in a module (other statements about it stay). */
function upsertTerm(turtle: string, t: TermSpec): string {
  const quads = turtle.trim() ? new Parser().parse(turtle) : [];
  // blank nodes that only served the old domain/range union lists go with them
  const dropped = new Set<string>();
  const kept = quads.filter((q) => {
    const own = q.subject.termType === "NamedNode" && q.subject.value === t.uri && MANAGED.has(q.predicate.value);
    const mirrored = q.object.termType === "NamedNode" && q.object.value === t.uri && SYMMETRIC.has(q.predicate.value);
    if (own && q.object.termType === "BlankNode" && (q.predicate.value === RDFS + "domain" || q.predicate.value === RDFS + "range")) dropped.add(q.object.value);
    // a subClassOf restriction (blank node) is not form-managed
    if (own && q.predicate.value === RDFS + "subClassOf" && q.object.termType === "BlankNode") return true;
    return !own && !mirrored;
  });
  // follow the union list cells
  let grew = true;
  while (grew) {
    grew = false;
    for (const q of kept) {
      if (q.subject.termType === "BlankNode" && dropped.has(q.subject.value) && q.object.termType === "BlankNode" && !dropped.has(q.object.value)) {
        dropped.add(q.object.value);
        grew = true;
      }
    }
  }
  const out = kept.filter((q) => !(q.subject.termType === "BlankNode" && dropped.has(q.subject.value)));
  const extra: Quad[] = termQuads(t);
  // state the symmetric links from the other side too, so the parser sees them either way
  if (t.kind === "class") for (const d of t.disjointWith) extra.push(quad(namedNode(d), namedNode(OWL + "disjointWith"), namedNode(t.uri)));
  if (t.kind === "object" && t.inverseOf) extra.push(quad(namedNode(t.inverseOf), namedNode(OWL + "inverseOf"), namedNode(t.uri)));
  return serialize([...out, ...extra], { owl: OWL, rdfs: RDFS, xsd: XSD, ...extractPrefixes(turtle) });
}

/** Apply one form edit to a module's Turtle. */
export function applyTermEdit(turtle: string, edit: TermEdit): string {
  if ("upsert" in edit) return upsertTerm(turtle, edit.upsert);
  if ("remove" in edit) return buildUpdatedModule(turtle, { removeUris: [edit.remove] });
  return buildUpdatedModule(turtle, { renames: [{ fromUri: edit.rename.from, toUri: edit.rename.to }] });
}

/** The module that declares a term (first match), so edits land where the term lives. */
export function moduleOfTerm(modules: OntoModule[], uri: string): OntoModule | undefined {
  for (const m of modules) {
    try {
      const t = parseTBox(m.turtle);
      if ([...t.classes, ...t.objectProps, ...t.dataProps].some((x) => x.uri === uri)) return m;
    } catch {
      /* unparseable modules declare nothing */
    }
  }
  return undefined;
}

function mergedTBox(modules: OntoModule[], baseIri?: string): TBoxModel | null {
  const models: TBoxModel[] = [];
  for (const m of modules) {
    try {
      models.push(parseTBox(m.turtle));
    } catch {
      /* reported by validateOntology */
    }
  }
  return models.length ? mergeTBox(models, baseIri || undefined) : null;
}

/** The individuals that use a term (as a type, a property or a range target class). */
export function termUsage(abox: ABoxResult | null, uri: string): string[] {
  return (abox?.individuals ?? [])
    .filter(
      (i) =>
        i.classUri === uri ||
        (i.additionalTypes ?? []).includes(uri) ||
        (i.dataProperties ?? []).some((d) => d.propUri === uri) ||
        (i.objectProperties ?? []).some((o) => o.propUri === uri),
    )
    .map((i) => i.id);
}

export interface TBoxImpact {
  /** the ontology-level check (structure, reasoning, regressions) */
  ontology: ValidationReport;
  /** A-Box findings the change introduces / resolves with the current individuals */
  introduced: ValidationIssue[];
  resolved: ValidationIssue[];
  /** individuals with a new finding */
  affected: string[];
  /** no ontology error and no new A-Box error */
  ok: boolean;
}

/**
 * Check a changed module against the base ontology and the current A-Box.
 * `intended` lists terms the person deliberately removes or renames: the
 * ontology check reports every removal as an error, which is right for a
 * free-form Turtle edit but not for an explicit delete. What the removal does
 * to individuals is still checked.
 */
export function tboxImpact(baseModules: OntoModule[], changed: OntoModule, abox: ABoxResult | null, baseIri?: string, opts: { intended?: string[] } = {}): TBoxImpact {
  const checked = validateOntology(baseModules, changed);
  const intended = new Set(opts.intended ?? []);
  const issues = checked.issues.filter((i) => !(i.code === "removed-term" && i.subject && intended.has(i.subject)));
  const ontology: ValidationReport = { ...checked, issues, ok: !issues.some((i) => i.severity === "error") };
  const isEdit = baseModules.some((m) => m.id === changed.id);
  const after = isEdit ? baseModules.map((m) => (m.id === changed.id ? changed : m)) : [...baseModules, changed];
  const before = mergedTBox(baseModules, baseIri);
  const next = mergedTBox(after, baseIri);
  let introduced: ValidationIssue[] = [];
  let resolved: ValidationIssue[] = [];
  if (abox?.individuals.length && next) {
    const d = diffIssues(before ? validateABox(abox, before, baseIri) : [], validateABox(abox, next, baseIri));
    introduced = d.introduced;
    resolved = d.resolved;
  }
  const affected = [...new Set(introduced.map((i) => i.id).filter((x): x is string => !!x))];
  return { ontology, introduced, resolved, affected, ok: ontology.ok && !introduced.some((i) => i.severity === "error") };
}
