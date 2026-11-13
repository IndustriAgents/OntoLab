import { Parser, Store, type Quad, type Term, type NamedNode, type BlankNode } from "n3";
import type { TBoxModel, TBoxClass, TBoxProperty, TBoxRestriction, PropertyCharacteristic } from "../../types/tbox";
import { RDF, RDFS, OWL, XSD, localName, namespaceOf, isStandardTerm, defaultAboxNamespace, isXsdDatatype } from "./iri";

const TYPE = RDF + "type";
const LABEL = RDFS + "label";
const COMMENT = RDFS + "comment";
const DOMAIN = RDFS + "domain";
const RANGE = RDFS + "range";
const SUBCLASS = RDFS + "subClassOf";
const SUBPROP = RDFS + "subPropertyOf";
const RDF_PROPERTY = RDF + "Property";

const CLASS_TYPES = new Set([OWL + "Class", RDFS + "Class"]);
const OBJ_PROP = OWL + "ObjectProperty";
const DATA_PROP = OWL + "DatatypeProperty";
const ANNOTATION_PROP = OWL + "AnnotationProperty";
const FUNCTIONAL = OWL + "FunctionalProperty";
const ONTOLOGY = OWL + "Ontology";
const IMPORTS = OWL + "imports";
const INVERSE_OF = OWL + "inverseOf";
const DISJOINT_WITH = OWL + "disjointWith";
const ALL_DISJOINT = OWL + "AllDisjointClasses";
const MEMBERS = OWL + "members";
const EQUIVALENT_CLASS = OWL + "equivalentClass";
const UNION_OF = OWL + "unionOf";
const INTERSECTION_OF = OWL + "intersectionOf";
const RESTRICTION = OWL + "Restriction";
const ON_PROPERTY = OWL + "onProperty";
const ON_CLASS = OWL + "onClass";
const ON_DATARANGE = OWL + "onDataRange";
const ON_DATATYPE = OWL + "onDatatype";
const SOME = OWL + "someValuesFrom";
const ALL = OWL + "allValuesFrom";
const MIN_CARD = OWL + "minCardinality";
const MAX_CARD = OWL + "maxCardinality";
const CARD = OWL + "cardinality";
const MIN_QCARD = OWL + "minQualifiedCardinality";
const MAX_QCARD = OWL + "maxQualifiedCardinality";
const QCARD = OWL + "qualifiedCardinality";
const EQUIVALENT_PROP = OWL + "equivalentProperty";
const PROP_DISJOINT = OWL + "propertyDisjointWith";
const CHARACTERISTICS: Record<string, PropertyCharacteristic> = {
  [OWL + "TransitiveProperty"]: "transitive",
  [OWL + "SymmetricProperty"]: "symmetric",
  [OWL + "AsymmetricProperty"]: "asymmetric",
  [OWL + "ReflexiveProperty"]: "reflexive",
  [OWL + "IrreflexiveProperty"]: "irreflexive",
  [OWL + "InverseFunctionalProperty"]: "inverseFunctional",
};

type Subject = NamedNode | BlankNode;

/** Pick the best label/comment: an English one, else an untagged one, else the first. */
function pickText(literals: { value: string; lang: string }[]): string | undefined {
  if (!literals.length) return undefined;
  return (
    literals.find((l) => /^en(-|$)/i.test(l.lang))?.value ??
    literals.find((l) => !l.lang)?.value ??
    literals[0].value
  );
}

/**
 * Parse a Turtle/OWL T-Box into the typed model that drives extraction.
 *
 * Reads: named classes (owl:Class / rdfs:Class / subjects of rdfs:subClassOf /
 * named owl:equivalentClass), object and datatype properties (owl:*Property and
 * plain rdf:Property, classified by range), rdfs:domain / rdfs:range (with
 * owl:unionOf flattened into alternatives), rdfs:subClassOf / rdfs:subPropertyOf,
 * owl:FunctionalProperty, owl:inverseOf, owl:disjointWith / owl:AllDisjointClasses,
 * owl:Restrictions attached to classes, language-aware rdfs:label / rdfs:comment,
 * declared prefixes and the owl:Ontology header.
 *
 * Anonymous class expressions never leak as classes: blank-node subjects are
 * only followed, never declared.
 * `reasoning` retains only supported named expressions and asserted domains /
 * ranges. Extraction's flattened union alternatives must not become axioms.
 */
