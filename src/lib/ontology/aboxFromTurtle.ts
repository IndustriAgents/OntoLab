import { Parser } from "n3";
import type { ABoxResult, ABoxIndividual } from "../../types/abox";
import { RDF_TYPE, RDFS_LABEL, RDFS, OWL, OWL_NAMED_INDIVIDUAL, XSD_STRING, RDF_LANGSTRING, localName } from "./iri";
import { SOURCE_EVIDENCE_PREDICATE } from "./aboxSerializer";
import { fromLocalName } from "./uri";

/** Subjects with these types are schema / header, not individuals. */
const SCHEMA_TYPES = new Set([
  OWL + "Ontology",
  OWL + "Class",
  OWL + "ObjectProperty",
  OWL + "DatatypeProperty",
  OWL + "AnnotationProperty",
  OWL + "Restriction",
  RDFS + "Class",
  RDFS + "Datatype",
]);

/**
 * Parse (hand-edited) A-Box Turtle back into the structured model so the table,
 * graph and validation update. Each subject keeps its full IRI (`iri`), so a
 * round-trip through the editor never re-homes or re-slugs individuals; the id
 * is the decoded local name (made unique when two IRIs share one). rdf:type →
 * classUri (+ additionalTypes), rdfs:label → label, dcterms:source →
 * sourceEvidence, literal objects → data properties (datatype + language kept),
 * IRI objects → object properties. Throws on invalid Turtle.
 */
export function parseABoxTurtle(text: string): ABoxResult {
  let quads;
  try {
    quads = new Parser().parse(text);
  } catch (e) {
    throw new Error(`Turtle parse error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // First pass: which subjects are schema/header (skip) and assign unique ids.
  const schemaSubjects = new Set<string>();
  for (const q of quads) {
    if (q.subject.termType === "NamedNode" && q.predicate.value === RDF_TYPE && SCHEMA_TYPES.has(q.object.value)) schemaSubjects.add(q.subject.value);
  }
  const usedIds = new Map<string, string>(); // id -> iri
  const idOf = new Map<string, string>(); // iri -> id
  const assignId = (iri: string): string => {
    const existing = idOf.get(iri);
    if (existing) return existing;
    const baseId = fromLocalName(localName(iri)) || iri;
    let id = baseId;
    for (let n = 2; usedIds.has(id) && usedIds.get(id) !== iri; n++) id = `${baseId}-${n}`;
    usedIds.set(id, iri);
    idOf.set(iri, id);
    return id;
  };

  const map = new Map<string, ABoxIndividual>();
  const labelsOf = new Map<string, { value: string; lang: string }[]>();
  const ensure = (iri: string): ABoxIndividual => {
    let ind = map.get(iri);
    if (!ind) {
      ind = { id: assignId(iri), classUri: "", iri, dataProperties: [], objectProperties: [] };
      map.set(iri, ind);
    }
    return ind;
  };

  for (const q of quads) {
    if (q.subject.termType !== "NamedNode" || schemaSubjects.has(q.subject.value)) continue;
    const ind = ensure(q.subject.value);
    const pred = q.predicate.value;
    const o = q.object;

    if (pred === RDF_TYPE) {
      if (o.termType !== "NamedNode" || o.value === OWL_NAMED_INDIVIDUAL) continue;
      if (!ind.classUri) ind.classUri = o.value;
      else if (o.value !== ind.classUri) (ind.additionalTypes ??= []).push(o.value);
      continue;
    }
    if (pred === RDFS_LABEL && o.termType === "Literal") {
      const arr = labelsOf.get(ind.id) ?? [];
      arr.push({ value: o.value, lang: o.language ?? "" });
      labelsOf.set(ind.id, arr);
      continue;
    }
    if (pred === SOURCE_EVIDENCE_PREDICATE && o.termType === "Literal") {
      ind.sourceEvidence = ind.sourceEvidence ?? o.value;
      continue;
    }
    // Grounding links to external registries are identifiers, not individuals.
    if (pred === OWL + "sameAs" && o.termType === "NamedNode") {
      (ind.sameAs ??= []).push(o.value);
      continue;
    }
    if (o.termType === "Literal") {
      const dt = o.datatype?.value;
      ind.dataProperties!.push({
        propUri: pred,
        value: o.value,
        ...(o.language ? { lang: o.language } : {}),
        ...(dt && dt !== XSD_STRING && dt !== RDF_LANGSTRING ? { datatype: dt } : {}),
      });
    } else if (o.termType === "NamedNode") {
      if (schemaSubjects.has(o.value)) continue;
      ind.objectProperties!.push({ propUri: pred, targetId: ensure(o.value).id });
    }
    // Blank-node objects cannot be represented in the structured model and are skipped.
  }

  // Label: prefer English, then untagged, then whatever came first.
  for (const [id, labels] of labelsOf) {
    const ind = [...map.values()].find((i) => i.id === id);
    if (!ind) continue;
    ind.label = labels.find((l) => /^en(-|$)/i.test(l.lang))?.value ?? labels.find((l) => !l.lang)?.value ?? labels[0].value;
  }

  const individuals = [...map.values()].filter(
    (i) => i.classUri || (i.dataProperties?.length ?? 0) > 0 || (i.objectProperties?.length ?? 0) > 0,
  );
  return { individuals };
}
