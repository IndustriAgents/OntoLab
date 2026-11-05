import { DataFactory, Writer, type Quad, type Quad_Object, type Quad_Subject } from "n3";
import type { TBoxModel } from "../../types/tbox";
import type { ABoxResult, EvidenceRef, FactReview } from "../../types/abox";
import { mintUri, normalizeBase } from "./uri";
import { RDF, RDF_TYPE, RDFS, RDFS_LABEL, RDFS_COMMENT, RDFS_LITERAL, OWL, OWL_NAMED_INDIVIDUAL, XSD, XSD_STRING, DCTERMS, PROV, normalizeDatatype } from "./iri";

const { namedNode, literal, quad, blankNode } = DataFactory;

/** W3C Web Annotation vocabulary (quote and offsets of a claim's evidence). */
export const OA = "http://www.w3.org/ns/oa#";
/** OntoLab's own provenance terms (confidence and review state of a claim). */
export const ONTOLAB = "https://w3id.org/ontolab/vocab#";

const OWL_ONTOLOGY = namedNode(OWL + "Ontology");
const OWL_IMPORTS = namedNode(OWL + "imports");
const OWL_SAME_AS = OWL + "sameAs";
/** Provenance: the supporting quote / location for an individual. */
export const SOURCE_EVIDENCE_PREDICATE = DCTERMS + "source";

export interface SerializeResult {
  turtle: string;
  /** A-Box id -> individual URI */
  idToUri: Map<string, string>;
}

export interface QuadsResult {
  quads: Quad[];
  /** A-Box id -> individual URI */
  idToUri: Map<string, string>;
}

export interface SerializeOptions {
  /** emit the owl:Ontology header (owl:imports the T-Box) — default true */
  header?: boolean;
  /** type every individual owl:NamedIndividual (OWL 2 DL) — default true */
  namedIndividuals?: boolean;
  /**
   * provenance to emit — default "source" (true):
   *   none    — the facts only
   *   source  — dcterms:source with each individual's free-text evidence
   *   reified — additionally one rdf:Statement per claim with evidence, linked by
   *             prov:wasDerivedFrom to a Web Annotation of its quote (exact text
   *             and character offsets in the document), with the run that made
   *             it (prov:wasGeneratedBy), its confidence and its review state
   */
  provenance?: boolean | "none" | "source" | "reified";
}