export function parseTBox(text: string, baseIriOverride?: string, opts: { reasoning?: boolean } = {}): TBoxModel {
  const prefixMap: Record<string, string> = {};
  let quads: Quad[];
  try {
    // Synchronous array form (no quad callback); the prefix callback still fires.
    quads = new Parser().parse(text, null, (prefix: string, iri: { value: string }) => {
      prefixMap[prefix] = iri.value;
    });
  } catch (e) {
    throw new Error(`T-Box parse error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const store = new Store(quads);
  const lists = store.extractLists({ ignoreErrors: true }) as Record<string, Term[]>;
  const objects = (s: Subject, p: string): Term[] => store.getObjects(s, p, null);
  const firstObj = (s: Subject, p: string): Term | undefined => objects(s, p)[0];
  const listItems = (head: Term | undefined): Term[] => (head && head.termType === "BlankNode" ? lists[head.value] ?? [] : []);

  /**
   * Expand a class/datatype expression to the named URIs it accepts:
   * a NamedNode is itself; owl:unionOf flattens (any member satisfies);
   * intersections, enumerations and restrictions are opaque here → [].
   */
  const expand = (t: Term | undefined, seen = new Set<string>()): string[] => {
    if (!t) return [];
    if (t.termType === "NamedNode") return [t.value];
    // The extraction model accepts flattened alternatives. They are NOT
    // separate OWL domain/range axioms. The rule engine cannot interpret
    // anonymous expressions, so omit them rather than strengthen their meaning.
    if (opts.reasoning) return [];
    if (t.termType !== "BlankNode" || seen.has(t.value)) return [];
    seen.add(t.value);
    const union = firstObj(t, UNION_OF);
    if (union) return [...new Set(listItems(union).flatMap((m) => expand(m, seen)))];
    // owl:Datatype with owl:onDatatype + owl:withRestrictions → the base datatype
    const onDt = firstObj(t, ON_DATATYPE);
    if (onDt?.termType === "NamedNode") return [onDt.value];
    return [];
  };

  const typeOf = new Map<string, Set<string>>();
  const labels = new Map<string, { value: string; lang: string }[]>();
  const comments = new Map<string, { value: string; lang: string }[]>();
  const domainOf = new Map<string, string[]>();
  const rangeOf = new Map<string, string[]>();
  const subclassOf = new Map<string, string[]>();
  const subPropOf = new Map<string, string[]>();
  const inverseOf = new Map<string, string>();
  const disjoint = new Map<string, Set<string>>();
  const equivClass = new Map<string, Set<string>>();
  const equivProp = new Map<string, Set<string>>();
  const propDisjoint = new Map<string, Set<string>>();
  const classSubjects = new Set<string>();
  const restrictions: TBoxRestriction[] = [];
  let ontologyIri: string | undefined;
  const imports: string[] = [];

  const push = (m: Map<string, string[]>, k: string, ...vs: string[]) => {
    const arr = m.get(k) ?? [];
    for (const v of vs) if (!arr.includes(v)) arr.push(v);
    m.set(k, arr);
  };
  const pushText = (m: Map<string, { value: string; lang: string }[]>, k: string, o: Term) => {
    if (o.termType !== "Literal") return;
    const arr = m.get(k) ?? [];
    arr.push({ value: o.value, lang: o.language ?? "" });
    m.set(k, arr);
  };
  const addSymmetric = (m: Map<string, Set<string>>, a: string, b: string) => {
    if (a === b) return;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const set = m.get(x) ?? new Set<string>();
      set.add(y);
      m.set(x, set);
    }
  };
  const addDisjoint = (a: string, b: string) => addSymmetric(disjoint, a, b);

  const readRestriction = (onClass: string, bn: BlankNode) => {
    const prop = firstObj(bn, ON_PROPERTY);
    if (prop?.termType !== "NamedNode") return;
    const qualifier = firstObj(bn, ON_CLASS) ?? firstObj(bn, ON_DATARANGE);
    const qValue = qualifier ? expand(qualifier)[0] : undefined;
    // Dropping a complex qualifier would turn a qualified maximum into an
    // unqualified maximum, introducing false contradictions.
    if (opts.reasoning && qualifier && !qValue) return;
    const num = (p: string): number | undefined => {
      const t = firstObj(bn, p);
      if (t?.termType !== "Literal") return undefined;
      const n = Number(t.value);
      return Number.isFinite(n) ? n : undefined;
    };
    const base = { onClass, onProperty: prop.value };
    const some = expand(firstObj(bn, SOME))[0];
    const all = expand(firstObj(bn, ALL))[0];
    if (some) restrictions.push({ ...base, kind: "someValuesFrom", value: some });
    if (all) restrictions.push({ ...base, kind: "allValuesFrom", value: all });
    const min = num(MIN_CARD) ?? num(MIN_QCARD);
    const max = num(MAX_CARD) ?? num(MAX_QCARD);
    const exact = num(CARD) ?? num(QCARD);
    if (min != null) restrictions.push({ ...base, kind: "minCardinality", n: min, value: qValue });
    if (max != null) restrictions.push({ ...base, kind: "maxCardinality", n: max, value: qValue });
    if (exact != null) restrictions.push({ ...base, kind: "cardinality", n: exact, value: qValue });
  };

  // Blank-node subjects are only followed via expand()/readRestriction(); the
  // few blank-node-rooted axioms we care about (AllDisjointClasses) are handled below.
  for (const q of quads) {
    const p = q.predicate.value;
    const o = q.object;
    if (q.subject.termType === "BlankNode") {
      if (p === TYPE && o.value === ALL_DISJOINT) {
        const members = listItems(firstObj(q.subject, MEMBERS)).flatMap((m) => expand(m));
        for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) addDisjoint(members[i], members[j]);
      }
      continue;
    }
    const s = q.subject.value;
    if (p === TYPE) {
      const set = typeOf.get(s) ?? new Set<string>();
      set.add(o.value);
      typeOf.set(s, set);
      if (o.value === ONTOLOGY) ontologyIri = ontologyIri ?? s;
    } else if (p === LABEL) {
      pushText(labels, s, o);
    } else if (p === COMMENT) {
      pushText(comments, s, o);
    } else if (p === DOMAIN) {
      push(domainOf, s, ...expand(o));
    } else if (p === RANGE) {
      push(rangeOf, s, ...expand(o));
    } else if (p === SUBCLASS) {
      classSubjects.add(s);
      if (o.termType === "NamedNode") {
        push(subclassOf, s, o.value);
        if (!isStandardTerm(o.value)) classSubjects.add(o.value);
      } else if (o.termType === "BlankNode") {
        const isRestriction = objects(o, TYPE).some((t) => t.value === RESTRICTION) || !!firstObj(o, ON_PROPERTY);
        if (isRestriction) readRestriction(s, o);
        else {
          // subClassOf (A and B) → both are named parents; subClassOf (A or B) is not expressible → skip
          const inter = firstObj(o, INTERSECTION_OF);
          for (const m of listItems(inter)) {
            if (m.termType === "NamedNode") push(subclassOf, s, m.value);
            else if (m.termType === "BlankNode" && firstObj(m, ON_PROPERTY)) readRestriction(s, m);
          }
        }
      }
    } else if (p === EQUIVALENT_CLASS) {
      classSubjects.add(s);
      // An equivalence to a term in ANOTHER namespace (schema.org, FIBO, a
      // reused LOV term) is a mapping, not a local class: it only becomes one
      // when that term is declared here too.
      if (o.termType === "NamedNode" && !isStandardTerm(o.value)) {
        addSymmetric(equivClass, s, o.value);
        if (namespaceOf(o.value) === namespaceOf(s)) classSubjects.add(o.value);
      } else if (o.termType === "BlankNode" && firstObj(o, ON_PROPERTY)) readRestriction(s, o);
    } else if (p === EQUIVALENT_PROP) {
      if (o.termType === "NamedNode" && !isStandardTerm(o.value)) addSymmetric(equivProp, s, o.value);
    } else if (p === PROP_DISJOINT) {
      if (o.termType === "NamedNode") addSymmetric(propDisjoint, s, o.value);
    } else if (p === SUBPROP) {
      if (o.termType === "NamedNode") push(subPropOf, s, o.value);
    } else if (p === INVERSE_OF) {
      if (o.termType === "NamedNode") {
        inverseOf.set(s, o.value);
        if (!inverseOf.has(o.value)) inverseOf.set(o.value, s);
      }
    } else if (p === DISJOINT_WITH) {
      if (o.termType === "NamedNode") {
        addDisjoint(s, o.value);
        // both sides of owl:disjointWith are classes (like subClassOf subjects)
        classSubjects.add(s);
        if (!isStandardTerm(o.value)) classSubjects.add(o.value);
      }
    } else if (p === IMPORTS) {
      if (o.termType === "NamedNode") imports.push(o.value);
    }
  }

  const classes: TBoxClass[] = [];
  const objectProps: TBoxProperty[] = [];
  const dataProps: TBoxProperty[] = [];
  const seenClass = new Set<string>();
  const seenProp = new Set<string>();

  const addClass = (uri: string) => {
    if (seenClass.has(uri) || isStandardTerm(uri)) return;
    seenClass.add(uri);
    const dj = disjoint.get(uri);
    const eq = equivClass.get(uri);
    classes.push({
      uri,
      label: pickText(labels.get(uri) ?? []),
      comment: pickText(comments.get(uri) ?? []),
      ...(dj?.size ? { disjointWith: [...dj].sort() } : {}),
      ...(eq?.size ? { equivalentTo: [...eq].sort() } : {}),
    });
  };
  const addProp = (uri: string, kind: "object" | "data") => {
    if (seenProp.has(uri) || isStandardTerm(uri)) return;
    seenProp.add(uri);
    const types = typeOf.get(uri);
    const prop: TBoxProperty = {
      uri,
      label: pickText(labels.get(uri) ?? []),
      comment: pickText(comments.get(uri) ?? []),
      domain: domainOf.get(uri) ?? [],
      range: rangeOf.get(uri) ?? [],
      kind,
    };
    if (types?.has(FUNCTIONAL)) prop.functional = true;
    const inv = inverseOf.get(uri);
    if (inv) prop.inverseOf = inv;
    const parents = subPropOf.get(uri);
    if (parents?.length) prop.subPropertyOf = parents;
    const chars = [...(types ?? [])].map((t) => CHARACTERISTICS[t]).filter(Boolean);
    if (chars.length) prop.characteristics = [...new Set(chars)].sort();
    const eq = equivProp.get(uri);
    if (eq?.size) prop.equivalentTo = [...eq].sort();
    const pdj = propDisjoint.get(uri);
    if (pdj?.size) prop.disjointWith = [...pdj].sort();
    (kind === "object" ? objectProps : dataProps).push(prop);
  };

  for (const [s, types] of typeOf) {
    if ([...types].some((t) => CLASS_TYPES.has(t))) addClass(s);
    if (types.has(OBJ_PROP)) addProp(s, "object");
    else if (types.has(DATA_PROP)) addProp(s, "data");
    else if (types.has(RDF_PROPERTY) && !types.has(ANNOTATION_PROP)) {
      // Plain RDFS property: classify by range (literal ranges → data property).
      const ranges = rangeOf.get(s) ?? [];
      const isData = ranges.length > 0 && ranges.every((r) => isXsdDatatype(r) || r.startsWith(XSD));
      addProp(s, isData ? "data" : "object");
    } else if (types.has(FUNCTIONAL) && !types.has(ANNOTATION_PROP)) {
      // Only declared functional — classify by range like rdf:Property.
      const ranges = rangeOf.get(s) ?? [];
      const isData = ranges.length > 0 && ranges.every((r) => isXsdDatatype(r));
      addProp(s, isData ? "data" : "object");
    } else if ([...types].some((t) => t in CHARACTERISTICS) && !types.has(ANNOTATION_PROP)) {
      // Transitive/symmetric/… only make sense for object properties.
      addProp(s, "object");
    }
  }
  // classes only declared via subClassOf / equivalentClass
  for (const s of classSubjects) addClass(s);

  // rdfs:subPropertyOf: inherit domain/range from the nearest ancestor that declares them.
  const propByUri = new Map<string, TBoxProperty>([...objectProps, ...dataProps].map((p) => [p.uri, p]));
  const inherit = (p: TBoxProperty, field: "domain" | "range") => {
    if (p[field].length) return;
    const seen = new Set<string>([p.uri]);
    const stack = [...(p.subPropertyOf ?? [])];
    while (stack.length) {
      const u = stack.pop()!;
      if (seen.has(u)) continue;
      seen.add(u);
      const parent = propByUri.get(u);
      if (!parent) continue;
      if (parent[field].length) {
        p[field] = [...parent[field]];
        return;
      }
      stack.push(...(parent.subPropertyOf ?? []));
    }
  };
  if (!opts.reasoning) {
    for (const p of propByUri.values()) {
      inherit(p, "domain");
      inherit(p, "range");
    }
  }
  // Reasoning follows subproperty axioms itself, across all modules. Keeping
  // only asserted domains/ranges also keeps explanations faithful to the file.

  // Only keep restrictions whose property is known (anything else is noise for us).
  const knownRestrictions = restrictions.filter((r) => propByUri.has(r.onProperty));

  const byLocal = (a: { uri: string }, b: { uri: string }) => localName(a.uri).localeCompare(localName(b.uri));
  classes.sort(byLocal);
  objectProps.sort(byLocal);
  dataProps.sort(byLocal);

  const tboxNamespace = prefixMap[""] || (classes[0] ? namespaceOf(classes[0].uri) : "") || (ontologyIri ? namespaceOf(ontologyIri + "#") : "");
  const baseIri = baseIriOverride || defaultAboxNamespace(tboxNamespace);

  const model: TBoxModel = {
    prefixes: prefixMap,
    baseIri,
    classes,
    objectProps,
    dataProps,
    subClassOf: Object.fromEntries(subclassOf),
  };
  if (ontologyIri) model.ontologyIri = ontologyIri;
  if (imports.length) model.imports = [...new Set(imports)];
  if (knownRestrictions.length) model.restrictions = knownRestrictions;
  return model;
}

/**
 * Merge several parsed T-Box modules into one model (union of classes, object/
 * data properties, prefixes, subClassOf edges, restrictions and the ontology
 * header). Properties sharing a URI have their domain/range unioned. Use for
 * modular ontologies (e.g. owl:imports stacks uploaded as multiple files).
 */
export function mergeTBox(models: TBoxModel[], baseIriOverride?: string): TBoxModel {
  const classMap = new Map<string, TBoxClass>();
  const objMap = new Map<string, TBoxProperty>();
  const dataMap = new Map<string, TBoxProperty>();
  const prefixes: Record<string, string> = {};
  const subClassOf: Record<string, string[]> = {};
  const restrictions: TBoxRestriction[] = [];
  const imports = new Set<string>();
  let ontologyIri: string | undefined;

  const union = <T,>(a: T[] | undefined, b: T[] | undefined): T[] | undefined => {
    if (!b?.length) return a;
    return [...new Set([...(a ?? []), ...b])].sort();
  };
  const mergeProp = (map: Map<string, TBoxProperty>, p: TBoxProperty) => {
    const ex = map.get(p.uri);
    if (!ex) {
      map.set(p.uri, {
        ...p,
        domain: [...p.domain],
        range: [...p.range],
        ...(p.subPropertyOf ? { subPropertyOf: [...p.subPropertyOf] } : {}),
        ...(p.characteristics ? { characteristics: [...p.characteristics] } : {}),
        ...(p.equivalentTo ? { equivalentTo: [...p.equivalentTo] } : {}),
        ...(p.disjointWith ? { disjointWith: [...p.disjointWith] } : {}),
      });
      return;
    }
    const chars = union(ex.characteristics, p.characteristics);
    if (chars) ex.characteristics = chars;
    const eq = union(ex.equivalentTo, p.equivalentTo);
    if (eq) ex.equivalentTo = eq;
    const dj = union(ex.disjointWith, p.disjointWith);
    if (dj) ex.disjointWith = dj;
    ex.label = ex.label ?? p.label;
    ex.comment = ex.comment ?? p.comment;
    ex.domain = [...new Set([...ex.domain, ...p.domain])];
    ex.range = [...new Set([...ex.range, ...p.range])];
    if (p.functional) ex.functional = true;
    ex.inverseOf = ex.inverseOf ?? p.inverseOf;
    if (p.subPropertyOf?.length) ex.subPropertyOf = [...new Set([...(ex.subPropertyOf ?? []), ...p.subPropertyOf])];
  };

  for (const m of models) {
    for (const c of m.classes) {
      const ex = classMap.get(c.uri);
      if (!ex)
        classMap.set(c.uri, {
          ...c,
          ...(c.disjointWith ? { disjointWith: [...c.disjointWith] } : {}),
          ...(c.equivalentTo ? { equivalentTo: [...c.equivalentTo] } : {}),
        });
      else {
        ex.label = ex.label ?? c.label;
        ex.comment = ex.comment ?? c.comment;
        const dj = union(ex.disjointWith, c.disjointWith);
        if (dj) ex.disjointWith = dj;
        const eq = union(ex.equivalentTo, c.equivalentTo);
        if (eq) ex.equivalentTo = eq;
      }
    }
    for (const p of m.objectProps) mergeProp(objMap, p);
    for (const p of m.dataProps) mergeProp(dataMap, p);
    // First module wins on a prefix clash; the losing namespace is still usable via full IRIs.
    for (const [k, v] of Object.entries(m.prefixes)) if (!(k in prefixes) && v) prefixes[k] = v;
    for (const [k, v] of Object.entries(m.subClassOf)) subClassOf[k] = [...new Set([...(subClassOf[k] ?? []), ...v])];
    for (const r of m.restrictions ?? []) restrictions.push(r);
    for (const i of m.imports ?? []) imports.add(i);
    ontologyIri = ontologyIri ?? m.ontologyIri;
  }

  const byLocal = (a: { uri: string }, b: { uri: string }) => localName(a.uri).localeCompare(localName(b.uri));
  const classes = [...classMap.values()].sort(byLocal);
  const objectProps = [...objMap.values()].sort(byLocal);
  const dataProps = [...dataMap.values()].sort(byLocal);

  const baseIri =
    baseIriOverride ||
    models.find((m) => m.baseIri)?.baseIri ||
    defaultAboxNamespace(prefixes[""] || (classes[0] ? namespaceOf(classes[0].uri) : ""));

  const model: TBoxModel = { prefixes, baseIri, classes, objectProps, dataProps, subClassOf };
  if (ontologyIri) model.ontologyIri = ontologyIri;
  if (imports.size) model.imports = [...imports];
  if (restrictions.length) model.restrictions = restrictions;
  return model;
}
