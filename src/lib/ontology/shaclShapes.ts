import { DataFactory, type Quad, type NamedNode, type BlankNode, type Literal } from "n3";
import type { TBoxModel, TBoxProperty, TBoxRestriction } from "../../types/tbox";
import { RDF, SH, XSD, XSD_STRING, RDF_LANGSTRING, RDFS_LITERAL, normalizeDatatype, isXsdDatatype } from "./iri";

type ObjectTerm = NamedNode | BlankNode | Literal;

const { namedNode, blankNode, literal, quad } = DataFactory;

const RDF_TYPE = namedNode(RDF + "type");
const RDF_FIRST = namedNode(RDF + "first");
const RDF_REST = namedNode(RDF + "rest");
const RDF_NIL = namedNode(RDF + "nil");
const SH_NODE_SHAPE = namedNode(SH + "NodeShape");
const SH_TARGET_CLASS = namedNode(SH + "targetClass");
const SH_TARGET_SUBJECTS_OF = namedNode(SH + "targetSubjectsOf");
const SH_PROPERTY = namedNode(SH + "property");
const SH_PATH = namedNode(SH + "path");
const SH_CLASS = namedNode(SH + "class");
const SH_DATATYPE = namedNode(SH + "datatype");
const SH_NODE_KIND = namedNode(SH + "nodeKind");
const SH_IRI = namedNode(SH + "IRI");
const SH_LITERAL = namedNode(SH + "Literal");
const SH_OR = namedNode(SH + "or");
const SH_NOT = namedNode(SH + "not");
const SH_MIN_COUNT = namedNode(SH + "minCount");
const SH_MAX_COUNT = namedNode(SH + "maxCount");
const SH_QUALIFIED_VALUE_SHAPE = namedNode(SH + "qualifiedValueShape");
const SH_QUALIFIED_MIN_COUNT = namedNode(SH + "qualifiedMinCount");
const SH_SEVERITY = namedNode(SH + "severity");
const SH_WARNING = namedNode(SH + "Warning");
const SH_MESSAGE = namedNode(SH + "message");
const XSD_INTEGER = namedNode(XSD + "integer");

/** Stable IRI for the NodeShape that targets a class. */
export function classShapeIri(classUri: string): string {
  return classUri + "Shape";
}

/** Stable IRI for the NodeShape that targets subjects of a property. */
export function propertyShapeIri(propUri: string): string {
  return propUri + "SubjectShape";
}

/**
 * Induce SHACL shapes from the T-Box as RDF quads, mirroring validateABox:
 *
 * - One sh:NodeShape per class (sh:targetClass) with a sh:property for every
 *   property whose domain includes the class (subclass instances are covered
 *   because the validator materialises ancestor types before validating).
 * - Domain-less properties are attached ONCE via sh:targetSubjectsOf (not to every
 *   class), so a large standards ontology does not explode into O(classes × props)
 *   property shapes.
 * - A property with a domain also gets a sh:targetSubjectsOf shape so a subject of
 *   the wrong class is flagged (the SHACL form of the domain warning).
 * - Object props: sh:nodeKind sh:IRI + sh:class (sh:or for several ranges).
 * - Data props: sh:datatype; no range / rdfs:Literal → sh:nodeKind sh:Literal;
 *   xsd:string accepts rdf:langString too.
 * - owl:FunctionalProperty → sh:maxCount 1; owl:disjointWith → sh:not [sh:class];
 *   owl:Restrictions → sh:minCount / sh:maxCount / sh:qualifiedValueShape.
 *
 * Domain, range, datatype, cardinality and restriction constraints carry
 * sh:severity sh:Warning (flag-and-keep, like the hand validator); only
 * disjointness and node-kind mismatches are violations.
 */