/** IRI of the A-Box "ontology" (the document header), derived from the base namespace. */
export function aboxOntologyIri(base: string): string {
  return normalizeBase(base).replace(/[#/]$/, "");
}

/**
 * Build the A-Box as RDF quads (no serialization), minting individual IRIs from
 * the base IRI (or using an explicit `iri`) and resolving object-property
 * targets against the same id→IRI map. Shared by `serializeABox` (Turtle output)
 * and the SHACL validator so focus nodes use exactly the same IRIs.
 *
 * Literal datatypes are normalised (xsd:decimal / "decimal" / "xsd:decimal" →
 * the XSD IRI); an omitted datatype defaults to the property's single declared
 * range so the export, the hand validator and SHACL all agree.
 */
export function serializeABoxQuads(abox: ABoxResult, tbox: TBoxModel, baseIriOverride?: string, opts: SerializeOptions = {}): QuadsResult {
  const base = normalizeBase(baseIriOverride || tbox.baseIri);
  const header = opts.header ?? true;
  const namedIndividuals = opts.namedIndividuals ?? true;
  const prov = opts.provenance === false || opts.provenance === "none" ? "none" : opts.provenance === "reified" ? "reified" : "source";
  const provenance = prov !== "none";
  const rangeOf = new Map(tbox.dataProps.map((p) => [p.uri, p.range.map((r) => normalizeDatatype(r) ?? r)]));

  const idToUri = new Map<string, string>();
  for (const ind of abox.individuals) {
    if (!idToUri.has(ind.id)) idToUri.set(ind.id, ind.iri || mintUri(base, ind.id));
  }

  const quads: Quad[] = [];
  if (header) {
    const ont = namedNode(aboxOntologyIri(base));
    quads.push(quad(ont, namedNode(RDF_TYPE), OWL_ONTOLOGY));
    if (tbox.ontologyIri && tbox.ontologyIri !== ont.value) quads.push(quad(ont, OWL_IMPORTS, namedNode(tbox.ontologyIri)));
    quads.push(quad(ont, namedNode(RDFS_COMMENT), literal("A-Box extracted with OntoLab; individuals conform to the imported T-Box.")));
  }

  const emitted = new Set<string>();
  for (const ind of abox.individuals) {
    if (emitted.has(ind.id)) continue; // duplicate ids are reported by the validator; export the first
    emitted.add(ind.id);
    const subj = namedNode(idToUri.get(ind.id)!);
    if (ind.classUri) quads.push(quad(subj, namedNode(RDF_TYPE), namedNode(ind.classUri)));
    for (const t of ind.additionalTypes ?? []) if (t && t !== ind.classUri) quads.push(quad(subj, namedNode(RDF_TYPE), namedNode(t)));
    if (namedIndividuals) quads.push(quad(subj, namedNode(RDF_TYPE), namedNode(OWL_NAMED_INDIVIDUAL)));
    if (ind.label) quads.push(quad(subj, namedNode(RDFS_LABEL), literal(ind.label)));
    if (provenance && ind.sourceEvidence?.trim()) quads.push(quad(subj, namedNode(SOURCE_EVIDENCE_PREDICATE), literal(ind.sourceEvidence.trim())));
    if (prov === "reified" && ind.classUri) reify(quads, subj, namedNode(RDF_TYPE), namedNode(ind.classUri), ind.evidence, ind.review);
    for (const iri of ind.sameAs ?? []) if (/^https?:\/\//.test(iri)) quads.push(quad(subj, namedNode(OWL_SAME_AS), namedNode(iri)));
    for (const other of ind.differentFrom ?? []) {
      const otherUri = idToUri.get(other);
      if (otherUri) quads.push(quad(subj, namedNode(OWL + "differentFrom"), namedNode(otherUri)));
    }

    for (const dp of ind.dataProperties ?? []) {
      if (!dp.propUri) continue;
      const value = dp.value ?? "";
      if (dp.lang) {
        quads.push(quad(subj, namedNode(dp.propUri), literal(value, dp.lang)));
        continue;
      }
      const ranges = rangeOf.get(dp.propUri) ?? [];
      const dt = normalizeDatatype(dp.datatype) ?? (ranges.length === 1 && ranges[0] !== RDFS_LITERAL ? ranges[0] : undefined);
      const lit = dt && dt !== XSD_STRING ? literal(value, namedNode(dt)) : literal(value);
      quads.push(quad(subj, namedNode(dp.propUri), lit));
      if (prov === "reified") reify(quads, subj, namedNode(dp.propUri), lit, dp.evidence, dp.review);
    }
    for (const op of ind.objectProperties ?? []) {
      if (!op.propUri || !op.targetId) continue;
      const targetUri = idToUri.get(op.targetId);
      if (!targetUri) continue; // dangling target: reported by the validator, never invented in the export
      quads.push(quad(subj, namedNode(op.propUri), namedNode(targetUri)));
      if (prov === "reified") reify(quads, subj, namedNode(op.propUri), namedNode(targetUri), op.evidence, op.review);
    }
  }
  return { quads, idToUri };
}

/**
 * One claim as an rdf:Statement with its provenance. Only claims with evidence
 * or a review state are reified; plain facts stay plain.
 */
function reify(quads: Quad[], s: Quad_Subject, p: ReturnType<typeof namedNode>, o: Quad_Object, evidence: EvidenceRef[] | undefined, review: FactReview | undefined): void {
  if (!evidence?.length && !review) return;
  const claim = blankNode();
  quads.push(quad(claim, namedNode(RDF_TYPE), namedNode(RDF + "Statement")));
  quads.push(quad(claim, namedNode(RDF_TYPE), namedNode(PROV + "Entity")));
  quads.push(quad(claim, namedNode(RDF + "subject"), s));
  quads.push(quad(claim, namedNode(RDF + "predicate"), p));
  quads.push(quad(claim, namedNode(RDF + "object"), o));
  if (review) {
    quads.push(quad(claim, namedNode(ONTOLAB + "reviewStatus"), literal(review.status)));
    if (review.by === "user") quads.push(quad(claim, namedNode(ONTOLAB + "reviewedBy"), literal("person")));
    if (review.runId) quads.push(quad(claim, namedNode(PROV + "wasGeneratedBy"), namedNode(`urn:ontolab:run:${encodeURIComponent(review.runId)}`)));
  }
  const confidence = review?.confidence ?? Math.max(-1, ...(evidence ?? []).map((e) => e.confidence ?? -1));
  if (confidence >= 0) quads.push(quad(claim, namedNode(ONTOLAB + "confidence"), literal(String(Math.round(confidence * 1000) / 1000), namedNode(XSD + "decimal"))));
  for (const e of evidence ?? []) {
    if (!e.quote?.trim()) continue;
    const ann = blankNode();
    quads.push(quad(claim, namedNode(PROV + "wasDerivedFrom"), ann));
    quads.push(quad(ann, namedNode(RDF_TYPE), namedNode(OA + "SpecificResource")));
    if (e.documentId) quads.push(quad(ann, namedNode(OA + "hasSource"), namedNode(`urn:ontolab:document:${encodeURIComponent(e.documentId)}`)));
    const quote = blankNode();
    quads.push(quad(ann, namedNode(OA + "hasSelector"), quote));
    quads.push(quad(quote, namedNode(RDF_TYPE), namedNode(OA + "TextQuoteSelector")));
    quads.push(quad(quote, namedNode(OA + "exact"), literal(e.quote.trim())));
    if (e.start != null && e.end != null) {
      const pos = blankNode();
      quads.push(quad(ann, namedNode(OA + "hasSelector"), pos));
      quads.push(quad(pos, namedNode(RDF_TYPE), namedNode(OA + "TextPositionSelector")));
      quads.push(quad(pos, namedNode(OA + "start"), literal(String(e.start), namedNode(XSD + "nonNegativeInteger"))));
      quads.push(quad(pos, namedNode(OA + "end"), literal(String(e.end), namedNode(XSD + "nonNegativeInteger"))));
    }
    if (e.page != null) quads.push(quad(ann, namedNode(ONTOLAB + "page"), literal(String(e.page), namedNode(XSD + "integer"))));
    quads.push(quad(ann, namedNode(ONTOLAB + "evidenceStatus"), literal(e.status)));
  }
}

/**
 * Deterministically serialize the structured A-Box to Turtle, conforming to the
 * T-Box. The A-Box namespace gets its own prefix (`:` when the T-Box does not
 * use the empty prefix, otherwise `abox:`), so T-Box terms keep their CURIEs.
 */
export function serializeABox(abox: ABoxResult, tbox: TBoxModel, baseIriOverride?: string, opts?: SerializeOptions): SerializeResult {
  const base = normalizeBase(baseIriOverride || tbox.baseIri);
  const { quads, idToUri } = serializeABoxQuads(abox, tbox, baseIriOverride, opts);

  const prefixes: Record<string, string> = {
    rdfs: RDFS,
    owl: OWL,
    xsd: XSD,
    dcterms: DCTERMS,
    ...(opts?.provenance === "reified" ? { rdf: RDF, prov: PROV, oa: OA, ontolab: ONTOLAB } : {}),
    ...tbox.prefixes,
  };
  const tboxDefault = tbox.prefixes[""];
  if (!tboxDefault || tboxDefault === base) prefixes[""] = base;
  else prefixes.abox = base;

  const writer = new Writer({ prefixes });
  writer.addQuads(quads);
  let out = "";
  let writeErr: Error | null = null;
  writer.end((err, result) => {
    if (err) writeErr = err;
    else out = result;
  });
  if (writeErr) throw new Error(`A-Box serialize error: ${(writeErr as Error).message}`);

  return { turtle: out, idToUri };
}