export function tboxToShapes(tbox: TBoxModel): Quad[] {
  const quads: Quad[] = [];
  let counter = 0;
  const bnode = () => blankNode(`s${counter++}`);

  const list = (items: ObjectTerm[]): NamedNode | BlankNode => {
    let head: NamedNode | BlankNode = RDF_NIL;
    for (let i = items.length - 1; i >= 0; i--) {
      const cell = bnode();
      quads.push(quad(cell, RDF_FIRST, items[i]));
      quads.push(quad(cell, RDF_REST, head));
      head = cell;
    }
    return head;
  };

  const orConstraint = (subject: NamedNode | BlankNode, pred: NamedNode, values: string[]) => {
    const members = values.map((v) => {
      const m = bnode();
      quads.push(quad(m, pred, namedNode(v)));
      return m;
    });
    quads.push(quad(subject, SH_OR, list(members)));
  };

  const warn = (shape: NamedNode | BlankNode) => quads.push(quad(shape, SH_SEVERITY, SH_WARNING));

  /** Range constraints of a property, on the given property shape. */
  const rangeConstraints = (pShape: BlankNode, p: TBoxProperty) => {
    if (p.kind === "object") {
      quads.push(quad(pShape, SH_NODE_KIND, SH_IRI));
      if (p.range.length === 1) quads.push(quad(pShape, SH_CLASS, namedNode(p.range[0])));
      else if (p.range.length > 1) orConstraint(pShape, SH_CLASS, p.range);
      return;
    }
    const ranges = p.range.map((r) => normalizeDatatype(r) ?? r);
    if (!ranges.length || ranges.includes(RDFS_LITERAL)) {
      quads.push(quad(pShape, SH_NODE_KIND, SH_LITERAL));
      return;
    }
    const members = [...new Set(ranges.flatMap((r) => (r === XSD_STRING ? [XSD_STRING, RDF_LANGSTRING] : [r])))];
    if (members.length === 1) quads.push(quad(pShape, SH_DATATYPE, namedNode(members[0])));
    else orConstraint(pShape, SH_DATATYPE, members);
  };

  const propertyShape = (owner: NamedNode, p: TBoxProperty): BlankNode => {
    const pShape = bnode();
    quads.push(quad(owner, SH_PROPERTY, pShape));
    quads.push(quad(pShape, SH_PATH, namedNode(p.uri)));
    rangeConstraints(pShape, p);
    if (p.functional) quads.push(quad(pShape, SH_MAX_COUNT, literal("1", XSD_INTEGER)));
    warn(pShape);
    return pShape;
  };

  const allProps: TBoxProperty[] = [...tbox.objectProps, ...tbox.dataProps];
  const propByUri = new Map(allProps.map((p) => [p.uri, p]));
  const restrictionsByClass = new Map<string, TBoxRestriction[]>();
  for (const r of tbox.restrictions ?? []) {
    const arr = restrictionsByClass.get(r.onClass) ?? [];
    arr.push(r);
    restrictionsByClass.set(r.onClass, arr);
  }

  // ── One NodeShape per class ──
  for (const c of tbox.classes) {
    const shape = namedNode(classShapeIri(c.uri));
    quads.push(quad(shape, RDF_TYPE, SH_NODE_SHAPE));
    quads.push(quad(shape, SH_TARGET_CLASS, namedNode(c.uri)));

    for (const p of allProps) if (p.domain.includes(c.uri)) propertyShape(shape, p);

    for (const d of c.disjointWith ?? []) {
      const not = bnode();
      quads.push(quad(shape, SH_NOT, not));
      quads.push(quad(not, SH_CLASS, namedNode(d)));
      quads.push(quad(shape, SH_MESSAGE, literal(`${c.uri} is disjoint with ${d}`)));
    }

    for (const r of restrictionsByClass.get(c.uri) ?? []) {
      const p = propByUri.get(r.onProperty);
      if (!p) continue;
      const pShape = bnode();
      quads.push(quad(shape, SH_PROPERTY, pShape));
      quads.push(quad(pShape, SH_PATH, namedNode(r.onProperty)));
      const filler = (v: string | undefined, target: BlankNode) => {
        if (!v) return;
        if (isXsdDatatype(v)) quads.push(quad(target, SH_DATATYPE, namedNode(v)));
        else quads.push(quad(target, SH_CLASS, namedNode(v)));
      };
      switch (r.kind) {
        case "someValuesFrom": {
          const q = bnode();
          quads.push(quad(pShape, SH_QUALIFIED_VALUE_SHAPE, q));
          filler(r.value, q);
          quads.push(quad(pShape, SH_QUALIFIED_MIN_COUNT, literal("1", XSD_INTEGER)));
          break;
        }
        case "allValuesFrom":
          filler(r.value, pShape);
          break;
        case "minCardinality":
          if (r.n != null) quads.push(quad(pShape, SH_MIN_COUNT, literal(String(r.n), XSD_INTEGER)));
          break;
        case "maxCardinality":
          if (r.n != null) quads.push(quad(pShape, SH_MAX_COUNT, literal(String(r.n), XSD_INTEGER)));
          break;
        case "cardinality":
          if (r.n != null) {
            quads.push(quad(pShape, SH_MIN_COUNT, literal(String(r.n), XSD_INTEGER)));
            quads.push(quad(pShape, SH_MAX_COUNT, literal(String(r.n), XSD_INTEGER)));
          }
          break;
      }
      warn(pShape);
    }
  }

  // ── Per-property subject shapes ──
  for (const p of allProps) {
    const shape = namedNode(propertyShapeIri(p.uri));
    quads.push(quad(shape, RDF_TYPE, SH_NODE_SHAPE));
    quads.push(quad(shape, SH_TARGET_SUBJECTS_OF, namedNode(p.uri)));
    if (p.domain.length) {
      // subjects must be of the domain class
      if (p.domain.length === 1) quads.push(quad(shape, SH_CLASS, namedNode(p.domain[0])));
      else orConstraint(shape, SH_CLASS, p.domain);
      quads.push(quad(shape, SH_MESSAGE, literal(`subject of ${p.uri} must be a ${p.domain.join(" or ")}`)));
      warn(shape);
    } else {
      // domain-less: attach the range constraints once here instead of to every class
      propertyShape(shape, p);
    }
  }

  return quads;
}
